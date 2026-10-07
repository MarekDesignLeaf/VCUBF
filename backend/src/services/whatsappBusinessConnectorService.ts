import { Prisma, type CommunicationIntake } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  configuredWhatsAppPhoneNumberId,
  parseWhatsAppWebhook,
  sendWhatsAppText,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  WhatsAppBusinessAdapterError,
  type WhatsAppInboundMessage,
} from "../connectors/whatsappBusinessAdapter.js";
import {
  DISCONNECT_WHATSAPP_SOURCE_ACTION,
  RECEIVE_WHATSAPP_MESSAGE_ACTION,
  REPLY_WHATSAPP_MESSAGE_ACTION,
  SEND_WHATSAPP_MESSAGE_ACTION,
  SYNC_WHATSAPP_CONTACTS_ACTION,
} from "../lib/actionContracts.js";
import { recordAudit } from "../lib/audit.js";
import { recentAuditedSend, recentReplyOrAudited, repeatNote, replyFingerprint, sendFingerprint } from "../lib/repeatedSend.js";
import { isValidPhoneNumberFormat, normalizePhone, phoneNumberSchema } from "../lib/contactNormalization.js";
import type { AuthedUser } from "../middleware/auth.js";
import { fail, ok, type ServiceResult } from "./result.js";
import { TranslationUnavailable, translateOutgoingMessage, type OutgoingTranslation } from "./translationService.js";

export const sendWhatsAppMessageSchema = z.object({
  to: phoneNumberSchema,
  body: z.string().trim().min(1).max(4096),
  /** Dictate in one language, send in another: "en-GB", "English", "anglicky". */
  send_in: z.string().trim().min(1).max(40).optional(),
  confirmed: z.boolean().optional(),
}).strict();
export const replyWhatsAppMessageSchema = z.object({
  /** The exact received message, as returned by a preview (confirmInput). */
  intake_id: z.string().uuid().optional(),
  /** Sender name or number as spoken, words from the message, or "last". */
  sender_or_message: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(4096),
  /** Language the reply is sent in. English unless another one is named. */
  send_in: z.string().trim().min(1).max(40).optional(),
  confirmed: z.boolean().optional(),
}).strict();
export const disconnectWhatsAppSchema = z.object({ confirmed: z.boolean().optional() }).strict();
const externalContactQuerySchema = z.object({
  active_only: z.enum(["true", "false"]).optional(),
  importable_only: z.enum(["true", "false"]).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

type WhatsAppContactSyncOutcome = "created" | "linked" | "already_synced" | "needs_review" | "invalid";
type WhatsAppContactSource = { id: string; companyId: string; createdBy: string | null };
interface WhatsAppContactSyncCounts {
  createdCount: number;
  linkedCount: number;
  alreadySyncedCount: number;
  awaitingReviewCount: number;
  skippedInvalidCount: number;
}

function emptyContactSyncCounts(): WhatsAppContactSyncCounts {
  return { createdCount: 0, linkedCount: 0, alreadySyncedCount: 0, awaitingReviewCount: 0, skippedInvalidCount: 0 };
}

function addContactSyncOutcome(counts: WhatsAppContactSyncCounts, outcome: WhatsAppContactSyncOutcome) {
  if (outcome === "created") counts.createdCount += 1;
  else if (outcome === "linked") counts.linkedCount += 1;
  else if (outcome === "already_synced") counts.alreadySyncedCount += 1;
  else if (outcome === "needs_review") counts.awaitingReviewCount += 1;
  else counts.skippedInvalidCount += 1;
}

function whatsappExternalResourceName(from: string) {
  const waId = from.replace(/\D/g, "");
  return waId.length > 0 && waId.length <= 40 ? "wa_id:" + waId : null;
}

async function syncInboundWhatsAppContact(
  source: WhatsAppContactSource,
  message: WhatsAppInboundMessage
): Promise<WhatsAppContactSyncOutcome> {
  const externalResourceName = whatsappExternalResourceName(message.from);
  if (!externalResourceName) return "invalid";

  const senderPhone = normalizePhone(message.from);
  const sourceReference = "whatsapp:" + source.id + ":" + externalResourceName;
  const syncedAt = new Date();
  let lastError: unknown;

  // The CRM has no global phone uniqueness constraint because legitimate
  // shared office numbers exist. Serializable retries keep concurrent webhook
  // deliveries from creating duplicate contacts for the same new sender.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const external = await tx.externalContact.upsert({
          where: {
            companyId_connectorSourceId_externalResourceName: {
              companyId: source.companyId,
              connectorSourceId: source.id,
              externalResourceName,
            },
          },
          update: {
            sourceEtag: message.id,
            ...(message.senderName ? { displayName: message.senderName } : {}),
            ...(senderPhone ? { phone: senderPhone } : {}),
            isDeleted: false,
            syncedAt,
          },
          create: {
            companyId: source.companyId,
            connectorSourceId: source.id,
            externalResourceName,
            sourceEtag: message.id,
            displayName: message.senderName,
            phone: senderPhone ?? message.from,
            syncedAt,
          },
        });

        // Preserve the source evidence even if Meta's sender number cannot be
        // validated as a real phone number. Such a record never becomes CRM data.
        if (!senderPhone) return "invalid";

        if (external.importedContactId) {
          const linkedContact = await tx.contact.findFirst({
            where: { id: external.importedContactId, companyId: source.companyId, isActive: true },
            select: { id: true },
          });
          if (linkedContact) return "already_synced";
          await tx.externalContact.update({ where: { id: external.id }, data: { importedContactId: null } });
        }

        const candidates = await tx.contact.findMany({
          where: {
            companyId: source.companyId,
            isActive: true,
            OR: [{ sourceReference }, { phone: { not: null } }],
          },
          select: { id: true, phone: true, sourceReference: true },
        });
        const matches = candidates.filter((contact) =>
          contact.sourceReference === sourceReference || normalizePhone(contact.phone) === senderPhone
        );

        // Linking exactly one existing contact is safe. More than one match is
        // deliberately left for a human to resolve; existing CRM data is never
        // overwritten with provider profile data.
        if (matches.length === 1) {
          await tx.externalContact.update({ where: { id: external.id }, data: { importedContactId: matches[0].id } });
          return "linked";
        }
        if (matches.length > 1) return "needs_review";

        const created = await tx.contact.create({
          data: {
            companyId: source.companyId,
            displayName: message.senderName ?? "WhatsApp " + senderPhone,
            phone: senderPhone,
            preferredChannel: "whatsapp",
            source: "whatsapp_business",
            sourceReference,
            createdBy: source.createdBy,
          },
        });
        await tx.externalContact.update({ where: { id: external.id }, data: { importedContactId: created.id } });
        return "created";
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      lastError = error;
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError
        && (error.code === "P2034" || error.code === "P2002");
      if (!retryable || attempt === 2) throw error;
    }
  }
  throw lastError ?? new Error("WHATSAPP_CONTACT_SYNC_FAILED");
}

function providerResult(error: unknown): ServiceResult<never> {
  if (error instanceof WhatsAppBusinessAdapterError) {
    const status = error.code === "RATE_LIMITED"
      ? 429
      : error.code === "CONNECTOR_CONFIGURATION_MISSING" || error.code === "PROVIDER_UNAVAILABLE"
        ? 503
        : error.code === "WEBHOOK_SIGNATURE_INVALID"
          ? 401
          : error.code === "WEBHOOK_VERIFICATION_FAILED"
            ? 403
            : error.code === "PROVIDER_RESPONSE_INVALID"
              ? 502
              : 409;
    return fail(status, error.code, error.message);
  }
  return fail(500, "CONNECTOR_INTERNAL_ERROR");
}

export function verifyWebhookChallenge(query: unknown): ServiceResult<string> {
  const values = query && typeof query === "object" ? query as Record<string, unknown> : {};
  try {
    const challenge = verifyWhatsAppWebhookChallenge({
      mode: typeof values["hub.mode"] === "string" ? values["hub.mode"] : undefined,
      token: typeof values["hub.verify_token"] === "string" ? values["hub.verify_token"] : undefined,
      challenge: typeof values["hub.challenge"] === "string" ? values["hub.challenge"] : undefined,
    });
    return ok(200, challenge);
  } catch (error) {
    return providerResult(error);
  }
}

export async function receiveWebhook(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  payload: unknown
): Promise<ServiceResult<unknown>> {
  try {
    if (!rawBody) throw new WhatsAppBusinessAdapterError("WEBHOOK_SIGNATURE_INVALID");
    verifyWhatsAppWebhookSignature(rawBody, signature);
    const parsed = parseWhatsAppWebhook(payload);
    const phoneNumberId = configuredWhatsAppPhoneNumberId();
    const messages = parsed.messages.filter((message) => message.phoneNumberId === phoneNumberId);
    const source = await prisma.connectorSource.findFirst({
      where: { connectorKey: "whatsapp_business", isEnabled: true, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!source) {
      return ok(200, {
        accepted: true,
        importedCount: 0,
        duplicateCount: 0,
        statusCount: parsed.statuses.length,
        contactSync: emptyContactSyncCounts(),
      });
    }

    const importedIntakeIds: string[] = [];
    let duplicateCount = 0;
    const contactSync = emptyContactSyncCounts();
    for (const message of messages) {
      const senderPhone = normalizePhone(message.from);
      addContactSyncOutcome(contactSync, await syncInboundWhatsAppContact(source, message));
      if (!senderPhone) continue;
      const existing = await prisma.communicationIntake.findUnique({
        where: {
          companyId_connectorSourceId_externalMessageId: {
            companyId: source.companyId,
            connectorSourceId: source.id,
            externalMessageId: message.id,
          },
        },
        select: { id: true },
      });
      if (existing) {
        duplicateCount += 1;
        continue;
      }
      const intake = await prisma.communicationIntake.upsert({
        where: {
          companyId_connectorSourceId_externalMessageId: {
            companyId: source.companyId,
            connectorSourceId: source.id,
            externalMessageId: message.id,
          },
        },
        update: {},
        create: {
          companyId: source.companyId,
          connectorSourceId: source.id,
          externalMessageId: message.id,
          channel: "whatsapp",
          senderName: message.senderName,
          senderPhone,
          messageText: message.messageText,
          receivedAt: message.receivedAt,
          sourceReference: `whatsapp:${phoneNumberId}:${message.id}`,
          createdBy: source.createdBy,
        },
      });
      importedIntakeIds.push(intake.id);
    }
    await prisma.connectorSource.update({
      where: { id: source.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: "success", lastErrorCode: null },
    });
    await recordAudit({
      companyId: source.companyId,
      userId: source.createdBy,
      actionName: RECEIVE_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId: source.id, signedWebhook: true, messageCount: messages.length, statusCount: parsed.statuses.length },
      dataAfter: { importedCount: importedIntakeIds.length, duplicateCount, importedIntakeIds, contactSync },
      riskLevel: RECEIVE_WHATSAPP_MESSAGE_ACTION.riskLevel,
      result: "success",
    });
    if (messages.length > 0) {
      await recordAudit({
        companyId: source.companyId,
        userId: source.createdBy,
        actionName: SYNC_WHATSAPP_CONTACTS_ACTION.actionName,
        inputPayload: { sourceId: source.id, signedWebhook: true, messageCount: messages.length },
        dataAfter: contactSync,
        riskLevel: SYNC_WHATSAPP_CONTACTS_ACTION.riskLevel,
        result: "success",
      });
    }
    return ok(200, {
      accepted: true,
      importedCount: importedIntakeIds.length,
      duplicateCount,
      statusCount: parsed.statuses.length,
      contactSync,
    });
  } catch (error) {
    return providerResult(error);
  }
}

export async function listWhatsAppContacts(
  user: AuthedUser,
  sourceId: string,
  rawQuery: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = externalContactQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business" },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");

  const where: Prisma.ExternalContactWhereInput = {
    companyId: user.companyId,
    connectorSourceId: source.id,
    ...(parsed.data.active_only === "true" ? { isDeleted: false } : {}),
    ...(parsed.data.importable_only === "true" ? { isDeleted: false, phone: { not: null } } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.externalContact.findMany({
      where,
      orderBy: [{ displayName: "asc" }, { createdAt: "asc" }],
      skip: parsed.data.offset,
      take: parsed.data.limit,
    }),
    prisma.externalContact.count({ where }),
  ]);
  return ok(200, {
    items: items.map((item) => {
      const phoneValid = !item.phone || isValidPhoneNumberFormat(item.phone);
      return { ...item, phoneValid, importable: !item.isDeleted && Boolean(item.phone) && phoneValid };
    }),
    total,
    offset: parsed.data.offset,
    limit: parsed.data.limit,
  });
}

export async function sendWhatsAppMessage(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = sendWhatsAppMessageSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled) return fail(409, "CONNECTOR_NOT_ENABLED");
  if (!source.configuredScopes.includes("send:messages")) return fail(409, "CONNECTOR_SCOPE_REQUIRED");
  // Dictated in one language, sent in another. The translation is made now,
  // before approval, so the person approves the words that will actually leave
  // the building. On the confirmed call there is nothing left to translate: the
  // approved text IS the message, and translating again could produce something
  // nobody read (section 41).
  let body = parsed.data.body;
  let translation: OutgoingTranslation | undefined;
  if (parsed.data.send_in) {
    if (parsed.data.confirmed) {
      return fail(400, "TRANSLATION_AFTER_APPROVAL", "Confirm the message that was reviewed; it is already in the language it will be sent in.");
    }
    try {
      translation = await translateOutgoingMessage({ body }, parsed.data.send_in);
      body = translation.body;
    } catch (error) {
      if (error instanceof TranslationUnavailable) return fail(503, error.reason, error.message);
      throw error;
    }
  }
  // The review says when the same text went to the same number shortly before.
  const fingerprint = sendFingerprint({ recipients: [parsed.data.to.replace(/\D/g, "")], body });
  const repeat = parsed.data.confirmed ? null : await recentAuditedSend(user.companyId, SEND_WHATSAPP_MESSAGE_ACTION.actionName, fingerprint);
  const preview = {
    sourceId, provider: "whatsapp_business", to: parsed.data.to, body,
    ...(translation ? { sentIn: translation.languageLabel, dictated: translation.original.body } : {}),
    ...repeatNote(repeat),
  };
  if (!parsed.data.confirmed) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: false, recipientLength: parsed.data.to.length, bodyLength: parsed.data.body.length },
      riskLevel: SEND_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review the final WhatsApp recipient and message, then confirm sending.", {
      preview,
      // What confirmation must send: the reviewed operation, not the sentence
      // that asked for it.
      confirmInput: { to: parsed.data.to, body },
    });
  }
  try {
    const sent = await sendWhatsAppText({ to: parsed.data.to, body });
    const result = { sourceId, messageId: sent.messageId, sentAt: new Date() };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: true, recipientLength: parsed.data.to.length, bodyLength: parsed.data.body.length },
      dataAfter: { ...result, contentFingerprint: fingerprint },
      riskLevel: SEND_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerResult(error);
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: SEND_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: { sourceId, confirmed: true, recipientLength: parsed.data.to.length, bodyLength: parsed.data.body.length },
      riskLevel: SEND_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "error",
      errorMessage: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error,
    });
    return result;
  }
}

// Replies leave in English unless the person names another language: the
// owner dictates in Czech, his customers read English.
const DEFAULT_REPLY_LANGUAGE = "en-GB";
// WhatsApp accepts a free-form message only within 24 hours of the customer's
// last message to the business. Later contact needs an approved template,
// which this connector does not send, so the reply is refused up front rather
// than failing at Meta after the person has approved it.
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LATEST_WORDS = new Set(["last", "latest", "newest", "recent", "posledni", "nejnovejsi", "ostatni", "ostatnia", "najnowsza"]);

function plainText(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

function digitsOnly(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

type ReplyTarget = CommunicationIntake & { senderPhone: string; externalMessageId: string };

function replyable(intake: CommunicationIntake): intake is ReplyTarget {
  return Boolean(intake.senderPhone && intake.externalMessageId);
}

/**
 * Finds the received WhatsApp message being answered. A sender reference picks
 * that person's most recent message; "last" picks the most recent message from
 * anyone; otherwise words from the message itself are matched. A reference that
 * fits more than one sender is refused rather than guessed.
 */
async function whatsAppReplyTarget(
  user: AuthedUser,
  input: { intake_id?: string; sender_or_message?: string }
): Promise<ServiceResult<ReplyTarget>> {
  if (input.intake_id) {
    const intake = await prisma.communicationIntake.findFirst({
      where: { id: input.intake_id, companyId: user.companyId, channel: "whatsapp" },
    });
    return intake && replyable(intake) ? ok(200, intake) : fail(404, "WHATSAPP_MESSAGE_NOT_FOUND", "That WhatsApp message was not found.");
  }
  const received = (await prisma.communicationIntake.findMany({
    where: { companyId: user.companyId, channel: "whatsapp", senderPhone: { not: null }, externalMessageId: { not: null } },
    orderBy: { receivedAt: "desc" },
    take: 500,
  })).filter(replyable);
  if (!received.length) return fail(404, "WHATSAPP_MESSAGE_NOT_FOUND", "There is no received WhatsApp message to reply to.");

  const needle = plainText(input.sender_or_message);
  if (!needle) return ok(200, received[0]);
  const needleWords = needle.split(" ");
  const needleDigits = digitsOnly(needle);
  const bySender = received.filter((intake) => {
    if (needleDigits.length >= 6 && digitsOnly(intake.senderPhone).endsWith(needleDigits.slice(-9))) return true;
    const name = plainText(intake.senderName);
    if (!name) return false;
    if (name === needle || (needle.length >= 2 && name.includes(needle))) return true;
    return name.split(" ").some((word) => word.length >= 3 && needleWords.includes(word));
  });
  const wantsLatest = needleWords.some((word) => LATEST_WORDS.has(word));
  const byText = needle.length >= 4 ? received.filter((intake) => plainText(intake.messageText).includes(needle)) : [];
  const matches = bySender.length ? bySender : wantsLatest ? [received[0]] : byText;
  if (!matches.length) return fail(404, "WHATSAPP_MESSAGE_NOT_FOUND", `No received WhatsApp message matches '${input.sender_or_message}'.`);
  const senders = [...new Set(matches.map((intake) => intake.senderPhone))];
  if (senders.length > 1) {
    const names = [...new Set(matches.map((intake) => intake.senderName ?? intake.senderPhone))].slice(0, 5);
    return fail(409, "AMBIGUOUS_REFERENCE", `More than one WhatsApp sender matches '${input.sender_or_message}': ${names.join(", ")}.`, { candidates: names });
  }
  return ok(200, matches[0]);
}

async function replyWindowOpen(user: AuthedUser, senderPhone: string) {
  const latest = await prisma.communicationIntake.findFirst({
    where: { companyId: user.companyId, channel: "whatsapp", senderPhone },
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true },
  });
  return Boolean(latest && Date.now() - latest.receivedAt.getTime() <= REPLY_WINDOW_MS);
}

function windowClosed() {
  return fail(409, "WHATSAPP_REPLY_WINDOW_CLOSED", "This customer last wrote more than 24 hours ago. WhatsApp then accepts only approved template messages, which Secretary does not send yet. Call or email them instead.");
}

export async function replyToWhatsAppMessage(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = replyWhatsAppMessageSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  if (!source.isEnabled) return fail(409, "CONNECTOR_NOT_ENABLED");
  if (!source.configuredScopes.includes("send:messages")) return fail(409, "CONNECTOR_SCOPE_REQUIRED");
  if (parsed.data.confirmed && !parsed.data.intake_id) {
    return fail(400, "VALIDATION_FAILED", "Confirm the reviewed reply; it names the exact message being answered.");
  }
  if (parsed.data.confirmed && parsed.data.send_in) {
    return fail(400, "TRANSLATION_AFTER_APPROVAL", "Confirm the reply that was reviewed; it is already in the language it will be sent in.");
  }
  const target = await whatsAppReplyTarget(user, parsed.data);
  if (!target.ok) return target;
  const intake = target.data;
  const auditInput = (confirmed: boolean) => ({
    sourceId, intakeId: intake.id, confirmed, bodyLength: parsed.data.body.length,
  });
  if (!await replyWindowOpen(user, intake.senderPhone)) {
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: REPLY_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: auditInput(Boolean(parsed.data.confirmed)),
      riskLevel: REPLY_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "WHATSAPP_REPLY_WINDOW_CLOSED",
    });
    return windowClosed();
  }

  if (!parsed.data.confirmed) {
    // Translated now, before approval, so the person approves the words that
    // will actually be sent (section 41).
    let translation: OutgoingTranslation;
    try {
      translation = await translateOutgoingMessage({ body: parsed.data.body }, parsed.data.send_in ?? DEFAULT_REPLY_LANGUAGE);
    } catch (error) {
      if (error instanceof TranslationUnavailable) return fail(503, error.reason, error.message);
      throw error;
    }
    const preview = {
      sourceId,
      provider: "whatsapp_business",
      intakeId: intake.id,
      to: intake.senderPhone,
      recipientName: intake.senderName,
      inReplyTo: { receivedAt: intake.receivedAt, text: intake.messageText.slice(0, 500) },
      body: translation.body,
      sentIn: translation.languageLabel,
      dictated: translation.original.body,
      // The same reply to this message shortly before is said in the review.
      ...repeatNote(await recentReplyOrAudited(user.companyId, REPLY_WHATSAPP_MESSAGE_ACTION.actionName, intake, translation.body)),
    };
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: REPLY_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: auditInput(false),
      riskLevel: REPLY_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      result: "rejected",
      errorMessage: "CONFIRMATION_REQUIRED",
    });
    return fail(409, "CONFIRMATION_REQUIRED", "Review who the reply goes to, the message it answers and the final text, then confirm sending.", {
      preview,
      // Confirmation sends exactly this: the reviewed text to the sender of
      // this one message. Nothing in it can be re-resolved to someone else.
      confirmInput: { intake_id: intake.id, body: translation.body },
    });
  }

  try {
    const sent = await sendWhatsAppText({ to: intake.senderPhone, body: parsed.data.body, replyToMessageId: intake.externalMessageId });
    const result = { sourceId, intakeId: intake.id, to: intake.senderPhone, messageId: sent.messageId, sentAt: new Date() };
    // The reply is kept with the message it answers, so the history shows it
    // was answered, when and by whom.
    const metadata = intake.sourceMetadata && typeof intake.sourceMetadata === "object" && !Array.isArray(intake.sourceMetadata)
      ? intake.sourceMetadata as Record<string, unknown>
      : {};
    const replies = Array.isArray(metadata.replies) ? metadata.replies : [];
    try {
      await prisma.communicationIntake.update({
        where: { id: intake.id },
        data: {
          sourceMetadata: {
            ...metadata,
            replies: [...replies, { messageId: sent.messageId, sentAt: result.sentAt.toISOString(), sentBy: user.id, body: parsed.data.body }],
          } as Prisma.InputJsonValue,
        },
      });
    } catch {
      // The reply has already left. A failed note on the intake must not make
      // a sent message look unsent and invite a second send; the audit below
      // still records it.
    }
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: REPLY_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: auditInput(true),
      // Lets a later review recognise this reply even if the note above failed.
      dataAfter: { ...result, contentFingerprint: replyFingerprint(intake.id, parsed.data.body) },
      riskLevel: REPLY_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "success",
    });
    return ok(200, result);
  } catch (error) {
    const result = providerResult(error);
    await recordAudit({
      companyId: user.companyId,
      userId: user.id,
      actionName: REPLY_WHATSAPP_MESSAGE_ACTION.actionName,
      inputPayload: auditInput(true),
      riskLevel: REPLY_WHATSAPP_MESSAGE_ACTION.riskLevel,
      confirmationRequired: true,
      confirmed: true,
      result: "error",
      errorMessage: result.ok ? "CONNECTOR_INTERNAL_ERROR" : result.error,
    });
    return result;
  }
}

export async function disconnectWhatsAppSource(
  user: AuthedUser,
  sourceId: string,
  rawInput: unknown
): Promise<ServiceResult<unknown>> {
  const parsed = disconnectWhatsAppSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "VALIDATION_FAILED", parsed.error.message);
  const source = await prisma.connectorSource.findFirst({
    where: { id: sourceId, companyId: user.companyId, connectorKey: "whatsapp_business", isActive: true },
  });
  if (!source) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND");
  const preview = { sourceId, willDisableSource: true, deploymentSecretsRemainConfigured: true };
  if (!parsed.data.confirmed) return fail(409, "CONFIRMATION_REQUIRED", "Confirm local WhatsApp disconnection.", { preview });
  const updated = await prisma.connectorSource.update({
    where: { id: source.id },
    data: { isEnabled: false, connectionStatus: "disconnected", lastErrorCode: null },
  });
  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: DISCONNECT_WHATSAPP_SOURCE_ACTION.actionName,
    inputPayload: { sourceId, confirmed: true },
    dataBefore: { sourceId, isEnabled: source.isEnabled },
    dataAfter: { sourceId, isEnabled: updated.isEnabled, connectionStatus: updated.connectionStatus },
    riskLevel: DISCONNECT_WHATSAPP_SOURCE_ACTION.riskLevel,
    confirmationRequired: true,
    confirmed: true,
    result: "success",
  });
  return ok(200, { sourceId, provider: "whatsapp_business", disconnectedAt: new Date(), providerGrantRevoked: false });
}
