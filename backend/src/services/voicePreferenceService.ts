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
  // Optional, so a client that does not send them leaves them alone rather
  // than resetting them.
  assistant_name: z.string().trim().min(1).max(40).optional(),
  // A multiplier of the voice's natural pace. Bounded because past roughly
  // double speed the words stop being intelligible.
  speech_rate: z.number().min(0.5).max(2).optional(),
});

export type VoicePreferencesInput = z.infer<typeof voicePreferencesSchema>;

export type VoicePreferences = {
  voiceWakeWord: string;
  voiceContinuous: boolean;
  voiceLanguage: VoiceLanguage;
  /** What the secretary is called; separate from the word that wakes her. */
  assistantName: string;
  /** Speaking speed as a multiplier of the voice own pace. */
  voiceSpeechRate: number;
};

function preferences(user: { voiceWakeWord: string; voiceContinuous: boolean; voiceLanguage: string; assistantName: string; voiceSpeechRate: number }): VoicePreferences {
  return {
    assistantName: user.assistantName,
    voiceSpeechRate: user.voiceSpeechRate,
    voiceWakeWord: user.voiceWakeWord,
    voiceContinuous: user.voiceContinuous,
    voiceLanguage: user.voiceLanguage as VoiceLanguage,
  };
}

export async function updateVoicePreferences(user: AuthedUser, input: VoicePreferencesInput): Promise<ServiceResult<VoicePreferences>> {
  const before = await prisma.user.findFirst({
    where: { id: user.id, companyId: user.companyId },
    select: { voiceWakeWord: true, voiceContinuous: true, voiceLanguage: true, assistantName: true, voiceSpeechRate: true },
  });
  if (!before) return fail(404, "USER_NOT_FOUND");

  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        voiceWakeWord: input.wake_word,
        voiceContinuous: input.continuous_listening,
        voiceLanguage: input.language,
        // Left untouched when absent: omitting a field must not clear it.
        ...(input.assistant_name === undefined ? {} : { assistantName: input.assistant_name }),
        ...(input.speech_rate === undefined ? {} : { voiceSpeechRate: input.speech_rate }),
      },
    }),
    // Keep the saved transcript history intact, but remove the live preview
    // from the previous language. Otherwise the Czech interface can continue
    // showing the last English answer until the next voice turn.
    ...(before.voiceLanguage !== input.language
      ? [prisma.voiceDeviceState.updateMany({
          where: { userId: user.id, companyId: user.companyId },
          data: { lastTranscript: null, lastResponse: null },
        })]
      : []),
  ]);
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
    select: { voiceWakeWord: true, voiceContinuous: true, assistantName: true, voiceSpeechRate: true },
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
