import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { recordAudit } from "../lib/audit.js";
import { moneyLinesFit, nonnegativeMoney, positiveMoney } from "../lib/money.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { RECORD_INVOICE_PAYMENT_ACTION } from "../lib/actionContracts.js";
import { assertNotInSafeModeLocked } from "../lib/safeMode.js";

const item = z.object({ description: z.string().min(1), quantity: z.number().positive().default(1), unit_price: nonnegativeMoney });
const createSchema = z.object({ client_id: z.string().uuid(), invoice_number: z.string().min(1), title: z.string().min(1), issue_date: z.string().datetime().optional(), due_date: z.string().datetime().optional(), notes: z.string().optional(), items: z.array(item).min(1) }).refine(d=>moneyLinesFit(d.items.map(i=>({quantity:i.quantity,unitAmount:i.unit_price}))),{message:"invoice total exceeds the supported money range",path:["items"]});
const paymentSchema = z.object({ amount: positiveMoney, paid_at: z.string().datetime(), method: z.string().optional(), reference: z.string().optional(), confirmed:z.boolean().optional() });
/**
 * The revision of an invoice is its updatedAt. Every change to the document
 * moves it: its own fields, its lines (updateInvoice) and its payments
 * (addPayment), always under the invoice's row lock.
 *
 * expected_revision (optional): the invoice's updatedAt as the caller last saw
 * it. With it, the change is made only if the invoice has not changed since —
 * a caller that showed the document for approval (the MCP gateway's preview)
 * never issues or voids a different one.
 */
const statusSchema = z.object({ invoice_status: z.enum(["draft", "issued", "void"]), expected_revision: z.string().datetime().optional() });
class InvoiceNotEditable extends Error {}
/**
 * What may be corrected on a draft.
 *
 * `items` replaces the whole list rather than patching individual lines: an invoice
 * is one document, and a half-applied line edit is a worse state than either the
 * old or the new version. `client_id` is absent — an invoice addressed to the wrong
 * client is a different invoice, not a corrected one.
 */
const updateSchema = z.object({
  invoice_number: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  issue_date: z.string().datetime().nullable().optional(),
  due_date: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
  items: z.array(item).min(1).optional(),
}).refine(
  (d) => !d.items || moneyLinesFit(d.items.map((i) => ({ quantity: i.quantity, unitAmount: i.unit_price }))),
  { message: "invoice total exceeds the supported money range", path: ["items"] },
).refine((d) => Object.keys(d).length > 0, "At least one field is required");
/** The draft invoice as created and as corrected; exported so other entry points (the MCP gateway) validate with exactly these. */
export const createInvoiceSchema = createSchema;
export const updateInvoiceSchema = updateSchema;
const include = { client: { select: { id: true, displayName: true } }, items: { orderBy: { sortOrder: "asc" as const } }, payments: { orderBy: { paidAt: "asc" as const } } };
type MoneyValue=number|{toNumber():number};const n=(v:MoneyValue)=>typeof v==="number"?v:v.toNumber();
const moneyRound=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
function totals<T extends { items: { quantity:number;unitPrice:MoneyValue }[];payments:{amount:MoneyValue}[];dueDate:Date|null;invoiceStatus:string }>(x:T){const total=moneyRound(x.items.reduce((s,i)=>s+i.quantity*n(i.unitPrice),0)),paid=moneyRound(x.payments.reduce((s,p)=>s+n(p.amount),0)),balance=moneyRound(Math.max(0,total-paid));return {...x,items:x.items.map(i=>({...i,unitPrice:n(i.unitPrice)})),payments:x.payments.map(p=>({...p,amount:n(p.amount)})),totals:{total,paid,balance},isOverdue:x.invoiceStatus==="issued"&&balance>0&&!!x.dueDate&&x.dueDate<new Date()};}
export async function listInvoices(u:AuthedUser){return (await prisma.invoice.findMany({where:{companyId:u.companyId},include,orderBy:{createdAt:"desc"}})).map(totals);}
export async function getInvoice(u:AuthedUser,id:string){const x=await prisma.invoice.findFirst({where:{id,companyId:u.companyId},include});return x?totals(x):null;}
export async function createInvoice(u:AuthedUser,raw:unknown):Promise<ServiceResult<unknown>>{const p=createSchema.safeParse(raw);if(!p.success)return fail(400,"VALIDATION_FAILED",p.error.message);const d=p.data;if(!await prisma.client.findFirst({where:{id:d.client_id,companyId:u.companyId}}))return fail(404,"CLIENT_NOT_FOUND");if(await prisma.invoice.findUnique({where:{companyId_invoiceNumber:{companyId:u.companyId,invoiceNumber:d.invoice_number}}}))return fail(409,"INVOICE_NUMBER_EXISTS");const x=await prisma.invoice.create({data:{companyId:u.companyId,clientId:d.client_id,invoiceNumber:d.invoice_number,title:d.title,issueDate:d.issue_date?new Date(d.issue_date):undefined,dueDate:d.due_date?new Date(d.due_date):undefined,notes:d.notes,createdBy:u.id,items:{create:d.items.map((i,n)=>({companyId:u.companyId,description:i.description,quantity:i.quantity,unitPrice:i.unit_price,sortOrder:n}))}},include});await recordAudit({companyId:u.companyId,userId:u.id,actionName:"create_invoice",inputPayload:d,dataAfter:x,riskLevel:2,confirmationRequired:false,result:"success"});return ok(201,totals(x));}
/**
 * Correcting a draft invoice.
 *
 * Only a draft can be changed. Once an invoice is issued, the client has a copy of
 * it; editing the amount behind that copy would leave two documents sharing one
 * invoice number, and the wrong one in someone else's records. The way to correct
 * an issued invoice is to void it and issue another, which changeInvoiceStatus
 * already allows.
 */
export async function updateInvoice(u:AuthedUser,id:string,raw:unknown):Promise<ServiceResult<unknown>>{
  const p=updateSchema.safeParse(raw);
  if(!p.success)return fail(400,"VALIDATION_FAILED",p.error.message);
  const d=p.data;
  const old=await prisma.invoice.findFirst({where:{id,companyId:u.companyId},include});
  if(!old)return fail(404,"INVOICE_NOT_FOUND");
  if(old.invoiceStatus!=="draft"){
    await recordAudit({companyId:u.companyId,userId:u.id,actionName:"update_invoice",inputPayload:{id,...d},dataBefore:old,riskLevel:2,confirmationRequired:false,result:"error",errorMessage:"INVOICE_NOT_EDITABLE"});
    return fail(409,"INVOICE_NOT_EDITABLE","Only a draft invoice can be edited. Void this one and issue a replacement.");
  }
  if(d.invoice_number&&d.invoice_number!==old.invoiceNumber){
    const clash=await prisma.invoice.findUnique({where:{companyId_invoiceNumber:{companyId:u.companyId,invoiceNumber:d.invoice_number}}});
    if(clash)return fail(409,"INVOICE_NUMBER_EXISTS");
  }
  let x;
  try{x=await prisma.$transaction(async(tx)=>{
    // The status is checked again under the row lock that a status change also
    // takes: an invoice issued meanwhile is not edited after the fact.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM invoices WHERE id = ${id} AND company_id = ${u.companyId} FOR UPDATE`);
    const current=await tx.invoice.findFirst({where:{id,companyId:u.companyId},select:{invoiceStatus:true}});
    if(current?.invoiceStatus!=="draft")throw new InvoiceNotEditable();
    if(d.items){
      // Replaced wholesale so the stored order matches what was submitted; leaving
      // old lines behind would silently add them to the total.
      await tx.invoiceItem.deleteMany({where:{invoiceId:id}});
      await tx.invoiceItem.createMany({data:d.items.map((i,n)=>({companyId:u.companyId,invoiceId:id,description:i.description,quantity:i.quantity,unitPrice:i.unit_price,sortOrder:n}))});
    }
    return tx.invoice.update({where:{id},data:{
      ...(d.invoice_number!==undefined?{invoiceNumber:d.invoice_number}:{}),
      ...(d.title!==undefined?{title:d.title}:{}),
      ...(d.issue_date!==undefined?{issueDate:d.issue_date?new Date(d.issue_date):null}:{}),
      ...(d.due_date!==undefined?{dueDate:d.due_date?new Date(d.due_date):null}:{}),
      ...(d.notes!==undefined?{notes:d.notes}:{}),
      // Set explicitly so that a change of the lines alone also moves the revision.
      updatedAt:new Date(),
    },include});
  });}catch(error){
    if(!(error instanceof InvoiceNotEditable))throw error;
    return fail(409,"INVOICE_NOT_EDITABLE","Only a draft invoice can be edited. Void this one and issue a replacement.");
  }
  await recordAudit({companyId:u.companyId,userId:u.id,actionName:"update_invoice",inputPayload:{id,...d},dataBefore:totals(old),dataAfter:totals(x),riskLevel:2,confirmationRequired:false,result:"success"});
  return ok(200,totals(x));
}
export async function changeInvoiceStatus(u:AuthedUser,id:string,raw:unknown,options:{safeModeLocked?:boolean}={}):Promise<ServiceResult<unknown>>{
  const p=statusSchema.safeParse(raw);if(!p.success)return fail(400,"VALIDATION_FAILED");
  const {invoice_status:target,expected_revision:expected}=p.data;
  // Under a row lock, so the revision compared is the one changed: nothing can
  // edit the invoice between the comparison and the status change.
  const r=await prisma.$transaction(async(tx)=>{
    // With safeModeLocked the emergency stop is checked in this transaction, serialised with the switch.
    if(options.safeModeLocked)await assertNotInSafeModeLocked(tx,u.companyId);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM invoices WHERE id = ${id} AND company_id = ${u.companyId} FOR UPDATE`);
    const old=await tx.invoice.findFirst({where:{id,companyId:u.companyId}});if(!old)return {error:"INVOICE_NOT_FOUND" as const};
    if(expected&&old.updatedAt.toISOString()!==expected)return {error:"INVOICE_CHANGED" as const};
    const allowed=(old.invoiceStatus==="draft"&&(target==="issued"||target==="void"))||(old.invoiceStatus==="issued"&&target==="void")||old.invoiceStatus===target;
    if(!allowed)return {error:"INVALID_INVOICE_STATUS_TRANSITION" as const};
    const x=await tx.invoice.update({where:{id},data:{invoiceStatus:target,issueDate:target==="issued"?(old.issueDate??new Date()):old.issueDate},include});
    return {old,x};
  });
  if(!r.x||!r.old){
    if(r.error==="INVOICE_NOT_FOUND")return fail(404,r.error);
    if(r.error==="INVOICE_CHANGED")return fail(409,r.error,"The invoice changed after it was shown. Review it again.");
    return fail(409,r.error??"INVALID_INVOICE_STATUS_TRANSITION");
  }
  await recordAudit({companyId:u.companyId,userId:u.id,actionName:"change_invoice_status",inputPayload:{id,...p.data},dataBefore:r.old,dataAfter:r.x,riskLevel:2,confirmationRequired:false,result:"success"});return ok(200,totals(r.x));
}
export async function addPayment(u:AuthedUser,id:string,raw:unknown):Promise<ServiceResult<unknown>>{
  const p=paymentSchema.safeParse(raw);if(!p.success)return fail(400,"VALIDATION_FAILED",p.error.message);
  const inv=await getInvoice(u,id);if(!inv)return fail(404,"INVOICE_NOT_FOUND");
  if(inv.invoiceStatus!=="issued")return fail(409,"INVOICE_NOT_PAYABLE");
  if(p.data.amount>inv.totals.balance)return fail(409,"PAYMENT_EXCEEDS_BALANCE");
  const input={invoiceId:id,amount:p.data.amount,paid_at:p.data.paid_at,method:p.data.method,reference:p.data.reference};
  const preview={invoiceId:id,invoiceNumber:inv.invoiceNumber,client:inv.client.displayName,amount:p.data.amount,balanceBefore:inv.totals.balance,balanceAfter:moneyRound(inv.totals.balance-p.data.amount),willMarkPaid:inv.totals.balance===p.data.amount};
  if(!p.data.confirmed){await recordAudit({companyId:u.companyId,userId:u.id,actionName:RECORD_INVOICE_PAYMENT_ACTION.actionName,inputPayload:input,dataBefore:{balance:inv.totals.balance},riskLevel:RECORD_INVOICE_PAYMENT_ACTION.riskLevel,confirmationRequired:true,result:"rejected",errorMessage:"CONFIRMATION_REQUIRED"});return fail(409,"CONFIRMATION_REQUIRED","Review the payment preview and confirm.",{preview})}
  const result=await prisma.$transaction(async(tx)=>{
    await tx.$queryRaw(Prisma.sql`SELECT id FROM invoices WHERE id = ${id} AND company_id = ${u.companyId} FOR UPDATE`);
    const current=await tx.invoice.findFirst({where:{id,companyId:u.companyId},include});if(!current)return {error:"INVOICE_NOT_FOUND" as const};
    const before=totals(current);if(before.invoiceStatus!=="issued")return {error:"INVOICE_NOT_PAYABLE" as const};
    if(p.data.amount>before.totals.balance)return {error:"PAYMENT_EXCEEDS_BALANCE" as const};
    await tx.payment.create({data:{companyId:u.companyId,invoiceId:id,amount:p.data.amount,paidAt:new Date(p.data.paid_at),method:p.data.method,reference:p.data.reference}});
    const refreshed=await tx.invoice.findUniqueOrThrow({where:{id},include});const after=totals(refreshed);
    // Every payment moves the invoice's revision, partial ones included: a
    // caller holding an older revision (an approved void) must not act on an
    // invoice whose payments and balance have changed since.
    if(after.totals.balance===0){const paid=await tx.invoice.update({where:{id},data:{invoiceStatus:"paid",updatedAt:new Date()},include});return {before,after:totals(paid)}}
    const touched=await tx.invoice.update({where:{id},data:{updatedAt:new Date()},include});
    return {before,after:totals(touched)};
  });
  if("error" in result&&result.error)return fail(result.error==="INVOICE_NOT_FOUND"?404:409,result.error);
  await recordAudit({companyId:u.companyId,userId:u.id,actionName:RECORD_INVOICE_PAYMENT_ACTION.actionName,inputPayload:input,dataBefore:{balance:result.before.totals.balance},dataAfter:{balance:result.after.totals.balance},riskLevel:RECORD_INVOICE_PAYMENT_ACTION.riskLevel,confirmationRequired:true,confirmed:true,result:"success"});return ok(201,result.after);
}
