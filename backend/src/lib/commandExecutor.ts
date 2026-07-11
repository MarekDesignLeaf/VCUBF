import type { AuthedUser } from "../middleware/auth.js";
import type { ParsedCommand } from "./commandParser.js";
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
import * as taskService from "../services/taskService.js";

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
}

export async function dispatchParsedCommand(user: AuthedUser, command: ParsedCommand): Promise<CommandResponse> {
  let response: CommandResponse;

  switch (command.intent) {
    case "create_client": {
      const result = await clientService.createClient(user, {
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
        message: result.ok ? undefined : result.message,
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

    case "list_notifications": {
      const data = await notificationService.getAttentionFeed(user);
      response = { intent: command.intent, interpreted: {}, ok: true, httpStatus: 200, data };
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


  return response;
}
