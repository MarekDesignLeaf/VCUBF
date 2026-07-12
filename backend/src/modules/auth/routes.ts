import { Router } from "express";
import bcrypt from "bcryptjs";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth, signToken } from "../../middleware/auth.js";
import { recordAudit } from "../../lib/audit.js";
import { CHANGE_OWN_PASSWORD_ACTION, UPDATE_VOICE_PREFERENCES_ACTION } from "../../lib/actionContracts.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(12).regex(/[a-z]/, "new password must contain a lowercase letter").regex(/[A-Z]/, "new password must contain an uppercase letter").regex(/[0-9]/, "new password must contain a number"),
});

const voicePreferencesSchema = z.object({
  wake_word: z.string().trim().min(2).max(30).regex(/^[\p{L}\p{N}][\p{L}\p{N} '\-]*$/u, "wake word contains unsupported characters"),
  continuous_listening: z.boolean(),
  language: z.enum(["en-GB", "en-US"]),
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "invalid";
    return `${ipKeyGenerator(req.ip ?? "unknown")}:${email}`;
  },
  handler: (_req, res) => res.status(429).json({ error: "TOO_MANY_LOGIN_ATTEMPTS" }),
});

// POST /auth/login
authRouter.post("/login", loginRateLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  const token = signToken({
    id: user.id,
    companyId: user.companyId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    permissions: user.permissions,
    mustChangePassword: user.mustChangePassword,
    voiceWakeWord: user.voiceWakeWord,
    voiceContinuous: user.voiceContinuous,
    voiceLanguage: user.voiceLanguage,
  }, user.authVersion);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      permissions: user.permissions,
      mustChangePassword: user.mustChangePassword,
      voiceWakeWord: user.voiceWakeWord,
      voiceContinuous: user.voiceContinuous,
      voiceLanguage: user.voiceLanguage,
    },
  });
});

// GET /auth/me
authRouter.get("/me", requireAuth, (req, res) => {
  res.json(req.user);
});

authRouter.put("/voice-preferences", requireAuth, async (req, res) => {
  const parsed = voicePreferencesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const before = await prisma.user.findFirst({ where: { id: req.user!.id, companyId: req.user!.companyId }, select: { voiceWakeWord: true, voiceContinuous: true, voiceLanguage: true } });
  if (!before) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const user = await prisma.user.update({ where: { id: req.user!.id }, data: { voiceWakeWord: parsed.data.wake_word, voiceContinuous: parsed.data.continuous_listening, voiceLanguage: parsed.data.language } });
  const data = { voiceWakeWord: user.voiceWakeWord, voiceContinuous: user.voiceContinuous, voiceLanguage: user.voiceLanguage };
  await recordAudit({ companyId: req.user!.companyId, userId: req.user!.id, actionName: UPDATE_VOICE_PREFERENCES_ACTION.actionName, inputPayload: parsed.data, dataBefore: before, dataAfter: data, riskLevel: UPDATE_VOICE_PREFERENCES_ACTION.riskLevel, confirmationRequired: false, result: "success" });
  res.json(data);
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  const auditBase = { companyId: req.user!.companyId, userId: req.user!.id, actionName: CHANGE_OWN_PASSWORD_ACTION.actionName, riskLevel: CHANGE_OWN_PASSWORD_ACTION.riskLevel, confirmationRequired: false } as const;
  if (!parsed.success) {
    await recordAudit({ ...auditBase, inputPayload: { passwordFieldsRedacted: true }, result: "error", errorMessage: "VALIDATION_FAILED" });
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  }
  const user = await prisma.user.findFirst({ where: { id: req.user!.id, companyId: req.user!.companyId, isActive: true } });
  if (!user) {
    await recordAudit({ ...auditBase, inputPayload: { passwordFieldsRedacted: true }, result: "error", errorMessage: "USER_NOT_FOUND" });
    return res.status(404).json({ error: "USER_NOT_FOUND" });
  }
  if (!(await bcrypt.compare(parsed.data.current_password, user.passwordHash))) {
    await recordAudit({ ...auditBase, inputPayload: { passwordFieldsRedacted: true }, result: "rejected", errorMessage: "CURRENT_PASSWORD_INVALID" });
    return res.status(401).json({ error: "CURRENT_PASSWORD_INVALID" });
  }
  if (await bcrypt.compare(parsed.data.new_password, user.passwordHash)) {
    await recordAudit({ ...auditBase, inputPayload: { passwordFieldsRedacted: true }, result: "rejected", errorMessage: "PASSWORD_UNCHANGED" });
    return res.status(409).json({ error: "PASSWORD_UNCHANGED" });
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(parsed.data.new_password, 12), authVersion: { increment: 1 }, mustChangePassword: false } });
  await recordAudit({ ...auditBase, inputPayload: { passwordFieldsRedacted: true }, dataAfter: { passwordChanged: true }, result: "success" });
  res.status(204).send();
});
