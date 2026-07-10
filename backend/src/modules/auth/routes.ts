import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth, signToken } from "../../middleware/auth.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /auth/login
authRouter.post("/login", async (req, res) => {
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
  });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      permissions: user.permissions,
    },
  });
});

// GET /auth/me
authRouter.get("/me", requireAuth, (req, res) => {
  res.json(req.user);
});
