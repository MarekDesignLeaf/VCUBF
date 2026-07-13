import { z } from "zod";
import { prisma } from "../db.js";
import { UPDATE_VOICE_PREFERENCES_ACTION } from "../lib/actionContracts.js";
import { VOICE_LANGUAGES, type VoiceLanguage, languageSwitchMessage } from "../lib/voiceLanguages.js";
import { recordAudit } from "../lib/audit.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";

export const voicePreferencesSchema = z.object({
  wake_word: z.string().trim().min(2).max(30).regex(/^[\p{L}\p{N}][\p{L}\p{N} '\-]*$/u, "wake word contains unsupported characters"),
  continuous_listening: z.boolean(),
  language: z.enum(VOICE_LANGUAGES),
});

export type VoicePreferencesInput = z.infer<typeof voicePreferencesSchema>;

export type VoicePreferences = {
  voiceWakeWord: string;
  voiceContinuous: boolean;
  voiceLanguage: VoiceLanguage;
};

function preferences(user: { voiceWakeWord: string; voiceContinuous: boolean; voiceLanguage: string }): VoicePreferences {
  return {
    voiceWakeWord: user.voiceWakeWord,
    voiceContinuous: user.voiceContinuous,
    voiceLanguage: user.voiceLanguage as VoiceLanguage,
  };
}

export async function updateVoicePreferences(user: AuthedUser, input: VoicePreferencesInput): Promise<ServiceResult<VoicePreferences>> {
  const before = await prisma.user.findFirst({
    where: { id: user.id, companyId: user.companyId },
    select: { voiceWakeWord: true, voiceContinuous: true, voiceLanguage: true },
  });
  if (!before) return fail(404, "USER_NOT_FOUND");

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      voiceWakeWord: input.wake_word,
      voiceContinuous: input.continuous_listening,
      voiceLanguage: input.language,
    },
  });
  const data = preferences(updated);
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: UPDATE_VOICE_PREFERENCES_ACTION.actionName,
    inputPayload: input,
    dataBefore: before,
    dataAfter: data,
    riskLevel: UPDATE_VOICE_PREFERENCES_ACTION.riskLevel,
    confirmationRequired: false,
    result: "success",
  });
  return ok(200, data);
}

export async function setVoiceLanguage(user: AuthedUser, language: VoiceLanguage): Promise<ServiceResult<VoicePreferences & { message: string }>> {
  const current = await prisma.user.findFirst({
    where: { id: user.id, companyId: user.companyId },
    select: { voiceWakeWord: true, voiceContinuous: true },
  });
  if (!current) return fail(404, "USER_NOT_FOUND");

  const result = await updateVoicePreferences(user, {
    wake_word: current.voiceWakeWord,
    continuous_listening: current.voiceContinuous,
    language,
  });
  if (!result.ok) return result;
  return ok(result.httpStatus, { ...result.data, message: languageSwitchMessage(language) });
}
