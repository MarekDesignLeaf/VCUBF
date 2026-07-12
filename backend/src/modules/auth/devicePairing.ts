import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../db.js";
import { recordAudit } from "../../lib/audit.js";
import { APPROVE_DEVICE_PAIRING_ACTION } from "../../lib/actionContracts.js";
import { requireAuth, signToken } from "../../middleware/auth.js";

export const devicePairingRouter = Router();
const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const secretHash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const codeSchema = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{8}$/) });
const tokenSchema = z.object({ pairing_id: z.string().uuid(), secret: z.string().min(40).max(200) });

function publicUser(user: { id:string;companyId:string;email:string;displayName:string;role:string;permissions:string[];mustChangePassword:boolean;voiceWakeWord:string;voiceContinuous:boolean;voiceLanguage:string }) {
  return { id:user.id,email:user.email,displayName:user.displayName,role:user.role,permissions:user.permissions,mustChangePassword:user.mustChangePassword,voiceWakeWord:user.voiceWakeWord,voiceContinuous:user.voiceContinuous,voiceLanguage:user.voiceLanguage };
}

devicePairingRouter.post("/start", limiter, async (_req, res) => {
  const secret = randomBytes(32).toString("base64url");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt=0; attempt<5; attempt+=1) {
    const bytes=randomBytes(8);let code="";for(const byte of bytes)code+=alphabet[byte%alphabet.length];
    try {
      const pairing=await prisma.devicePairing.create({data:{code,secretHash:secretHash(secret),expiresAt:new Date(Date.now()+10*60_000)}});
      const frontend=(process.env.FRONTEND_URL??"http://localhost:5173").split(",")[0].trim().replace(/\/$/,"");
      return res.status(201).json({pairing_id:pairing.id,code,secret,expires_at:pairing.expiresAt.toISOString(),verification_url:`${frontend}/account?pair=${code}`});
    } catch (error:any) { if(error?.code!=="P2002"||attempt===4)throw error; }
  }
});

devicePairingRouter.post("/approve", requireAuth, async (req,res) => {
  const parsed=codeSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:"VALIDATION_FAILED"});
  const pairing=await prisma.devicePairing.findUnique({where:{code:parsed.data.code}});
  if(!pairing)return res.status(404).json({error:"PAIRING_NOT_FOUND"});
  if(pairing.expiresAt<=new Date())return res.status(410).json({error:"PAIRING_EXPIRED"});
  if(pairing.status!=="pending")return res.status(409).json({error:"PAIRING_ALREADY_USED"});
  const updated=await prisma.devicePairing.update({where:{id:pairing.id},data:{status:"approved",userId:req.user!.id,companyId:req.user!.companyId,approvedAt:new Date()}});
  await recordAudit({companyId:req.user!.companyId,userId:req.user!.id,actionName:APPROVE_DEVICE_PAIRING_ACTION.actionName,inputPayload:{pairingCode:parsed.data.code},dataAfter:{pairingId:updated.id,expiresAt:updated.expiresAt},riskLevel:APPROVE_DEVICE_PAIRING_ACTION.riskLevel,confirmationRequired:true,confirmed:true,result:"success"});
  res.json({status:"approved",expires_at:updated.expiresAt.toISOString()});
});

devicePairingRouter.post("/token", limiter, async (req,res) => {
  const parsed=tokenSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:"VALIDATION_FAILED"});
  const pairing=await prisma.devicePairing.findUnique({where:{id:parsed.data.pairing_id}});
  if(!pairing)return res.status(404).json({error:"PAIRING_NOT_FOUND"});
  const supplied=Buffer.from(secretHash(parsed.data.secret),"hex"),expected=Buffer.from(pairing.secretHash,"hex");
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return res.status(401).json({error:"PAIRING_SECRET_INVALID"});
  if(pairing.expiresAt<=new Date())return res.status(410).json({error:"PAIRING_EXPIRED"});
  if(pairing.status==="pending")return res.status(202).json({status:"pending"});
  if(pairing.status!=="approved"||!pairing.userId)return res.status(409).json({error:"PAIRING_ALREADY_USED"});
  const claimed=await prisma.devicePairing.updateMany({where:{id:pairing.id,status:"approved",consumedAt:null},data:{status:"consumed",consumedAt:new Date()}});
  if(claimed.count!==1)return res.status(409).json({error:"PAIRING_ALREADY_USED"});
  const user=await prisma.user.findUniqueOrThrow({where:{id:pairing.userId}});
  const authUser={...publicUser(user),companyId:user.companyId};
  res.json({status:"connected",token:signToken(authUser,user.authVersion),user:publicUser(user)});
});
