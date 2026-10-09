import { Router, raw } from "express";
import { z } from "zod";
import { requireAuth, type AuthedUser } from "../../middleware/auth.js";
import { prisma } from "../../db.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { CANONICAL_COMMAND, isExplicitVoiceLanguageChange, isGmailCancellationPhrase, isGmailConfirmationPhrase, parseTextCommand } from "../../lib/commandParser.js";
import { dispatchParsedCommand, type CommandResponse } from "../../lib/commandExecutor.js";
import { resolveLearningAliases } from "../../services/learningService.js";
import { addressedAs, aliasVocabulary } from "../../services/voiceAliasService.js";
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
import { hasPendingVoiceClientCreation } from "../../services/clientService.js";
import { assistantNameFor } from "../../lib/assistantName.js";
import { acceptedByService, observeShadow, parserOutcomeOf } from "../../agents/shadowAgent.js";
import { isReviewPending, runWithApprovalBinding } from "../../lib/executionEngine.js";
import { agentMayHandle, hasAgentProposalPending, proposeWithAgent } from "../../agents/agentProposal.js";

/**
 * The user's voice language as it is right now.
 *
 * Falls back to the token's value if the row has gone, which only happens
 * mid-deletion; transcribing in a slightly stale language beats failing.
 */
async function currentVoiceLanguage(user: AuthedUser): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { voiceLanguage: true },
  });
  return row?.voiceLanguage ?? user.voiceLanguage;
}

export const commandRouter = Router();

commandRouter.use(requireAuth);

// Exposes the same authoritative tree used in {assistant}'s prompt. It is read-only
// and includes page descendants that are not represented by a sidebar link.
commandRouter.get("/navigation", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), (req, res) => {
  const navigation = getNavigationCatalogue(req.user!.permissions, undefined, req.user!.voiceLanguage);
  res.set("Cache-Control", "no-store");
  return res.json({ title: navigation.title, sections: navigation.sections });
});

const commandSchema = z.object({
  text: z.string().min(1, "text is required"),
  input_method: z.enum(["text", "voice_transcript"]).default("text"),
  /**
   * Approval binding. The review the client displayed last (pendingReview.id
   * of an earlier answer), or null when it displays none. When present, a yes
   * approves exactly that review — never a newer one, never one in another
   * queue — and null approves nothing. Absent (older clients): the newest
   * review is meant, as before.
   */
  review_id: z.string().uuid().nullable().optional(),
});

/** How much conversation goes to the model with each request. */
const HISTORY_TURNS = 6;
const HISTORY_TURN_CHARS = 800;

type HistoryTurn = { role: "user" | "assistant"; content: string };

/**
 * The recent conversation the client sends along, made to fit. It is context,
 * never a command, so it must never be the reason a command is refused: a long
 * answer (a menu read-out, an explanation) used to exceed the 800-character
 * limit, and every following request was then rejected — the user heard the
 * validation error ("too big") instead of an answer. A long turn now keeps its
 * beginning and its end (where the question to the user usually is), only the
 * last six turns are kept, and malformed entries are dropped.
 */
export function normalizeAssistantHistory(value: unknown): HistoryTurn[] {
  if (!Array.isArray(value)) return [];
  const turns = value.flatMap((entry): HistoryTurn[] => {
    if (!entry || typeof entry !== "object") return [];
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return [];
    const text = content.trim();
    if (!text) return [];
    if (text.length <= HISTORY_TURN_CHARS) return [{ role, content: text }];
    const half = Math.floor((HISTORY_TURN_CHARS - 3) / 2);
    return [{ role, content: `${text.slice(0, half)} … ${text.slice(-half)}` }];
  });
  return turns.slice(-HISTORY_TURNS);
}

const assistantSchema = commandSchema.extend({
  language: z.string().min(2).max(20).default("en-GB"),
  history: z.unknown().transform(normalizeAssistantHistory),
});

/**
 * A request the endpoint could not read. The raw validation report is for
 * developers; read aloud it was gibberish ("code too big"), so the answer is a
 * sentence and the details stay in `issues`.
 */
function invalidCommandRequest(error: z.ZodError, language: string) {
  const locale = language.slice(0, 2).toLowerCase();
  const message = locale === "cs"
    ? "Tenhle požadavek jsem nedokázal zpracovat. Řekněte to prosím znovu."
    : locale === "pl"
      ? "Nie udało mi się przetworzyć tej prośby. Powiedz to proszę jeszcze raz."
      : "I could not process that request. Please say it again.";
  return {
    error: "VALIDATION_FAILED",
    message,
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  };
}

const transcriptionQuerySchema = z.object({
  language: z.string().trim().min(2).max(20).default("en-GB"),
  wake_word: z.string().trim().min(1).max(80).default("Hej {assistant}"),
});

type ParsedTextCommand = ReturnType<typeof parseTextCommand>;

/**
 * The command a sentence states. `reader` is the language switched on for
 * what the user said, or CANONICAL_COMMAND for what the language model wrote:
 * a sentence is read only with that language's grammar, so with Czech on a
 * Polish sentence is not understood.
 */
async function resolveUserCommand(user: AuthedUser, text: string, reader: string): Promise<ParsedTextCommand> {
  const parsed = parseTextCommand(text, reader);
  if (parsed.intent !== "unrecognized") return parsed;
  const [clientCreatePending, gmailPending, whatsappPending, notificationDeletionPending, pendingEmmaAction, agentProposalPending] = await Promise.all([
    hasPendingVoiceClientCreation(user),
    hasPendingVoiceGmailMessage(user),
    hasPendingVoiceWhatsAppMessage(user),
    hasPendingVoiceNotificationDeletion(user),
    getPendingEmmaActionName(user),
    hasAgentProposalPending(user),
  ]);
  const pendingActions: Array<{ pending: boolean; confirm: ParsedTextCommand; cancel: ParsedTextCommand }> = [
    {
      pending: clientCreatePending,
      confirm: { intent: "confirm_create_client", entities: {} },
      cancel: { intent: "cancel_create_client", entities: {} },
    },
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
    {
      pending: agentProposalPending,
      confirm: { intent: "confirm_agent_proposal", entities: {} },
      cancel: { intent: "cancel_agent_proposal", entities: {} },
    },
  ];
  const active = pendingActions.filter((candidate) => candidate.pending);
  if (active.length !== 1) return parsed;
  if (isGmailConfirmationPhrase(text, reader)) return active[0].confirm;
  if (isGmailCancellationPhrase(text, reader)) return active[0].cancel;
  return parsed;
}

// Voice actions that carry the text of a message to someone outside. The text
// is kept in the short-lived review and the conversation, never in the audit.
const OUTBOUND_VOICE_ACTIONS = new Set(["send_email", "send_whatsapp", "reply_email", "reply_whatsapp"]);

function outboundMessage(command: ParsedTextCommand) {
  return command.intent === "prepare_gmail_message" || command.intent === "prepare_whatsapp_message"
    || (command.intent === "execute_action" && OUTBOUND_VOICE_ACTIONS.has(command.entities.action));
}

/**
 * A yes refused by approval binding: something is waiting, but not the review
 * this device heard (or it heard none). Each service would answer "no longer
 * waiting", which is not true here, so the answer says what actually happened
 * and what to do: ask for it again, and it will be read out first.
 */
function withUnheardReviewMessage(bound: { result: CommandResponse; refusedUnheard: boolean }, language: string): CommandResponse {
  // Only a refusal is reworded: if another queue's yes went through in the
  // same request, its own answer stands.
  if (!bound.refusedUnheard || bound.result.ok) return bound.result;
  const message = language.startsWith("cs")
    ? "Čeká něco, co jsem vám tady nepřečetl, a tak to neprovedu. Řekněte znovu, co mám připravit, přečtu vám to a pak potvrďte."
    : language.startsWith("pl")
      ? "Czeka coś, czego tu nie przeczytałem, więc tego nie wykonam. Powiedz jeszcze raz, co mam przygotować — przeczytam to, a potem potwierdź."
      : "Something is waiting that I have not read out to you here, so I will not carry it out. Tell me again what to prepare, I will read it out, and then confirm.";
  return { ...bound.result, ok: false, error: "REVIEW_NOT_HEARD", message };
}

/**
 * What the client should remember for its next yes: the review this request
 * put up (its id and expiry); null when the review it remembered is no longer
 * waiting (claimed, cancelled, expired or resolved elsewhere), so a stale id
 * does not refuse every later yes; nothing when its review still waits.
 */
async function pendingReviewField(
  user: AuthedUser,
  expected: string | null | undefined,
  bound: { prepared?: { id: string; expiresAt: Date }; resolvedIds: ReadonlySet<string> },
) {
  if (bound.prepared) return { pendingReview: { id: bound.prepared.id, expiresAt: bound.prepared.expiresAt.toISOString() } };
  if (typeof expected === "string" && (bound.resolvedIds.has(expected) || !(await isReviewPending(user, expected)))) {
    return { pendingReview: null };
  }
  return {};
}

function auditText(command: ParsedTextCommand, value: string | null | undefined) {
  return outboundMessage(command) && value ? "[REDACTED_OUTBOUND_MESSAGE]" : value;
}

function auditAssistantInput(text: string) {
  // A natural-language outbound request may be clarified before it becomes a
  // deterministic command. Keep that message content in the conversation
  // transcript (the user's chosen history), but never copy it into the audit.
  // A reply names no channel ("odpověz Honzovi, že…"), so the verb is enough.
  return /(?:send|write|compose|draft|pošli|posli|odešli|odesli|napiš|napis|wyślij|wyslij|napisz).*?(?:e-?mail|mail|whatsapp)|\b(?:reply|answer|odpověz|odpovez|odpovězte|odpovezte|odpowiedz)\b|voice\s+action\s+(?:send_email|send_whatsapp|reply_email|reply_whatsapp)\b/iu.test(text)
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
      sendingAccountNamed: Boolean(command.entities.from),
    };
  }
  if (command.intent === "prepare_whatsapp_message") {
    return { recipientLength: command.entities.to.length, bodyLength: command.entities.body.length };
  }
  if (outboundMessage(command) && command.intent === "execute_action") {
    const parameters = command.entities.parameters as Record<string, unknown>;
    return {
      action: command.entities.action,
      fields: Object.keys(parameters).filter((key) => key !== "body").sort(),
      bodyLength: typeof parameters.body === "string" ? parameters.body.length : 0,
    };
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
      unsupported: "Požadavku jsem porozuměl, ale tato operace zatím není podporovaná. Zkuste ji prosím říct jako jednu přímou akci.",
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
  if (!["create_client", "confirm_create_client", "cancel_create_client"].includes(response.intent)) return response;
  const interpreted = response.interpreted as { display_name?: string };
  const resultName = typeof (response.data as any)?.displayName === "string" ? (response.data as any).displayName : undefined;
  const name = interpreted.display_name?.trim() || resultName || "client";
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
  if (response.ok && response.intent === "confirm_create_client") return { ...response, message: selected.created };
  if (response.ok && response.intent === "cancel_create_client") {
    const cancelled: Record<string, string> = {
      en: "Client creation was cancelled. Nothing was changed.",
      cs: "Vytvoření klienta bylo zrušeno. Nic se nezměnilo.",
      pl: "Tworzenie klienta zostało anulowane. Nic nie zmieniono.",
      de: "Die Kundenerstellung wurde abgebrochen. Es wurde nichts geändert.",
      fr: "La création du client a été annulée. Rien n’a été modifié.",
      es: "Se canceló la creación del cliente. No se cambió nada.",
      it: "La creazione del cliente è stata annullata. Non è stato modificato nulla.",
    };
    return { ...response, message: cancelled[locale] ?? cancelled.en };
  }
  if (response.ok && response.intent === "create_client") {
    const preview = (response.data as any)?.preview ?? response.interpreted;
    const confirmation: Record<string, string> = {
      en: `Please confirm: create ${preview.display_name}, email ${preview.email_primary}, phone ${preview.phone_primary}? Say yes to create the client or no to cancel.`,
      cs: `Potvrďte prosím: vytvořit klienta ${preview.display_name}, e-mail ${preview.email_primary}, telefon ${preview.phone_primary}? Řekněte ano pro vytvoření nebo ne pro zrušení.`,
      pl: `Potwierdź: utworzyć klienta ${preview.display_name}, e-mail ${preview.email_primary}, telefon ${preview.phone_primary}? Powiedz tak, aby utworzyć, albo nie, aby anulować.`,
    };
    return { ...response, message: confirmation[locale] ?? confirmation.en };
  }
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
      // From the database, not the token: the token is signed at sign-in, so
      // reading the language from it would keep transcribing in the old
      // language until the next sign-in. This way a change — typed or spoken —
      // applies to the very next utterance.
      const language = await currentVoiceLanguage(req.user!);
      const learned = await aliasVocabulary(req.user!.companyId, addressedAs(req.user!));
      const transcription = await transcribeVoiceAudio(audio, language, query.data.wake_word, learned);
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

/**
 * When an answer to the voice assistant must be ready. The Windows companion
 * gives up after eighteen seconds; an agent run that would end later is
 * pointless, so it gets what is left of these sixteen.
 */
const ASSISTANT_ANSWER_DEADLINE_MS = 16_000;

commandRouter.post("/assistant", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const receivedAt = Date.now();
  const parsedBody = assistantSchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json(invalidCommandRequest(parsedBody.error, req.user!.voiceLanguage));
  const { text, input_method, history } = parsedBody.data;
  const user = req.user!;
  // The authenticated user preference is the single language authority.
  // A stale desktop/browser payload must never switch one response back to
  // English while the menu and the rest of {assistant} are using another language.
  const language = user.voiceLanguage;
  const alias = await resolveLearningAliases(user, text);
  let command = await resolveUserCommand(user, alias.resolvedText, language);
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
        assistantName: assistantNameFor(user),
        language,
        history,
        memoryContext,
        behaviorScenario,
      });
    } catch (error) {
      console.error("Voice assistant interpretation failed", error instanceof Error ? error.message : error);
      // The planner uses the same provider: if it is down too, the shadow
      // records a planner error that counts against availability. If the
      // planner works, the run has no reference and is not compared.
      observeShadow({ user, channel: "assistant", language, text: alias.resolvedText, history, actual: { intent: "assistant_unavailable", key: null, accepted: false } });
      return res.status(503).json({
        ok: false,
        kind: "error",
        error: "ASSISTANT_UNAVAILABLE",
        message: assistantServiceMessage(language, "unavailable"),
      });
    }
    if (assistant.kind !== "command" || !assistant.canonical_command) {
      // A multi-step objective goes to the agent where it may act (masterplan
      // F2b): it reads what it needs and answers, or puts up one proposal for
      // one yes. Anywhere else — or if its run fails — the plan is read out
      // as before.
      if (assistant.kind === "plan" && await agentMayHandle(user, language)) {
        const bound = await runWithApprovalBinding(parsedBody.data.review_id, () => proposeWithAgent({
          user,
          language,
          text: alias.resolvedText,
          history,
          deadline: receivedAt + ASSISTANT_ANSWER_DEADLINE_MS,
        }));
        const outcome = bound.result;
        if (outcome.kind !== "fallback") {
          await recordAudit({
            companyId: user.companyId,
            userId: user.id,
            actionName: "interpret_voice_request",
            interpretedIntent: assistant.kind,
            inputPayload: { text: auditAssistantInput(text), inputMethod: input_method },
            dataAfter: { kind: assistant.kind, agent: outcome.kind, ...(outcome.kind === "proposal" ? { fingerprint: outcome.fingerprint } : {}) },
            riskLevel: 0,
            confirmationRequired: false,
            result: "success",
          });
          if (outcome.kind === "answer") {
            return res.json({ ok: true, kind: "reply", actionExecuted: false, message: safeNonActionAssistantMessage(outcome.message, language) });
          }
          return res.status(409).json({
            intent: "agent_proposal",
            interpreted: {},
            ok: false,
            httpStatus: 409,
            error: "CONFIRMATION_REQUIRED",
            message: outcome.message,
            data: { steps: outcome.steps },
            kind: "action",
            assistantMessage: outcome.message,
            ...(await pendingReviewField(user, parsedBody.data.review_id, bound)),
          });
        }
      }
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
      // The agent in shadow sees the same request; nothing it proposes runs.
      // Not a plan: a multi-step objective has no parser reference to agree
      // with, so a shadow run would be paid for and could only count against
      // the agent for proposing the steps it should. Plans are accepted live
      // (F2), through proposals the user approves.
      if (assistant.kind !== "plan") {
        observeShadow({ user, channel: "assistant", language, text: alias.resolvedText, history, actual: { intent: `assistant_${assistant.kind}`, key: null } });
      }
      return res.json({
        ok: true,
        kind: assistant.kind,
        actionExecuted: false,
        message: safeNonActionAssistantMessage(assistant.message, language),
      });
    }
    command = await resolveUserCommand(user, assistant.canonical_command, CANONICAL_COMMAND);
    if (command.intent === "unrecognized") {
      // The user hears "not supported yet" while the command the model
      // actually produced disappears. Recording it is what tells the
      // difference between a capability the product lacks and a capability it
      // has that the canonical parser rejected on a formatting detail.
      await recordAudit({
        companyId: user.companyId,
        userId: user.id,
        actionName: "interpret_voice_request",
        interpretedIntent: "unrecognized",
        inputPayload: { text: auditAssistantInput(text), inputMethod: input_method },
        dataAfter: { kind: assistant.kind, canonicalCommand: auditAssistantInput(assistant.canonical_command) },
        riskLevel: 0,
        confirmationRequired: false,
        result: "error",
        errorMessage: "CANONICAL_COMMAND_NOT_RECOGNISED",
      });
      observeShadow({ user, channel: "assistant", language, text: alias.resolvedText, history, actual: { intent: "unrecognized", key: null } });
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

  const bound = await runWithApprovalBinding(parsedBody.data.review_id, () => dispatchParsedCommand(user, command));
  const response = localizeVoiceClientResponse(withUnheardReviewMessage(bound, language), language);
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
  observeShadow({ user, channel: "assistant", language, text: alias.resolvedText, history, actual: parserOutcomeOf(command, acceptedByService(response)) });
  // Once a command has reached the deterministic action engine, its verified
  // result is the only text {assistant} may show or speak. The language model's
  // interpretation message can be incomplete, malformed, or claim success
  // before validation has run; never let it override the action result.
  return res.status(response.httpStatus).json({
    ...response,
    uiAction,
    kind: "action",
    assistantMessage: response.message,
    appliedAliases: alias.appliedRules,
    ...(await pendingReviewField(user, parsedBody.data.review_id, bound)),
  });
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
    return res.status(400).json(invalidCommandRequest(parsedBody.error, req.user!.voiceLanguage));
  }
  const { text, input_method } = parsedBody.data;
  const user = req.user!;

  const alias = await resolveLearningAliases(user, text);
  const command = await resolveUserCommand(user, alias.resolvedText, user.voiceLanguage);

  const policyBlock = await blockedByEmmaPolicy(user, command);
  if (policyBlock) return res.status(403).json({
    intent: command.intent,
    interpreted: command.entities,
    ok: false,
    error: "EMMA_CAPABILITY_DISABLED",
    message: policyBlock.message,
    capabilityId: policyBlock.capabilityId,
  });

  const bound = await runWithApprovalBinding(parsedBody.data.review_id, () => dispatchParsedCommand(user, command));
  const response = withUnheardReviewMessage(bound, user.voiceLanguage);
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

  observeShadow({ user, channel: "text", language: user.voiceLanguage, text: alias.resolvedText, actual: parserOutcomeOf(command, acceptedByService(response)) });
  res.status(response.httpStatus).json({ ...response, uiAction, appliedAliases: alias.appliedRules, ...(await pendingReviewField(user, parsedBody.data.review_id, bound)) });
});
