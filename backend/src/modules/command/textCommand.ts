import { Router, raw } from "express";
import { z } from "zod";
import { requireAuth, type AuthedUser } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { isExplicitVoiceLanguageChange, isGmailCancellationPhrase, isGmailConfirmationPhrase, parseTextCommand } from "../../lib/commandParser.js";
import { dispatchParsedCommand, type CommandResponse } from "../../lib/commandExecutor.js";
import { resolveLearningAliases } from "../../services/learningService.js";
import { createRealtimeClientSession, interpretVoiceRequest, transcribeVoiceAudio } from "../../services/voiceAssistantService.js";
import { publishVoiceUiAction } from "../../services/voiceUiActionService.js";
import { getAssistantContext } from "../../services/assistantMemoryService.js";
import { hasPendingVoiceGmailMessage } from "../../services/voiceGmailService.js";
import { hasPendingVoiceWhatsAppMessage } from "../../services/voiceWhatsAppService.js";
import { hasPendingVoiceNotificationDeletion } from "../../services/voiceNotificationService.js";
import { getNavigationCatalogue } from "../../lib/navigationCatalogue.js";
import { languageChangeRejectedMessage } from "../../lib/voiceLanguages.js";
import { evaluateEmmaCommand } from "../../services/emmaPolicyService.js";
import { getActiveEmmaBehaviorScenario } from "../../services/emmaBehaviorService.js";
import { getPendingEmmaActionName } from "../../services/emmaExecutableActionService.js";

export const commandRouter = Router();

commandRouter.use(requireAuth);

// Exposes the same authoritative tree used in Emma's prompt. It is read-only
// and includes page descendants that are not represented by a sidebar link.
commandRouter.get("/navigation", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), (req, res) => {
  const navigation = getNavigationCatalogue(req.user!.permissions, undefined, req.user!.voiceLanguage);
  res.set("Cache-Control", "no-store");
  return res.json({ title: navigation.title, sections: navigation.sections });
});

const commandSchema = z.object({
  text: z.string().min(1, "text is required"),
  input_method: z.enum(["text", "voice_transcript"]).default("text"),
});

const assistantSchema = commandSchema.extend({
  language: z.string().min(2).max(20).default("en-GB"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(800) }))
    .max(6)
    .default([]),
});

const transcriptionQuerySchema = z.object({
  language: z.string().trim().min(2).max(20).default("en-GB"),
  wake_word: z.string().trim().min(1).max(80).default("Emma"),
});

type ParsedTextCommand = ReturnType<typeof parseTextCommand>;

async function resolveUserCommand(user: AuthedUser, text: string): Promise<ParsedTextCommand> {
  const parsed = parseTextCommand(text);
  if (parsed.intent !== "unrecognized") return parsed;
  const [gmailPending, whatsappPending, notificationDeletionPending, pendingEmmaAction] = await Promise.all([
    hasPendingVoiceGmailMessage(user),
    hasPendingVoiceWhatsAppMessage(user),
    hasPendingVoiceNotificationDeletion(user),
    getPendingEmmaActionName(user),
  ]);
  const pendingActions: Array<{ pending: boolean; confirm: ParsedTextCommand; cancel: ParsedTextCommand }> = [
    {
      pending: gmailPending,
      confirm: { intent: "confirm_gmail_message", entities: {} },
      cancel: { intent: "cancel_gmail_message", entities: {} },
    },
    {
      pending: whatsappPending,
      confirm: { intent: "confirm_whatsapp_message", entities: {} },
      cancel: { intent: "cancel_whatsapp_message", entities: {} },
    },
    {
      pending: notificationDeletionPending,
      confirm: { intent: "confirm_delete_notifications", entities: {} },
      cancel: { intent: "cancel_delete_notifications", entities: {} },
    },
    {
      pending: Boolean(pendingEmmaAction),
      confirm: { intent: "confirm_execute_action", entities: { action: pendingEmmaAction! } },
      cancel: { intent: "cancel_execute_action", entities: { action: pendingEmmaAction! } },
    },
  ];
  const active = pendingActions.filter((candidate) => candidate.pending);
  if (active.length !== 1) return parsed;
  if (isGmailConfirmationPhrase(text)) return active[0].confirm;
  if (isGmailCancellationPhrase(text)) return active[0].cancel;
  return parsed;
}

function auditText(command: ParsedTextCommand, value: string | null | undefined) {
  return ["prepare_gmail_message", "prepare_whatsapp_message"].includes(command.intent) && value
    ? "[REDACTED_OUTBOUND_MESSAGE]"
    : value;
}

function auditAssistantInput(text: string) {
  // A natural-language outbound request may be clarified before it becomes a
  // deterministic command. Keep that message content in the conversation
  // transcript (the user's chosen history), but never copy it into the audit.
  return /(?:send|write|compose|draft|pošli|posli|odešli|odesli|napiš|napis|wyślij|wyslij|napisz).*?(?:e-?mail|mail|whatsapp)/iu.test(text)
    ? "[REDACTED_OUTBOUND_MESSAGE]"
    : text;
}

function auditInterpreted(command: ParsedTextCommand, interpreted: unknown) {
  if (command.intent === "prepare_gmail_message") {
    return {
      toCount: command.entities.to.length,
      ccCount: command.entities.cc.length,
      bccCount: command.entities.bcc.length,
      subjectLength: command.entities.subject.length,
      bodyLength: command.entities.body.length,
    };
  }
  if (command.intent === "prepare_whatsapp_message") {
    return { recipientLength: command.entities.to.length, bodyLength: command.entities.body.length };
  }
  return interpreted;
}

const NON_ACTION_MUTATION_CLAIM = /(?:\b(?:i(?:'|’)ll|i\s+will|i(?:'|’)m\s+going\s+to|i\s+am\s+going\s+to|go\s+ahead\s+and|proceed(?:ing)?\s+to)\b.{0,120}\b(?:create|add|update|delete|remove|send|change|archive|save|record)\b|\b(?:has|have|was|were)\s+(?:been\s+)?(?:created|added|updated|deleted|removed|sent|changed|archived|saved|recorded)\b|\b(?:vytvořím|vytvorim|přidám|pridam|změním|zmenim|smažu|smazu|odešlu|odeslu)\b|\b(?:utworzę|utworze|dodam|zmienię|zmienie|usunę|usune|wyślę|wysle)\b)/iu;

function nonActionSafetyMessage(language: string) {
  const messages: Record<string, string> = {
    cs: "Nebyl vytvořen ani změněn žádný firemní záznam. Nejdříve potřebuji úplný a platný požadavek.",
    pl: "Żaden rekord firmowy nie został utworzony ani zmieniony. Najpierw potrzebuję kompletnego i prawidłowego polecenia.",
    fr: "Aucun enregistrement professionnel n’a été créé ou modifié. J’ai d’abord besoin d’une demande complète et valide.",
    de: "Es wurde kein Geschäftseintrag erstellt oder geändert. Ich benötige zuerst eine vollständige und gültige Anweisung.",
    es: "No se creó ni modificó ningún registro empresarial. Primero necesito una solicitud completa y válida.",
    it: "Nessun record aziendale è stato creato o modificato. Prima mi serve una richiesta completa e valida.",
    en: "No business record was created or changed. I still need a complete, valid request before I can do that.",
  };
  return messages[language.slice(0, 2).toLocaleLowerCase("en")] ?? messages.en;
}

function assistantServiceMessage(language: string, kind: "unavailable" | "unsupported") {
  const locale = language.slice(0, 2).toLocaleLowerCase("en");
  const messages: Record<string, Record<typeof kind, string>> = {
    cs: {
      unavailable: "Teď se nemohu spojit s jazykovou službou. Zkuste prosím přímý příkaz.",
      unsupported: "Požadavku jsem porozuměla, ale tato operace zatím není podporovaná. Zkuste ji prosím říct jako jednu přímou akci.",
    },
    pl: {
      unavailable: "Nie mogę teraz połączyć się z usługą językową. Spróbuj wydać bezpośrednie polecenie.",
      unsupported: "Rozumiem żądaniu, ale ta operacja nie jest jeszcze obsługiwana. Sformułuj ją jako jedną bezpośrednią czynność.",
    },
    fr: {
      unavailable: "Je ne peux pas joindre le service linguistique pour le moment. Essayez une commande directe.",
      unsupported: "J’ai compris la demande, mais cette opération n’est pas encore prise en charge. Reformulez-la comme une seule action directe.",
    },
    de: {
      unavailable: "Ich kann den Sprachdienst derzeit nicht erreichen. Versuchen Sie bitte einen direkten Befehl.",
      unsupported: "Ich habe die Anfrage verstanden, aber dieser Vorgang wird noch nicht unterstützt. Formulieren Sie ihn bitte als eine direkte Aktion.",
    },
    es: {
      unavailable: "Ahora mismo no puedo conectar con el servicio de idioma. Pruebe con una orden directa.",
      unsupported: "He entendido la solicitud, pero esta operación aún no está disponible. Exprésela como una sola acción directa.",
    },
    it: {
      unavailable: "Al momento non riesco a contattare il servizio linguistico. Prova con un comando diretto.",
      unsupported: "Ho compreso la richiesta, ma questa operazione non è ancora supportata. Formulala come un’unica azione diretta.",
    },
    en: {
      unavailable: "I cannot reach the language service right now. Please try a direct command.",
      unsupported: "I understood the request, but this action is not supported yet. Please rephrase it as one direct action.",
    },
  };
  return (messages[locale] ?? messages.en)[kind];
}

function safeNonActionAssistantMessage(message: string, language: string) {
  return NON_ACTION_MUTATION_CLAIM.test(message) ? nonActionSafetyMessage(language) : message;
}

function localizeVoiceClientResponse(response: CommandResponse, language: string): CommandResponse {
  if (response.intent !== "create_client") return response;
  const interpreted = response.interpreted as { display_name?: string };
  const name = interpreted.display_name?.trim() || "client";
  const invalidFields = Array.isArray((response.data as any)?.invalidFields)
    ? (response.data as any).invalidFields as string[]
    : [];
  const invalidEmail = invalidFields.includes("email_primary");
  const invalidPhone = invalidFields.includes("phone_primary");
  const locale = language.slice(0, 2).toLocaleLowerCase("en");
  const messages: Record<string, { created: string; email: string; phone: string; both: string }> = {
    en: {
      created: `${name} was created as a client.`,
      email: `The email address was not recognised as valid, so ${name} was not created. Please say the complete email address again.`,
      phone: `The phone number was not recognised as valid, so ${name} was not created. Please say the full phone number again, including the country or area code.`,
      both: `The email address and phone number were not recognised as valid, so ${name} was not created. Please say both values again.`,
    },
    cs: {
      created: `${name} byl vytvořen jako klient.`,
      email: `E-mailová adresa nebyla rozpoznána jako platná, takže ${name} nebyl vytvořen. Řekněte prosím celou e-mailovou adresu znovu.`,
      phone: `Telefonní číslo nebylo rozpoznáno jako platné, takže ${name} nebyl vytvořen. Řekněte prosím celé číslo znovu, včetně předvolby.`,
      both: `E-mailová adresa ani telefonní číslo nebyly rozpoznány jako platné, takže ${name} nebyl vytvořen. Řekněte prosím oba údaje znovu.`,
    },
    pl: {
      created: `${name} został utworzony jako klient.`,
      email: `Adres e-mail nie został rozpoznany jako prawidłowy, dlatego ${name} nie został utworzony. Podaj ponownie pełny adres e-mail.`,
      phone: `Numer telefonu nie został rozpoznany jako prawidłowy, dlatego ${name} nie został utworzony. Podaj ponownie pełny numer wraz z numerem kierunkowym.`,
      both: `Adres e-mail i numer telefonu nie zostały rozpoznane jako prawidłowe, dlatego ${name} nie został utworzony. Podaj ponownie obie wartości.`,
    },
    de: {
      created: `${name} wurde als Kunde erstellt.`,
      email: `Die E-Mail-Adresse wurde nicht als gültig erkannt, daher wurde ${name} nicht erstellt. Bitte nennen Sie die vollständige E-Mail-Adresse erneut.`,
      phone: `Die Telefonnummer wurde nicht als gültig erkannt, daher wurde ${name} nicht erstellt. Bitte nennen Sie die vollständige Nummer einschließlich Vorwahl erneut.`,
      both: `E-Mail-Adresse und Telefonnummer wurden nicht als gültig erkannt, daher wurde ${name} nicht erstellt. Bitte nennen Sie beide Angaben erneut.`,
    },
    fr: {
      created: `${name} a été créé comme client.`,
      email: `L’adresse e-mail n’a pas été reconnue comme valide, donc ${name} n’a pas été créé. Veuillez redonner l’adresse e-mail complète.`,
      phone: `Le numéro de téléphone n’a pas été reconnu comme valide, donc ${name} n’a pas été créé. Veuillez redonner le numéro complet avec l’indicatif.`,
      both: `L’adresse e-mail et le numéro de téléphone ne sont pas valides, donc ${name} n’a pas été créé. Veuillez redonner les deux valeurs.`,
    },
    es: {
      created: `${name} se creó como cliente.`,
      email: `El correo electrónico no se reconoció como válido, por lo que ${name} no se creó. Indique de nuevo la dirección completa.`,
      phone: `El teléfono no se reconoció como válido, por lo que ${name} no se creó. Indique de nuevo el número completo con prefijo.`,
      both: `El correo y el teléfono no se reconocieron como válidos, por lo que ${name} no se creó. Indique de nuevo ambos datos.`,
    },
    it: {
      created: `${name} è stato creato come cliente.`,
      email: `L’indirizzo e-mail non è stato riconosciuto come valido, quindi ${name} non è stato creato. Ripeti l’indirizzo completo.`,
      phone: `Il numero di telefono non è stato riconosciuto come valido, quindi ${name} non è stato creato. Ripeti il numero completo con prefisso.`,
      both: `L’indirizzo e-mail e il telefono non sono validi, quindi ${name} non è stato creato. Ripeti entrambi i dati.`,
    },
  };
  const selected = messages[locale] ?? messages.en;
  if (response.ok) return { ...response, message: selected.created };
  if (response.error !== "VALIDATION_FAILED" || (!invalidEmail && !invalidPhone)) return response;
  return { ...response, message: invalidEmail && invalidPhone ? selected.both : invalidEmail ? selected.email : selected.phone };
}

async function blockedByEmmaPolicy(user: AuthedUser, command: ParsedTextCommand) {
  const decision = await evaluateEmmaCommand(user, command);
  if (decision.allowed) return undefined;
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: "execute_text_command",
    interpretedIntent: command.intent,
    inputPayload: { capabilityId: decision.capabilityId },
    riskLevel: 1,
    confirmationRequired: false,
    result: "rejected",
    errorMessage: "EMMA_CAPABILITY_DISABLED",
  });
  return decision;
}

commandRouter.post(
  "/transcribe",
  requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission),
  raw({ type: ["audio/wav", "audio/x-wav"], limit: "2mb" }),
  async (req, res) => {
    const query = transcriptionQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: query.error.message });
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const isWave = audio.length >= 44 && audio.subarray(0, 4).toString("ascii") === "RIFF" && audio.subarray(8, 12).toString("ascii") === "WAVE";
    if (!isWave) return res.status(400).json({ error: "INVALID_AUDIO", message: "A valid WAV command recording is required." });
    try {
      const language = req.user!.voiceLanguage;
      const transcription = await transcribeVoiceAudio(audio, language, query.data.wake_word);
      await recordAudit({
        companyId: req.user!.companyId,
        userId: req.user!.id,
        actionName: "transcribe_voice_command",
        inputPayload: { audioBytes: audio.length, language, model: transcription.model },
        dataAfter: { transcriptCharacters: transcription.text.length },
        riskLevel: 0,
        confirmationRequired: false,
        result: "success",
      });
      res.set("Cache-Control", "no-store");
      return res.json({ text: transcription.text });
    } catch (error) {
      console.error("Voice command transcription failed", error instanceof Error ? error.message : error);
      return res.status(503).json({ error: "TRANSCRIPTION_UNAVAILABLE", message: "Voice transcription is temporarily unavailable." });
    }
  }
);

commandRouter.post("/realtime/session", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  try {
    const behaviorScenario = await getActiveEmmaBehaviorScenario(req.user!.companyId);
    const session = await createRealtimeClientSession(behaviorScenario);
    await recordAudit({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      actionName: "start_realtime_voice_session",
      inputPayload: { model: session.model },
      riskLevel: 0,
      confirmationRequired: false,
      result: "success",
    });
    res.set("Cache-Control", "no-store");
    return res.json({
      client_secret: session.clientSecret,
      expires_at: session.expiresAt,
      model: session.model,
      behavior_instructions: session.behaviorInstructions,
    });
  } catch (error) {
    console.error("Realtime session creation failed", error instanceof Error ? error.message : error);
    return res.status(503).json({ error: "REALTIME_UNAVAILABLE", message: "Realtime voice is temporarily unavailable." });
  }
});

commandRouter.post("/assistant", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const parsedBody = assistantSchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: "VALIDATION_FAILED", message: parsedBody.error.message });
  const { text, input_method, history } = parsedBody.data;
  const user = req.user!;
  // The authenticated user preference is the single language authority.
  // A stale desktop/browser payload must never switch one response back to
  // English while the menu and the rest of Emma are using another language.
  const language = user.voiceLanguage;
  const alias = await resolveLearningAliases(user, text);
  let command = await resolveUserCommand(user, alias.resolvedText);
  let assistant: Awaited<ReturnType<typeof interpretVoiceRequest>> | undefined;

  if (command.intent === "unrecognized") {
    try {
      const [memoryContext, behaviorScenario] = await Promise.all([
        getAssistantContext(user),
        getActiveEmmaBehaviorScenario(user.companyId),
      ]);
      assistant = await interpretVoiceRequest({
        text: alias.resolvedText,
        userName: user.displayName,
        language,
        history,
        memoryContext,
        behaviorScenario,
      });
    } catch (error) {
      console.error("Voice assistant interpretation failed", error instanceof Error ? error.message : error);
      return res.status(503).json({
        ok: false,
        kind: "error",
        error: "ASSISTANT_UNAVAILABLE",
        message: assistantServiceMessage(language, "unavailable"),
      });
    }
    if (assistant.kind !== "command" || !assistant.canonical_command) {
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: "interpret_voice_request",
        interpretedIntent: assistant.kind,
        inputPayload: { text: auditAssistantInput(text), inputMethod: input_method },
        dataAfter: { kind: assistant.kind },
        riskLevel: 0,
        confirmationRequired: false,
        result: "success",
      });
      return res.json({
        ok: true,
        kind: assistant.kind,
        actionExecuted: false,
        message: safeNonActionAssistantMessage(assistant.message, language),
      });
    }
    command = await resolveUserCommand(user, assistant.canonical_command);
    if (command.intent === "unrecognized") {
      return res.json({ ok: true, kind: "clarification", message: assistantServiceMessage(language, "unsupported") });
    }
    if (command.intent === "set_voice_language" && !isExplicitVoiceLanguageChange(alias.resolvedText, command.entities.language)) {
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: "reject_inferred_voice_language_change",
        interpretedIntent: command.intent,
        inputPayload: { text: auditAssistantInput(text), inputMethod: input_method },
        dataAfter: { requestedLanguage: command.entities.language },
        riskLevel: 0,
        confirmationRequired: false,
        result: "error",
        errorMessage: "LANGUAGE_CHANGE_NOT_EXPLICIT",
      });
      return res.json({
        ok: true,
        kind: "clarification",
        message: languageChangeRejectedMessage(user.voiceLanguage),
      });
    }
  }

  const policyBlock = await blockedByEmmaPolicy(user, command);
  if (policyBlock) return res.status(403).json({
    ok: false,
    kind: "action",
    error: "EMMA_CAPABILITY_DISABLED",
    message: policyBlock.message,
    capabilityId: policyBlock.capabilityId,
  });

  const response = localizeVoiceClientResponse(await dispatchParsedCommand(user, command), language);
  const uiAction = response.uiAction
    ? await publishVoiceUiAction(user, response.intent, response.uiAction)
    : undefined;
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: {
      text: auditText(command, text),
      inputMethod: input_method,
      resolvedText: auditText(command, alias.resolvedText),
      canonicalCommand: auditText(command, assistant?.canonical_command),
      appliedAliases: alias.appliedRules,
    },
    dataAfter: { interpreted: auditInterpreted(command, response.interpreted), uiAction },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });
  return res.status(response.httpStatus).json({ ...response, uiAction, kind: "action", assistantMessage: assistant?.message, appliedAliases: alias.appliedRules });
});

// POST /command/text — Voice and Text Command Layer entry point.
// Learning Engine alias resolution -> deterministic parse -> Action Engine
// dispatch (dispatchParsedCommand, shared with the Playbook Engine) ->
// structured response. Every call is audited as execute_text_command in
// addition to whatever underlying Action Contract it dispatches to, and the
// audit records the command input and any learned alias that was applied so
// the interpretation stays traceable. Email message content is redacted from
// audit records; it is held only in the short-lived pending action until
// resolved and in the user-visible conversation transcript.
commandRouter.post("/text", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const parsedBody = commandSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsedBody.error.message });
  }
  const { text, input_method } = parsedBody.data;
  const user = req.user!;

  const alias = await resolveLearningAliases(user, text);
  const command = await resolveUserCommand(user, alias.resolvedText);

  const policyBlock = await blockedByEmmaPolicy(user, command);
  if (policyBlock) return res.status(403).json({
    intent: command.intent,
    interpreted: command.entities,
    ok: false,
    error: "EMMA_CAPABILITY_DISABLED",
    message: policyBlock.message,
    capabilityId: policyBlock.capabilityId,
  });

  const response = await dispatchParsedCommand(user, command);
  const uiAction = response.uiAction
    ? await publishVoiceUiAction(user, response.intent, response.uiAction)
    : undefined;

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: {
      text: auditText(command, text),
      inputMethod: input_method,
      resolvedText: auditText(command, alias.resolvedText),
      appliedAliases: alias.appliedRules,
    },
    dataAfter: { interpreted: auditInterpreted(command, response.interpreted), uiAction },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });

  res.status(response.httpStatus).json({ ...response, uiAction, appliedAliases: alias.appliedRules });
});
