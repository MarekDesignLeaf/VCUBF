import { Router } from "express"; import { requireAuth } from "../../middleware/auth.js"; import { requirePermission } from "../../middleware/permissions.js"; import * as s from "../../services/invoiceService.js";
export const invoicesRouter=Router(); invoicesRouter.use(requireAuth);
invoicesRouter.get("/",requirePermission("crm.read"),async(req,res)=>res.json(await s.listInvoices(req.user!)));
invoicesRouter.get("/:id",requirePermission("crm.read"),async(req,res)=>{const x=await s.getInvoice(req.user!,req.params.id);if(!x)return res.status(404).json({error:"INVOICE_NOT_FOUND"});res.json(x)});
invoicesRouter.post("/",requirePermission("crm.manage"),async(req,res)=>{const x=await s.createInvoice(req.user!,req.body);if(!x.ok)return res.status(x.httpStatus).json({error:x.error,message:x.message});res.status(x.httpStatus).json(x.data)});
invoicesRouter.put("/:id/status",requirePermission("crm.manage"),async(req,res)=>{const x=await s.changeInvoiceStatus(req.user!,req.params.id,req.body);if(!x.ok)return res.status(x.httpStatus).json({error:x.error,message:x.message});res.json(x.data)});
invoicesRouter.post("/:id/payments",requirePermission("crm.manage"),async(req,res)=>{const x=await s.addPayment(req.user!,req.params.id,req.body);if(!x.ok)return res.status(x.httpStatus).json({error:x.error,message:x.message});res.status(x.httpStatus).json(x.data)});
