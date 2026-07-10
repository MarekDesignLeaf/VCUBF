import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/permissions.js";
import { recordAudit } from "../../lib/audit.js";
import { EXECUTE_TEXT_COMMAND_ACTION } from "../../lib/actionContracts.js";
import { parseTextCommand, type ParsedCommand } from "../../lib/commandParser.js";
import * as clientService from "../../services/clientService.js";
import * as jobService from "../../services/jobService.js";
import * as leadService from "../../services/leadService.js";
import * as employeeService from "../../services/employeeService.js";
import * as calendarService from "../../services/calendarService.js";
import * as serviceCatalogueService from "../../services/serviceCatalogueService.js";

export const commandRouter = Router();

commandRouter.use(requireAuth);

const commandSchema = z.object({ text: z.string().min(1, "text is required") });

interface CommandResponse {
  intent: ParsedCommand["intent"];
  interpreted: unknown;
  ok: boolean;
  httpStatus: number;
  data?: unknown;
  error?: string;
  message?: string;
}

// POST /command/text — Voice and Text Command Layer entry point.
// Deterministic parse -> Action Engine dispatch -> structured response.
// Every call is audited as execute_text_command in addition to whatever
// underlying Action Contract it dispatches to.
commandRouter.post("/text", requirePermission(EXECUTE_TEXT_COMMAND_ACTION.requiredPermission), async (req, res) => {
  const parsedBody = commandSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "VALIDATION_FAILED", message: parsedBody.error.message });
  }
  const { text } = parsedBody.data;
  const command = parseTextCommand(text);
  const user = req.user!;

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

  await recordAudit({
    companyId: user.companyId,
    userId: user.id,
    actionName: EXECUTE_TEXT_COMMAND_ACTION.actionName,
    interpretedIntent: response.intent,
    inputPayload: { text },
    dataAfter: { interpreted: response.interpreted },
    riskLevel: EXECUTE_TEXT_COMMAND_ACTION.riskLevel,
    confirmationRequired: EXECUTE_TEXT_COMMAND_ACTION.confirmationRequired,
    result: response.ok ? "success" : "error",
    errorMessage: response.ok ? undefined : response.error,
  });

  res.status(response.httpStatus).json(response);
});
