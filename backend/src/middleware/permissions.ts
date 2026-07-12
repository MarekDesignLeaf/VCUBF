import type { NextFunction, Request, Response } from "express";

/**
 * Permission Engine — a voice or web command must always be evaluated
 * against the identity and permissions of the requesting user.
 * See VCUF Master Documentation section 30.
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "MISSING_PERMISSION", message: "Not authenticated" });
    }
    if (req.user.mustChangePassword) {
      return res.status(403).json({
        error: "PASSWORD_CHANGE_REQUIRED",
        message: "Change the temporary password before using Secretary.",
      });
    }
    if (!req.user.permissions.includes(permission)) {
      return res.status(403).json({
        error: "MISSING_PERMISSION",
        message: `Missing required permission: ${permission}`,
      });
    }
    next();
  };
}
