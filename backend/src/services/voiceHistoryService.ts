import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { AuthedUser } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { CLEAR_VOICE_DEVICE_HISTORY_ACTION } from "../lib/actionContracts.js";

/**
 * The speaker's own voice history: saved conversation transcripts, the e-mail
 * waiting in a voice review and what the device last heard and said. One
 * place clears it, whether the page asks or it is said to the assistant, so
 * both delete exactly the same things and leave the same audit entry.
 */

/** What clearing would delete, counted for the review read back before it. */
export async function voiceHistorySize(user: AuthedUser) {
  const own = { userId: user.id, companyId: user.companyId };
  const [conversations, messages, pendingEmails] = await Promise.all([
    prisma.voiceConversation.count({ where: own }),
    prisma.voiceConversationMessage.count({ where: { companyId: user.companyId, conversation: { userId: user.id } } }),
    prisma.voicePendingAction.count({ where: { ...own, actionType: "send_gmail_message", status: "pending" } }),
  ]);
  return { conversations, messages, pendingEmails };
}

/**
 * Delete the transcripts, withdraw the waiting e-mail and ask the live device
 * to end its conversation. Returns the device state as it now is.
 */
export async function clearVoiceHistory(user: AuthedUser, via: "page" | "voice") {
  const size = await voiceHistorySize(user);
  await prisma.$transaction([
    prisma.voiceConversation.deleteMany({ where: { userId: user.id, companyId: user.companyId } }),
    prisma.voicePendingAction.updateMany({
      where: { userId: user.id, companyId: user.companyId, actionType: "send_gmail_message", status: "pending" },
      data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: new Date() },
    }),
    prisma.voiceDeviceState.updateMany({
      where: { userId: user.id, companyId: user.companyId },
      data: { lastTranscript: null, lastResponse: null, lastUiAction: Prisma.DbNull, lastHeardAt: null, pendingControl: "end_conversation" },
    }),
  ]);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: CLEAR_VOICE_DEVICE_HISTORY_ACTION.actionName,
    interpretedIntent: "end active voice conversation and clear transcript history",
    // Counts only: the transcripts themselves are what was asked to be gone.
    inputPayload: { via },
    dataBefore: size,
    riskLevel: CLEAR_VOICE_DEVICE_HISTORY_ACTION.riskLevel,
    // Only a spoken request is known here to have been read back and confirmed;
    // the page asks in the browser, which the server cannot see.
    confirmationRequired: via === "voice",
    confirmed: via === "voice",
    result: "success",
  });
  return { ...size, state: await prisma.voiceDeviceState.findUnique({ where: { userId: user.id } }) };
}
