import type { NextFunction, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { prisma } from "../db.js";
import { idempotency } from "./idempotency.js";

export interface AuthedUser {
  id: string;
  companyId: string;
  email: string;
  displayName: string;
  role: string;
  permissions: string[];
  mustChangePassword: boolean;
  voiceWakeWord: string;
  voiceContinuous: boolean;
  voiceLanguage: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      rawBody?: Buffer;
    }
  }
}

// CP-CODE-001 (SEC-04 / SYS-NFR-003): fail closed in production — a missing JWT secret must never
// silently fall back to a well-known development value.
const JWT_SECRET: string = (() => {
  const configured = process.env.JWT_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) {
    throw new Error("JWT_SECRET_MISSING_OR_TOO_SHORT: set JWT_SECRET (>=32 chars) in the production environment");
  }
  return "dev-secret-change-me";
})();

export function signToken(user: AuthedUser, authVersion: number, expiresIn: SignOptions["expiresIn"] = "7d"): string {
  return jwt.sign({ sub: user.id, authVersion }, JWT_SECRET, { expiresIn });
}

export function signDesktopBootstrapToken(user: AuthedUser, authVersion: number): string {
  return jwt.sign({ sub: user.id, authVersion, purpose: "desktop_bootstrap" }, JWT_SECRET, { expiresIn: "30s" });
}

export async function verifyDesktopBootstrapToken(token: string): Promise<{ user: AuthedUser; authVersion: number }> {
  const payload = jwt.verify(token, JWT_SECRET) as { sub: string; authVersion?: number; purpose?: string };
  if (payload.purpose !== "desktop_bootstrap") throw new Error("INVALID_DESKTOP_BOOTSTRAP");
  const record = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!record || !record.isActive || payload.authVersion !== record.authVersion) throw new Error("INVALID_DESKTOP_BOOTSTRAP");
  return {
    authVersion: record.authVersion,
    user: {
      id: record.id, companyId: record.companyId, email: record.email, displayName: record.displayName,
      role: record.role, permissions: record.permissions, mustChangePassword: record.mustChangePassword,
      voiceWakeWord: record.voiceWakeWord, voiceContinuous: record.voiceContinuous, voiceLanguage: record.voiceLanguage,
    },
  };
}

const idempotencyGuard = idempotency();

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "MISSING_PERMISSION", message: "No token provided" });
  }
  try {
    const token = header.slice("Bearer ".length);
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; authVersion?: number; purpose?: string };
    if (payload.purpose) throw new Error("PURPOSE_RESTRICTED_TOKEN");
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || payload.authVersion !== user.authVersion) {
      return res.status(401).json({ error: "MISSING_PERMISSION", message: "Invalid or inactive user" });
    }
    req.user = {
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
    };
  } catch {
    return res.status(401).json({ error: "MISSING_PERMISSION", message: "Invalid token" });
  }
  // Idempotency is enforced for every authenticated mutating request (CON-012 / OAS-001).
  // Runs outside the token try/catch so a storage error is reported as such, not as "Invalid token".
  try {
    return await idempotencyGuard(req, res, next);
  } catch (error) {
    return res.status(503).json({ code: "IDEMPOTENCY_STORE_UNAVAILABLE", message: (error as Error).message, retryable: true });
  }
}
