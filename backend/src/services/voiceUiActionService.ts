import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import type { CommandUiAction, VoiceUiAction } from "../lib/voiceNavigation.js";

export async function publishVoiceUiAction(
  user: AuthedUser,
  intent: string,
  action: CommandUiAction,
): Promise<VoiceUiAction> {
  const published: VoiceUiAction = {
    ...action,
    id: randomUUID(),
    intent,
    createdAt: new Date().toISOString(),
  };
  await prisma.voiceDeviceState.upsert({
    where: { userId: user.id },
    create: {
      companyId: user.companyId,
      userId: user.id,
      lastUiAction: published as unknown as Prisma.InputJsonValue,
    },
    update: { lastUiAction: published as unknown as Prisma.InputJsonValue },
  });
  return published;
}
