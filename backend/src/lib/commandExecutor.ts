import type { AuthedUser } from "../middleware/auth.js";
import type { ParsedCommand } from "./commandParser.js";
import { prisma } from "../db.js";
import * as clientService from "../services/clientService.js";
import * as jobService from "../services/jobService.js";
import * as leadService from "../services/leadService.js";
import * as employeeService from "../services/employeeService.js";
import * as calendarService from "../services/calendarService.js";
import * as serviceCatalogueService from "../services/serviceCatalogueService.js";
import * as quoteService from "../services/quoteService.js";
import * as recruitmentService from "../services/recruitmentService.js";
import * as learningService from "../services/learningService.js";
import * as communicationService from "../services/communicationService.js";
import * as notificationService from "../services/notificationService.js";
import * as dataQualityService from "../services/dataQualityService.js";
import * as portfolioService from "../services/portfolioService.js";
import * as memoryModelService from "../services/memoryModelService.js";
import * as assistantMemoryService from "../services/assistantMemoryService.js";
import * as taskService from "../services/taskService.js";
import * as contactService from "../services/contactService.js";
import * as connectorSetupService from "../services/connectorSetupService.js";
import * as voiceGmailService from "../services/voiceGmailService.js";
import * as voiceWhatsAppService from "../services/voiceWhatsAppService.js";
import * as voiceNotificationService from "../services/voiceNotificationService.js";
import * as voicePreferenceService from "../services/voicePreferenceService.js";
import * as googleCalendarConnectorService from "../services/googleCalendarConnectorService.js";
import { buildCommandUiAction, completedVoiceCommandMessage, openingVoiceLabelMessage, openingVoicePageMessage, type CommandUiAction } from "./voiceNavigation.js";
import { getNavigationCatalogue } from "./navigationCatalogue.js";
import { cancelPendingEmmaAction, confirmPendingEmmaAction, executeEmmaAction } from "../services/emmaExecutableActionService.js";

// Action Engine — dispatches a already-parsed command to the matching
// service function(s) and returns a uniform, structured response. This is
// the shared core used by both the Voice/Text Command Layer (POST
// /command/text, one command at a time, with its own audit entry) and the
// Playbook Engine (many commands in sequence, each dispatched through this
// exact same function so a playbook step behaves identically to typing the
// same text by hand — no separate, divergent execution path).
export interface CommandResponse {
  intent: ParsedCommand["intent"];
  interpreted: unknown;
  ok: boolean;
  httpStatus: number;
  data?: unknown;
  error?: string;
  message?: string;
  uiAction?: CommandUiAction;
}

/** The step "faster" and "slower" move by; roughly the smallest audible change. */
const SPEECH_RATE_STEP = 0.15;
const SPEECH_RATE_MIN = 0.5;
const SPEECH_RATE_MAX = 2;

/** As a percentage: "130 percent" is sayable, "1.3" is not. */
function ratePercent(rate: number): number {
  return Math.round(rate * 100);
}

function speechRateMessage(language: string, rate: number, atLimit: "min" | "max" | null): string {
  const percent = ratePercent(rate);
  if (language.slice(0, 2).toLowerCase() === "cs") {
    if (atLimit === "max") return `Rychleji už neumím, jsem na ${percent} procentech z ${ratePercent(SPEECH_RATE_MAX)}.`;
    if (atLimit === "min") return `Pomaleji už neumím, jsem na ${percent} procentech.`;
    return `Mluvím na ${percent} procentech. Rozsah je ${ratePercent(SPEECH_RATE_MIN)} až ${ratePercent(SPEECH_RATE_MAX)}.`;
  }
  if (atLimit === "max") return `That is as fast as I go: ${percent} percent of ${ratePercent(SPEECH_RATE_MAX)}.`;
  if (atLimit === "min") return `That is as slow as I go: ${percent} percent.`;
  return `Speaking at ${percent} percent. The range is ${ratePercent(SPEECH_RATE_MIN)} to ${ratePercent(SPEECH_RATE_MAX)}.`;
}

/**
 * Adjusts how fast she talks and says where that landed.
 *
 * A direction is relative to the current value, because the person asking has no
 * idea what it is. Hitting either end is reported rather than silently ignored,
 * so repeating "faster" does not look broken.
 */
async function setSpeechRate(
  user: AuthedUser,
  entities: { change?: "faster" | "slower" | "normal"; rate?: number },
): Promise<{ ok: boolean; httpStatus: number; data?: unknown; error?: string; message: string }> {
  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { voiceSpeechRate: true, voiceWakeWord: true, voiceContinuous: true, voiceLanguage: true },
  });
  if (!current) return { ok: false, httpStatus: 404, error: "USER_NOT_FOUND", message: "User not found." };

  const now = current.voiceSpeechRate;
  const wanted = entities.rate !== undefined
    ? entities.rate
    : entities.change === "faster" ? now + SPEECH_RATE_STEP
    : entities.change === "slower" ? now - SPEECH_RATE_STEP
    : 1;

  const clamped = Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, Number(wanted.toFixed(2))));
  const atLimit = clamped >= SPEECH_RATE_MAX && wanted > SPEECH_RATE_MAX ? "max" as const
    : clamped <= SPEECH_RATE_MIN && wanted < SPEECH_RATE_MIN ? "min" as const
    : null;

  const result = await voicePreferenceService.updateVoicePreferences(user, {
    wake_word: current.voiceWakeWord,
    continuous_listening: current.voiceContinuous,
    language: current.voiceLanguage as never,
    speech_rate: clamped,
  });
  if (!result.ok) {
    return { ok: false, httpStatus: result.httpStatus, error: result.error, message: result.message ?? "Could not change the speaking speed." };
  }

  return {
    ok: true,
    httpStatus: 200,
    data: { voiceSpeechRate: clamped, percent: ratePercent(clamped), min: SPEECH_RATE_MIN, max: SPEECH_RATE_MAX },
    message: speechRateMessage(current.voiceLanguage, clamped, atLimit),
  };
}

/** What each connector is called when spoken about. */
const CONNECTOR_LABELS: Record<string, { cs: string; en: string }> = {
  gmail: { cs: "Gmail", en: "Gmail" },
  google_contacts: { cs: "Kontakty Google", en: "Google Contacts" },
  google_calendar: { cs: "Kalendář Google", en: "Google Calendar" },
  google_drive: { cs: "Disk Google", en: "Google Drive" },
  google_photos: { cs: "Fotky Google", en: "Google Photos" },
  whatsapp: { cs: "WhatsApp", en: "WhatsApp" },
};

/**
 * Why a connector did not sync, in a sentence the user can act on.
 *
 * "1 connector needing attention" hides the only useful part. Naming the
 * connector and the reason turns a dead end into a ten-second fix.
 */
function connectorProblem(key: string, status: string, czech: boolean): string {
  const label = CONNECTOR_LABELS[key]?.[czech ? "cs" : "en"] ?? key.replaceAll("_", " ");
  if (czech) {
    switch (status) {
      case "not_enabled": return label + " není zapnutý";
      case "not_configured": return label + " není nastavený";
      case "not_connected": return label + " není připojený";
      case "expired": return label + " má prošlé přihlášení";
      default: return label + " hlásí " + status;
    }
  }
  switch (status) {
    case "not_enabled": return label + " is not switched on";
    case "not_configured": return label + " is not set up";
    case "not_connected": return label + " is not connected";
    case "expired": return label + " needs signing in again";
    default: return label + " reports " + status;
  }
}

function connectorSyncMessage(data: unknown, language: string): string {
  const czech = language.slice(0, 2).toLowerCase() === "cs";
  const results = Array.isArray((data as { results?: unknown })?.results)
    ? (data as { results: Array<{ connectorKey?: string; ok?: boolean; status?: string }> }).results
    : [];
  const failed = results.filter((item) => item.ok === false);
  const synced = results.length - failed.length;

  if (failed.length === 0) {
    return czech
      ? (synced ? "Synchronizace hotová, konektorů: " + synced + "." : "Synchronizace hotová.")
      : "Connector sync completed.";
  }

  const problems = failed.map((item) => connectorProblem(item.connectorKey ?? "", item.status ?? "", czech));
  // Say what to do about it, rather than leaving the user to work it out.
  const where = czech ? " Zapnete ho v Konektorech." : " You can turn it on under Connectors.";
  const lead = synced ? (czech ? "Synchronizovala jsem " + synced + ". " : "Synced " + synced + ". ") : "";
  return lead + problems.join(", ") + "." + (failed.length === 1 ? where : "");
}


export async function dispatchParsedCommand(
  user: AuthedUser,
  command: ParsedCommand,
  options: { confirmedWorkflow?: boolean } = {},
): Promise<CommandResponse> {
  let response: CommandResponse;

  switch (command.intent) {
    case "set_speech_rate": {
      const outcome = await setSpeechRate(user, command.entities);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: outcome.ok,
        httpStatus: outcome.httpStatus,
        data: outcome.ok ? outcome.data : undefined,
        error: outcome.ok ? undefined : outcome.error,
        message: outcome.message,
      };
      break;
    }

    case "execute_action": {
      const result = await executeEmmaAction(user, command.entities);
      response = result.ok
        ? {
            intent: command.intent,
            interpreted: command.entities,
            ok: true,
            httpStatus: result.httpStatus,
            data: result.data,
            message: typeof (result.data as { message?: unknown })?.message === "string"
              ? (result.data as { message: string }).message
              : `Completed ${command.entities.action.replaceAll("_", " ")}.`,
          }
        : {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: result.httpStatus,
            error: result.error,
            message: result.message,
            data: result.extra,
          };
      break;
    }
    case "confirm_execute_action":
    case "cancel_execute_action": {
      const result = command.intent === "confirm_execute_action"
        ? await confirmPendingEmmaAction(user)
        : await cancelPendingEmmaAction(user);
      response = result.ok
        ? { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: result.httpStatus, data: result.data,
            message: command.intent === "confirm_execute_action" ? "The reviewed action was completed." : "The reviewed action was cancelled." }
        : { intent: command.intent, interpreted: command.entities, ok: false, httpStatus: result.httpStatus, error: result.error, message: result.message, data: result.extra };
      break;
    }
    case "create_client": {
      const input = {
        display_name: command.entities.display_name,
        email_primary: command.entities.email_primary,
        phone_primary: command.entities.phone_primary,
      };
      // A confirmed playbook has already shown all resolved steps to the
      // operator. Interactive text/voice commands still require their own
      // spoken confirmation before a client record is written.
      const result = options.confirmedWorkflow
        ? await clientService.createClient(user, input, { required: true, confirmed: true })
        : await clientService.prepareVoiceClientCreation(user, input);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : result.extra,
        error: result.ok ? undefined : result.error,
        message: result.ok
          ? options.confirmedWorkflow
            ? `${command.entities.display_name} was created as a client.`
            : (result.data as { message?: string }).message
          : result.message,
      };
      break;
    }

    case "confirm_create_client":
    case "cancel_create_client": {
      const result = command.intent === "confirm_create_client"
        ? await clientService.confirmVoiceClientCreation(user)
        : await clientService.cancelVoiceClientCreation(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : result.extra,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "update_client": {
      const matches = await clientService.findClientsByName(user, command.entities.client_name);
      if (matches.length === 0) {
        response = { intent: command.intent, interpreted: command.entities, ok: false, httpStatus: 404, error: "CLIENT_NOT_FOUND", message: `No active client matches "${command.entities.client_name}".` };
      } else if (matches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple active clients match "${command.entities.client_name}". Say the full name.`,
          data: matches.map((client) => ({ id: client.id, displayName: client.displayName })),
        };
      } else {
        const result = await clientService.updateClient(user, matches[0].id, {
          display_name: command.entities.display_name,
          email_primary: command.entities.email_primary,
          phone_primary: command.entities.phone_primary,
        });
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? `${matches[0].displayName} was updated.` : result.message,
        };
      }
      break;
    }

    case "prepare_archive_client": {
      const result = await clientService.prepareVoiceClientArchive(user, command.entities.client_name);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "confirm_archive_client": {
      const result = await clientService.confirmVoiceClientArchive(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "cancel_archive_client": {
      const result = await clientService.cancelVoiceClientArchive(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "create_contact": {
      const result = await contactService.createContact(user, {
        display_name: command.entities.display_name,
        email: command.entities.email,
        phone: command.entities.phone,
        source: "user_input",
      });
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? `${command.entities.display_name} was added to contacts.` : result.message,
      };
      break;
    }

    case "update_contact": {
      const matches = await contactService.findContactsByName(user, command.entities.contact_name);
      if (matches.length === 0) {
        response = { intent: command.intent, interpreted: command.entities, ok: false, httpStatus: 404, error: "CONTACT_NOT_FOUND", message: `No active contact matches "${command.entities.contact_name}".` };
      } else if (matches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple active contacts match "${command.entities.contact_name}". Say the full name.`,
          data: matches.map((contact) => ({ id: contact.id, displayName: contact.displayName })),
        };
      } else {
        const result = await contactService.updateContact(user, matches[0].id, {
          display_name: command.entities.display_name,
          email: command.entities.email,
          phone: command.entities.phone,
        });
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? `${matches[0].displayName} was updated.` : result.message,
        };
      }
      break;
    }

    case "prepare_archive_contact": {
      const result = await contactService.prepareVoiceContactArchive(user, command.entities.contact_name);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "confirm_archive_contact": {
      const result = await contactService.confirmVoiceContactArchive(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "cancel_archive_contact": {
      const result = await contactService.cancelVoiceContactArchive(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "create_lead": {
      const result = await leadService.createLead(user, {
        name: command.entities.name,
        service_requested: command.entities.service_requested,
        email: command.entities.email,
        phone: command.entities.phone,
      });
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? undefined : result.message,
      };
      break;
    }

    case "create_job": {
      const matches = await leadService.findClientsByName(user, command.entities.client_name);
      if (matches.length === 0) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 404,
          error: "CLIENT_NOT_FOUND",
          message: `No client matching "${command.entities.client_name}".`,
        };
      } else if (matches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple clients match "${command.entities.client_name}" — be more specific.`,
          data: matches.map((c) => ({ id: c.id, displayName: c.displayName })),
        };
      } else {
        const result = await jobService.createJob(user, {
          client_id: matches[0].id,
          job_title: command.entities.job_title,
        });
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? undefined : result.message,
        };
      }
      break;
    }

    case "change_job_status": {
      const jobMatches = await jobService.findJobsByTitle(user, command.entities.job_title);
      if (jobMatches.length === 0) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 404,
          error: "NOT_FOUND",
          message: `No job matching "${command.entities.job_title}".`,
        };
      } else if (jobMatches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple jobs match "${command.entities.job_title}" — be more specific.`,
          data: jobMatches.map((j) => ({ id: j.id, jobTitle: j.jobTitle })),
        };
      } else {
        const statusCode = jobService.resolveStatusWord(command.entities.job_status);
        const result = await jobService.changeJobStatus(user, jobMatches[0].id, { job_status: statusCode });
        response = {
          intent: command.intent,
          interpreted: { ...command.entities, resolved_status: statusCode },
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? undefined : result.message,
        };
      }
      break;
    }

    case "update_lead": {
      const leadMatches = await leadService.findLeadsByName(user, command.entities.lead_name);
      if (leadMatches.length === 0) {
        response = { intent: command.intent, interpreted: command.entities, ok: false, httpStatus: 404, error: "LEAD_NOT_FOUND", message: `No lead matches "${command.entities.lead_name}".` };
      } else if (leadMatches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple leads match "${command.entities.lead_name}". Say the full name.`,
          data: leadMatches.map((lead) => ({ id: lead.id, name: lead.name })),
        };
      } else {
        const result = await leadService.updateLead(user, leadMatches[0].id, {
          name: command.entities.name,
          email: command.entities.email,
          phone: command.entities.phone,
          lead_status: command.entities.lead_status,
        });
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? `${leadMatches[0].name} was updated.` : result.message,
        };
      }
      break;
    }

    case "convert_lead": {
      const leadMatches = await leadService.findLeadsByName(user, command.entities.lead_name);
      if (leadMatches.length === 0) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 404,
          error: "NOT_FOUND",
          message: `No lead matching "${command.entities.lead_name}".`,
        };
      } else if (leadMatches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple leads match "${command.entities.lead_name}" — be more specific.`,
          data: leadMatches.map((l) => ({ id: l.id, name: l.name })),
        };
      } else {
        const result = await leadService.convertLead(user, leadMatches[0].id);
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? undefined : result.message,
        };
      }
      break;
    }

    case "assign_job": {
      const jobMatches = await jobService.findJobsByTitle(user, command.entities.job_title);
      const employeeMatches = await employeeService.findEmployeesByName(user, command.entities.employee_name);
      if (jobMatches.length === 0) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 404,
          error: "NOT_FOUND",
          message: `No job matching "${command.entities.job_title}".`,
        };
      } else if (jobMatches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple jobs match "${command.entities.job_title}" — be more specific.`,
          data: jobMatches.map((j) => ({ id: j.id, jobTitle: j.jobTitle })),
        };
      } else if (employeeMatches.length === 0) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 404,
          error: "EMPLOYEE_NOT_FOUND",
          message: `No employee matching "${command.entities.employee_name}".`,
        };
      } else if (employeeMatches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple employees match "${command.entities.employee_name}" — be more specific.`,
          data: employeeMatches.map((e) => ({ id: e.id, displayName: e.displayName })),
        };
      } else {
        const result = await jobService.assignJob(user, jobMatches[0].id, {
          assigned_user_id: employeeMatches[0].id,
        });
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? undefined : result.message,
        };
      }
      break;
    }

    case "detect_overload": {
      const data = await calendarService.detectUpcomingOverload(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "create_task": {
      let assignedUserId: string | undefined;
      if (command.entities.employee_name) {
        const matches = await employeeService.findEmployeesByName(user, command.entities.employee_name);
        if (matches.length === 0) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 404,
            error: "EMPLOYEE_NOT_FOUND",
            message: `No employee matching "${command.entities.employee_name}".`,
          };
          break;
        }
        if (matches.length > 1) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 409,
            error: "AMBIGUOUS_REFERENCE",
            message: `Multiple employees match "${command.entities.employee_name}" — be more specific.`,
            data: matches.map((employee) => ({ id: employee.id, displayName: employee.displayName })),
          };
          break;
        }
        assignedUserId = matches[0].id;
      }
      const result = await taskService.createTask(user, {
        title: command.entities.title,
        assigned_user_id: assignedUserId,
        due_at: command.entities.due_at,
      });
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? undefined : result.message,
      };
      break;
    }

    case "list_tasks": {
      const data = await taskService.listTasks(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "change_task_status": {
      const tasks = await taskService.listTasks(user);
      const matches = tasks.filter((task) => task.title.toLocaleLowerCase() === command.entities.title.toLocaleLowerCase());
      if (matches.length === 0) {
        response = { intent: command.intent, interpreted: command.entities, ok: false, httpStatus: 404, error: "TASK_NOT_FOUND", message: `No task matching "${command.entities.title}".` };
        break;
      }
      if (matches.length > 1) {
        response = { intent: command.intent, interpreted: command.entities, ok: false, httpStatus: 409, error: "AMBIGUOUS_REFERENCE", message: `Multiple tasks match "${command.entities.title}" — be more specific.` };
        break;
      }
      const result = await taskService.updateTask(user, matches[0].id, { task_status: command.entities.task_status });
      response = { intent: command.intent, interpreted: command.entities, ok: result.ok, httpStatus: result.httpStatus, data: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error, message: result.ok ? undefined : result.message };
      break;
    }

    case "create_service": {
      const result = await serviceCatalogueService.createService(user, {
        name: command.entities.name,
        category: command.entities.category,
      });
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? undefined : result.message,
      };
      break;
    }

    case "list_quotes": {
      if (command.entities.client_name) {
        const matches = await leadService.findClientsByName(user, command.entities.client_name);
        if (matches.length === 0) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 404,
            error: "CLIENT_NOT_FOUND",
            message: `No client matching "${command.entities.client_name}".`,
          };
        } else if (matches.length > 1) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 409,
            error: "AMBIGUOUS_REFERENCE",
            message: `Multiple clients match "${command.entities.client_name}" — be more specific.`,
            data: matches.map((c) => ({ id: c.id, displayName: c.displayName })),
          };
        } else {
          const data = await quoteService.listQuotes(user, { clientId: matches[0].id });
          response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
        }
      } else {
        const data = await quoteService.listQuotes(user, {});
        response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
      }
      break;
    }

    case "list_job_openings": {
      const data = await recruitmentService.listJobOpenings(user, {});
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "create_learning_rule": {
      const result = await learningService.createLearningRule(user, {
        term: command.entities.term,
        meaning: command.entities.meaning,
      });
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? undefined : result.message,
      };
      break;
    }

    case "list_learning_rules": {
      const data = await learningService.listLearningRules(user, {});
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "create_assistant_memory": {
      const result = await assistantMemoryService.createAssistantMemory(user, command.entities);
      const scopeLabel = command.entities.scope === "company" ? "for the company" : "for you";
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok
          ? result.data.duplicate
            ? `I already remember this ${scopeLabel}: ${result.data.content}`
            : `I will remember this ${scopeLabel}: ${result.data.content}`
          : result.message,
      };
      break;
    }

    case "recall_assistant_memory": {
      const data = await assistantMemoryService.recallAssistantMemories(user, command.entities.query);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: true,
        httpStatus: 200,
        data,
        message: data.length
          ? `I remember: ${data.map((memory) => memory.content).join("; ")}`
          : command.entities.query
            ? `I do not have an active memory about ${command.entities.query}.`
            : "I do not have any active persistent memories yet.",
      };
      break;
    }

    case "log_communication": {
      const matches = await leadService.findClientsByName(user, command.entities.client_name);
      if (matches.length === 0) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 404,
          error: "CLIENT_NOT_FOUND",
          message: `No client matching "${command.entities.client_name}".`,
        };
      } else if (matches.length > 1) {
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: false,
          httpStatus: 409,
          error: "AMBIGUOUS_REFERENCE",
          message: `Multiple clients match "${command.entities.client_name}" — be more specific.`,
          data: matches.map((c) => ({ id: c.id, displayName: c.displayName })),
        };
      } else {
        const result = await communicationService.createCommunicationRecord(user, {
          client_id: matches[0].id,
          channel: command.entities.channel,
          direction: command.entities.direction,
          summary: command.entities.summary,
          occurred_at: new Date().toISOString(),
        });
        response = {
          intent: command.intent,
          interpreted: command.entities,
          ok: result.ok,
          httpStatus: result.httpStatus,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
          message: result.ok ? undefined : result.message,
        };
      }
      break;
    }

    case "list_communications": {
      if (command.entities.client_name) {
        const matches = await leadService.findClientsByName(user, command.entities.client_name);
        if (matches.length === 0) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 404,
            error: "CLIENT_NOT_FOUND",
            message: `No client matching "${command.entities.client_name}".`,
          };
        } else if (matches.length > 1) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 409,
            error: "AMBIGUOUS_REFERENCE",
            message: `Multiple clients match "${command.entities.client_name}" — be more specific.`,
            data: matches.map((c) => ({ id: c.id, displayName: c.displayName })),
          };
        } else {
          const data = await communicationService.listCommunicationRecords(user, { clientId: matches[0].id });
          response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
        }
      } else {
        const data = await communicationService.listCommunicationRecords(user, {});
        response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
      }
      break;
    }

    case "log_portfolio_photo": {
      let clientId: string | undefined;
      if (command.entities.client_name) {
        const matches = await leadService.findClientsByName(user, command.entities.client_name);
        if (matches.length === 0) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 404,
            error: "CLIENT_NOT_FOUND",
            message: `No client matching "${command.entities.client_name}".`,
          };
          break;
        } else if (matches.length > 1) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 409,
            error: "AMBIGUOUS_REFERENCE",
            message: `Multiple clients match "${command.entities.client_name}" — be more specific.`,
            data: matches.map((c) => ({ id: c.id, displayName: c.displayName })),
          };
          break;
        }
        clientId = matches[0].id;
      }

      const result = await portfolioService.createPortfolioPhoto(user, {
        client_id: clientId,
        filename: command.entities.filename,
        caption: command.entities.caption,
        // The Voice/Text Command Layer does not yet capture a source word —
        // "other" is a reasonable deterministic default the user can always
        // correct via the form/API, matching the log_communication pattern
        // of inferring a default rather than blocking on a missing field.
        source: command.entities.source ?? "other",
      });
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? undefined : result.message,
      };
      break;
    }

    case "list_portfolio_photos": {
      if (command.entities.client_name) {
        const matches = await leadService.findClientsByName(user, command.entities.client_name);
        if (matches.length === 0) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 404,
            error: "CLIENT_NOT_FOUND",
            message: `No client matching "${command.entities.client_name}".`,
          };
        } else if (matches.length > 1) {
          response = {
            intent: command.intent,
            interpreted: command.entities,
            ok: false,
            httpStatus: 409,
            error: "AMBIGUOUS_REFERENCE",
            message: `Multiple clients match "${command.entities.client_name}" — be more specific.`,
            data: matches.map((c) => ({ id: c.id, displayName: c.displayName })),
          };
        } else {
          const data = await portfolioService.listPortfolioPhotos(user, {
            clientId: matches[0].id,
            usableForMarketing: command.entities.usable_for_marketing,
          });
          response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
        }
      } else {
        const data = await portfolioService.listPortfolioPhotos(user, {
          usableForMarketing: command.entities.usable_for_marketing,
        });
        response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
      }
      break;
    }

    case "list_follow_ups": {
      const data = await communicationService.listFollowUpsDue(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "list_unresolved_enquiries": {
      const since = command.entities.since_days
        ? new Date(Date.now() - command.entities.since_days * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
      const data = await communicationService.listEnquiries(user, {
        resolution: "unresolved",
        ...(since ? { since } : {}),
      });
      response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
      break;
    }

    case "list_notifications": {
      const data = await notificationService.getAttentionFeed(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "prepare_delete_notifications": {
      const result = await voiceNotificationService.prepareVoiceNotificationDeletion(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "confirm_delete_notifications": {
      const result = await voiceNotificationService.confirmVoiceNotificationDeletion(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "cancel_delete_notifications": {
      const result = await voiceNotificationService.cancelVoiceNotificationDeletion(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "list_data_quality": {
      const data = await dataQualityService.getDataQualityReport(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "detect_action_patterns": {
      const data = await memoryModelService.detectRepeatedActionPatterns(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "list_clients": {
      const data = await clientService.listClients(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "list_contacts": {
      const data = await contactService.listContacts(user, { activeOnly: true });
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "list_channel_messages": {
      const data = await communicationService.listEnquiries(user, { resolution: "all", channel: command.entities.channel });
      response = { intent: command.intent, interpreted: command.entities, ok: true, httpStatus: 200, data };
      break;
    }

    case "prepare_gmail_message": {
      const result = await voiceGmailService.prepareVoiceGmailMessage(user, command.entities);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "confirm_gmail_message": {
      const result = await voiceGmailService.confirmVoiceGmailMessage(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "cancel_gmail_message": {
      const result = await voiceGmailService.cancelVoiceGmailMessage(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "list_calendar_events": {
      const result = await googleCalendarConnectorService.listVoiceCalendarAgenda(user, command.entities.period);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "prepare_whatsapp_message": {
      const result = await voiceWhatsAppService.prepareVoiceWhatsAppMessage(user, command.entities);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "confirm_whatsapp_message": {
      const result = await voiceWhatsAppService.confirmVoiceWhatsAppMessage(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "cancel_whatsapp_message": {
      const result = await voiceWhatsAppService.cancelVoiceWhatsAppMessage(user);
      response = {
        intent: command.intent,
        interpreted: {},
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? (result.data as { message?: string }).message : result.message,
      };
      break;
    }

    case "connector_status": {
      const result = await connectorSetupService.connectorSetupStatus(user, command.entities.connector_key);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? "Opening connector status." : result.message,
      };
      break;
    }

    case "setup_connectors": {
      const result = await connectorSetupService.prepareConnectorSetup(user, command.entities.connector_key);
      const created = result.ok ? ((result.data as any)?.created?.length ?? 0) : 0;
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok
          ? `I prepared ${created} new connector source${created === 1 ? "" : "s"}. Opening guided setup now; I will continue each available step and ask only for provider consent or required confirmation.`
          : result.message,
      };
      break;
    }

    case "sync_connectors": {
      const result = await connectorSetupService.syncConnectors(user, command.entities.connector_key);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok
          ? connectorSyncMessage(result.data, user.voiceLanguage)
          : result.message,
      };
      break;
    }

    case "list_jobs": {
      const data = await jobService.listJobs(user, {});
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "list_leads": {
      const data = await leadService.listLeads(user, {});
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
      break;
    }

    case "set_voice_language": {
      const result = await voicePreferenceService.setVoiceLanguage(user, command.entities.language);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: result.ok,
        httpStatus: result.httpStatus,
        data: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error,
        message: result.ok ? result.data.message : result.message,
      };
      break;
    }

    case "describe_menu": {
      const navigation = getNavigationCatalogue(user.permissions, command.entities.section, user.voiceLanguage);
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: true,
        httpStatus: 200,
        message: navigation.readout,
      };
      break;
    }

    case "navigate": {
      response = {
        intent: command.intent,
        interpreted: command.entities,
        ok: true,
        httpStatus: 200,
        message: openingVoicePageMessage(command.entities.page, user.voiceLanguage),
      };
      break;
    }

    default: {
      response = {
        intent: "unrecognized",
        interpreted: {},
        ok: false,
        httpStatus: 422,
        error: "UNSUPPORTED_ACTION",
        message: "Could not understand that command. Try: \"create client Jane Smith, email jane@example.com\".",
      };
    }
  }


  if (response.ok) {
    const isPendingClientPreview = response.intent === "create_client"
      && Boolean((response.data as { confirmationRequired?: unknown } | undefined)?.confirmationRequired);
    response.uiAction = isPendingClientPreview
      ? undefined
      : buildCommandUiAction(response.intent, response.data, response.interpreted, user.voiceLanguage);
    if (!response.message) {
      response.message = response.uiAction?.kind === "navigate"
        ? openingVoiceLabelMessage(response.uiAction.label, user.voiceLanguage)
        : completedVoiceCommandMessage(user.voiceLanguage);
    }
  }
  return response;
}
