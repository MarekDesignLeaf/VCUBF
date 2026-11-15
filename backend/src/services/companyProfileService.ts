import { z } from "zod";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { UPDATE_COMPANY_PROFILE_ACTION } from "../lib/actionContracts.js";
import { fail, ok, type ServiceResult } from "./result.js";

/**
 * The company profile: today its name, which quotes, invoices and outgoing
 * messages carry. One place renames it, whether the Company page asks or it is
 * said to the assistant, so both validate and audit the same way.
 */

export const companyNameSchema = z.string().trim().min(2).max(160);

export const companyProfileView = {
  id: true,
  name: true,
  createdAt: true,
  setupCompletedAt: true,
  primaryAdministrator: { select: { id: true, displayName: true, email: true, role: true, isActive: true } },
} as const;

export async function currentCompanyName(user: AuthedUser): Promise<string | undefined> {
  return (await prisma.company.findUnique({ where: { id: user.companyId }, select: { name: true } }))?.name;
}

export async function renameCompany(user: AuthedUser, rawName: unknown, via: "page" | "voice"): Promise<ServiceResult<{ id: string; name: string }>> {
  const parsed = companyNameSchema.safeParse(rawName);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", "The company name must be 2 to 160 characters.");
  const before = await currentCompanyName(user);
  if (before === undefined) return fail(404, "COMPANY_NOT_FOUND");
  const company = await prisma.company.update({ where: { id: user.companyId }, data: { name: parsed.data }, select: companyProfileView });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_COMPANY_PROFILE_ACTION.actionName,
    inputPayload: { name: parsed.data, via },
    dataBefore: { name: before },
    dataAfter: { name: company.name },
    riskLevel: UPDATE_COMPANY_PROFILE_ACTION.riskLevel,
    // Said by voice, the new name was read back and confirmed.
    confirmationRequired: via === "voice",
    confirmed: via === "voice",
    result: "success",
  });
  return ok(200, company);
}
