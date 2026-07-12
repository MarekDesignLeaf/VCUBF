import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

export interface AuthedUser {
  id: string;
  companyId: string;
  email: string;
  displayName: string;
  role: string;
  permissions: string[];
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

export function signToken(user: AuthedUser, authVersion: number): string {
  return jwt.sign({ sub: user.id, authVersion }, JWT_SECRET, { expiresIn: "12h" });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "MISSING_PERMISSION", message: "No token provided" });
  }
  try {
    const token = header.slice("Bearer ".length);
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; authVersion?: number };
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
    };
    next();
  } catch {
    return res.status(401).json({ error: "MISSING_PERMISSION", message: "Invalid token" });
  }
}
