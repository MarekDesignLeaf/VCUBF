import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth, signToken } from "../../middleware/auth.js";
import { recordAudit } from "../../lib/audit.js";
import { CHANGE_OWN_PASSWORD_ACTION } from "../../lib/actionContracts.js";
import { frontendUrl } from "../../lib/frontendUrl.js";
import { deliverGmailSecurityMessage } from "../../services/gmailConnectorService.js";
import { updateVoicePreferences, voicePreferencesSchema } from "../../services/voicePreferenceService.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const strongPassword = z.string().min(12).regex(/[a-z]/, "new password must contain a lowercase letter").regex(/[A-Z]/, "new password must contain an uppercase letter").regex(/[0-9]/, "new password must contain a number");
const changePasswordSchema = z.object({ current_password: z.string().min(1), new_password: strongPassword });
const passwordResetRequestSchema = z.object({ email: z.string().trim().email().max(320) });
const passwordResetSchema = z.object({ token: z.string().min(40).max(200), new_password: strongPassword });
const PASSWORD_RESET_LIFETIME_MS = 30 * 60 * 1000;
const resetTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function passwordResetUrl(token: string) {
  const url = frontendUrl("/reset-password");
  url.searchParams.set("token", token);
  return url.toString();
}

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

const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "invalid";
    return `${ipKeyGenerator(req.ip ?? "unknown")}:${email}`;
  },
  handler: (_req, res) => res.status(202).json({ message: "If this account can be recovered, instructions have been sent." }),
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

// Requests deliberately return the same response for every account state to
// avoid revealing which email addresses are registered.
authRouter.post("/request-password-reset", passwordResetRateLimiter, async (req, res) => {
  const parsed = passwordResetRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !user.isActive) {
    return res.status(202).json({ message: "If this account can be recovered, instructions have been sent." });
  }

  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_LIFETIME_MS);
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
  const reset = await prisma.passwordResetToken.create({
    data: { companyId: user.companyId, userId: user.id, tokenHash: resetTokenHash(rawToken), expiresAt },
  });
  const delivery = await deliverGmailSecurityMessage({
    companyId: user.companyId,
    recipient: user.email,
    // The installed bootstrap account deliberately uses a documentation-only
    // address. Send its recovery link to the Gmail account that owns the
    // configured company connector instead.
    fallbackToConnectedMailbox: user.email.toLowerCase() === "admin@example.com",
    subject: "Reset your VCUF Secretary password",
    body: `A password reset was requested for your VCUF Secretary account.\n\nUse this one-time link within 30 minutes:\n${passwordResetUrl(rawToken)}\n\nIf you did not request this, you can ignore this message.`,
  });
  if (!delivery.delivered) {
    await prisma.passwordResetToken.delete({ where: { id: reset.id } });
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: "request_password_reset", inputPayload: { delivery: "gmail" }, riskLevel: 2, result: "error", errorMessage: "RECOVERY_DELIVERY_UNAVAILABLE" });
  } else {
    await recordAudit({ companyId: user.companyId, userId: user.id, actionName: "request_password_reset", inputPayload: { delivery: "gmail", sourceId: delivery.sourceId }, dataAfter: { expiresAt }, riskLevel: 2, result: "success" });
  }
  res.status(202).json({ message: "If this account can be recovered, instructions have been sent." });
});

authRouter.post("/reset-password", async (req, res) => {
  const parsed = passwordResetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const now = new Date();
  const reset = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: resetTokenHash(parsed.data.token) },
    include: { user: true },
  });
  if (!reset || reset.usedAt || reset.expiresAt <= now || !reset.user.isActive) {
    return res.status(400).json({ error: "RESET_TOKEN_INVALID_OR_EXPIRED" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.new_password, 12);
  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: reset.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return false;
    await tx.user.update({
      where: { id: reset.userId },
      data: { passwordHash, authVersion: { increment: 1 }, mustChangePassword: false },
    });
    await tx.passwordResetToken.updateMany({ where: { userId: reset.userId, id: { not: reset.id }, usedAt: null }, data: { usedAt: now } });
    return true;
  });
  if (!applied) return res.status(400).json({ error: "RESET_TOKEN_INVALID_OR_EXPIRED" });
  await recordAudit({ companyId: reset.companyId, userId: reset.userId, actionName: "reset_password", inputPayload: { passwordFieldsRedacted: true }, dataAfter: { passwordReset: true }, riskLevel: 2, result: "success" });
  res.status(204).send();
});

// GET /auth/me
authRouter.get("/me", requireAuth, (req, res) => {
  res.json(req.user);
});

authRouter.put("/voice-preferences", requireAuth, async (req, res) => {
  const parsed = voicePreferencesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const result = await updateVoicePreferences(req.user!, parsed.data);
  if (!result.ok) return res.status(result.httpStatus).json({ error: result.error, message: result.message });
  res.status(result.httpStatus).json(result.data);
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
