import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth, signDesktopBootstrapToken, signToken, verifyDesktopBootstrapToken } from "../../middleware/auth.js";
import { recordAudit } from "../../lib/audit.js";
import { CHANGE_OWN_PASSWORD_ACTION, KNOWN_PERMISSIONS } from "../../lib/actionContracts.js";
import { frontendUrl } from "../../lib/frontendUrl.js";
import { deliverGmailSecurityMessage } from "../../services/gmailConnectorService.js";
import { updateVoicePreferences, voicePreferencesSchema } from "../../services/voicePreferenceService.js";

export const authRouter = Router();
let selectedLocalTestUserId: string | null = null;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const desktopLoginSchema = z.object({ bootstrap_token: z.string().min(40).max(2_000) });
const localTestLoginSchema = z.object({ user_id: z.string().uuid() });

const strongPassword = z.string().min(12).regex(/[a-z]/, "new password must contain a lowercase letter").regex(/[A-Z]/, "new password must contain an uppercase letter").regex(/[0-9]/, "new password must contain a number");
const changePasswordSchema = z.object({ current_password: z.string().min(1), new_password: strongPassword });
const passwordResetRequestSchema = z.object({ email: z.string().trim().email().max(320) });
const passwordResetSchema = z.object({ token: z.string().min(40).max(200), new_password: strongPassword });
const initialSetupSchema = z.object({
  company_name: z.string().trim().min(2, "company name is required").max(160),
  administrator_name: z.string().trim().min(2, "administrator name is required").max(120),
  administrator_email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  administrator_password: strongPassword,
});
const PASSWORD_RESET_LIFETIME_MS = 30 * 60 * 1000;
const resetTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function publicUser(user: { id: string; email: string; displayName: string; role: string; permissions: string[]; mustChangePassword: boolean; voiceWakeWord: string; voiceContinuous: boolean; voiceLanguage: string }) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    permissions: user.permissions,
    mustChangePassword: user.mustChangePassword,
    voiceWakeWord: user.voiceWakeWord,
    voiceContinuous: user.voiceContinuous,
    voiceLanguage: user.voiceLanguage,
  };
}

function localTestRequestAllowed(req: import("express").Request) {
  if (process.env.VCUBF_LOCAL_TEST_LOGIN !== "1") return false;
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function localTestNotFound(res: import("express").Response) {
  return res.status(404).json({ error: "NOT_FOUND" });
}

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

// This route is public only until the first company administrator exists. The
// marker, company and administrator are written as one transaction, enforcing
// the lifecycle: company first, administrator second, other users afterwards.
authRouter.get("/setup-status", async (_req, res) => {
  const setup = await prisma.systemSetup.findUnique({ where: { id: "primary" }, select: { id: true } });
  res.json({ setupRequired: !setup });
});

authRouter.post("/setup", async (req, res) => {
  const parsed = initialSetupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsed.error.message });
  const data = parsed.data;
  const existingSetup = await prisma.systemSetup.findUnique({ where: { id: "primary" }, select: { id: true } });
  if (existingSetup) return res.status(409).json({ error: "SETUP_ALREADY_COMPLETED", message: "This Secretary workspace already has a company administrator." });

  try {
    const passwordHash = await bcrypt.hash(data.administrator_password, 12);
    const setup = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({ data: { name: data.company_name, setupCompletedAt: new Date() } });
      const administrator = await tx.user.create({
        data: {
          companyId: company.id,
          email: data.administrator_email,
          passwordHash,
          displayName: data.administrator_name,
          role: "administrator",
          permissions: [...KNOWN_PERMISSIONS],
        },
      });
      const configuredCompany = await tx.company.update({
        where: { id: company.id },
        data: { primaryAdminUserId: administrator.id },
      });
      await tx.systemSetup.create({ data: { id: "primary", companyId: company.id } });
      return { company: configuredCompany, administrator };
    });
    await recordAudit({
      companyId: setup.company.id,
      userId: setup.administrator.id,
      actionName: "complete_initial_setup",
      inputPayload: { companyName: setup.company.name, administratorEmail: setup.administrator.email },
      dataAfter: { companyId: setup.company.id, primaryAdminUserId: setup.administrator.id },
      riskLevel: 3,
      confirmed: true,
      result: "success",
    });
    res.status(201).json({
      token: signToken({ ...publicUser(setup.administrator), companyId: setup.company.id }, setup.administrator.authVersion),
      user: publicUser(setup.administrator),
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return res.status(409).json({ error: "SETUP_ALREADY_COMPLETED", message: "This Secretary workspace already has a company administrator." });
    }
    throw error;
  }
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

// The Windows launcher already holds a DPAPI-protected, revocable device
// token. Exchange it for a 30-second purpose-restricted browser bootstrap so
// the local app can sign in without copying or exposing the account password.
authRouter.post("/desktop-bootstrap", requireAuth, async (req, res) => {
  const record = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { authVersion: true } });
  return res.json({ bootstrap_token: signDesktopBootstrapToken(req.user!, record.authVersion), expires_in: 30 });
});

authRouter.post("/desktop-login", loginRateLimiter, async (req, res) => {
  const parsed = desktopLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED" });
  try {
    const { user, authVersion } = await verifyDesktopBootstrapToken(parsed.data.bootstrap_token);
    return res.json({ token: signToken(user, authVersion), user: publicUser(user) });
  } catch {
    return res.status(401).json({ error: "DESKTOP_BOOTSTRAP_INVALID", message: "Desktop sign-in expired. Open Secretary again." });
  }
});

// Passwordless account tiles exist only in the explicitly enabled localhost
// development runtime. Railway and every non-loopback request receive 404.
authRouter.get("/local-test-users", async (req, res) => {
  if (!localTestRequestAllowed(req)) return localTestNotFound(res);
  const users = await prisma.user.findMany({
    where: { isActive: true },
    orderBy: [{ displayName: "asc" }, { email: "asc" }],
    select: { id: true, displayName: true, role: true, voiceLanguage: true },
  });
  res.json(users);
});

authRouter.post("/local-test-login", async (req, res) => {
  if (!localTestRequestAllowed(req)) return localTestNotFound(res);
  const parsed = localTestLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "VALIDATION_FAILED" });
  const user = await prisma.user.findUnique({ where: { id: parsed.data.user_id } });
  if (!user?.isActive) return res.status(404).json({ error: "USER_NOT_FOUND" });
  selectedLocalTestUserId = user.id;
  res.json({ token: signToken({
    id: user.id, companyId: user.companyId, email: user.email, displayName: user.displayName,
    role: user.role, permissions: user.permissions, mustChangePassword: user.mustChangePassword,
    voiceWakeWord: user.voiceWakeWord, voiceContinuous: user.voiceContinuous, voiceLanguage: user.voiceLanguage,
  }, user.authVersion), user: publicUser(user) });
});

authRouter.get("/local-test-active-session", async (req, res) => {
  if (!localTestRequestAllowed(req)) return localTestNotFound(res);
  if (!selectedLocalTestUserId) return res.status(404).json({ error: "LOCAL_TEST_USER_NOT_SELECTED" });
  const user = await prisma.user.findUnique({ where: { id: selectedLocalTestUserId } });
  if (!user?.isActive) {
    selectedLocalTestUserId = null;
    return res.status(404).json({ error: "USER_NOT_FOUND" });
  }
  res.json({ token: signToken({
    id: user.id, companyId: user.companyId, email: user.email, displayName: user.displayName,
    role: user.role, permissions: user.permissions, mustChangePassword: user.mustChangePassword,
    voiceWakeWord: user.voiceWakeWord, voiceContinuous: user.voiceContinuous, voiceLanguage: user.voiceLanguage,
  }, user.authVersion), user: publicUser(user) });
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
