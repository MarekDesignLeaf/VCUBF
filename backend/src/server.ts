import "dotenv/config";
// Express 4 does not forward rejected promises from async route handlers to
// the error middleware by itself. Without this patch, a transient database
// outage can terminate the whole local backend instead of returning a safe
// service error and allowing the launcher to recover it.
import "express-async-errors";
import express from "express";
import cors from "cors";
import { authRouter } from "./modules/auth/routes.js";
import { clientsRouter } from "./modules/crm/clients.js";
import { jobsRouter } from "./modules/crm/jobs.js";
import { leadsRouter } from "./modules/crm/leads.js";
import { auditRouter } from "./modules/audit/routes.js";
import { commandRouter } from "./modules/command/textCommand.js";
import { voiceAliasRouter } from "./modules/command/voiceAliases.js";
import { voiceSpeechRouter } from "./modules/command/voiceSpeech.js";
import { voiceMacroRouter } from "./modules/command/voiceMacros.js";
import { employeesRouter } from "./modules/crm/employees.js";
import { calendarRouter } from "./modules/calendar/routes.js";
import { catalogueRouter } from "./modules/catalogue/routes.js";
import { quotesRouter } from "./modules/quotes/routes.js";
import { recruitmentRouter } from "./modules/recruitment/routes.js";
import { playbooksRouter } from "./modules/playbooks/routes.js";
import { learningRouter } from "./modules/learning/routes.js";
import { communicationsRouter } from "./modules/communications/routes.js";
import { notificationsRouter } from "./modules/notifications/routes.js";
import { dataQualityRouter } from "./modules/data-quality/routes.js";
import { portfolioRouter } from "./modules/portfolio/routes.js";
import { memoryModelRouter } from "./modules/memory-model/routes.js";
import { businessContextRouter } from "./modules/business-context/routes.js";
import { websiteAuditsRouter } from "./modules/website-audits/routes.js";
import { websiteContentProposalsRouter } from "./modules/website-content-proposals/routes.js";
import { tasksRouter } from "./modules/tasks/routes.js";
import { contactsRouter } from "./modules/crm/contacts.js";
import { documentsRouter } from "./modules/documents/routes.js";
import { industriesRouter } from "./modules/industries/routes.js";
import { connectorsRouter } from "./modules/connectors/routes.js";
import { metricsRouter } from "./modules/metrics/routes.js";
import { invoicesRouter } from "./modules/invoices/routes.js";
import { devicePairingRouter } from "./modules/auth/devicePairing.js";
import { voiceStateRouter } from "./modules/command/voiceState.js";
import { companyRouter } from "./modules/company/routes.js";
import { startConnectorBackgroundSync } from "./services/connectorBackgroundSyncService.js";
import { ASSISTANT_NAME_TOKEN, assistantNameFor, withAssistantName } from "./lib/assistantName.js";

export function createServer() {
  const app = express();
  // Railway terminates the public connection at one reverse-proxy hop. Trusting
  // exactly that hop keeps req.ip tied to the real client for login throttling
  // without accepting an arbitrary client-supplied forwarding chain.
  app.set("trust proxy", 1);
  const allowedOrigins = [...new Set([
    ...(process.env.FRONTEND_URL ?? "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Capacitor serves the bundled Android application from this fixed secure
    // origin. It is not a wildcard and therefore does not broaden access to
    // arbitrary websites.
    "https://localhost",
    "capacitor://localhost",
  ])];
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json({
    verify: (req, _res, buffer) => {
      const request = req as express.Request;
      if (request.originalUrl.startsWith("/connectors/whatsapp/webhook")) request.rawBody = Buffer.from(buffer);
    },
  }));

  // Interface copy, menu labels and spoken replies hold the assistant's name
  // as {assistant} so one account setting renames it everywhere, in every
  // language, without another pass through the source. The substitution is
  // done once here, on the way out, using the authenticated account's name.
  // Only that token changes, so a client, job or message named after the
  // assistant is returned exactly as it was recorded.
  app.use((req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const payload = JSON.stringify(body);
      if (payload === undefined || !payload.includes(ASSISTANT_NAME_TOKEN)) return sendJson(body);
      return res.type("application/json").send(withAssistantName(payload, assistantNameFor(req.user)));
    };
    next();
  });

  app.get("/health", (_req, res) => res.json({
    status: "ok",
    build: (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local").slice(0, 12),
  }));

  app.use("/auth", authRouter);
  app.use("/auth/device", devicePairingRouter);
  app.use("/company", companyRouter);
  app.use("/crm/clients", clientsRouter);
  app.use("/crm/jobs", jobsRouter);
  app.use("/crm/leads", leadsRouter);
  app.use("/audit", auditRouter);
  app.use("/command", commandRouter);
  app.use("/command", voiceAliasRouter);
  app.use("/command", voiceSpeechRouter);
  app.use("/command", voiceMacroRouter);
  app.use("/command", voiceStateRouter);
  app.use("/crm/employees", employeesRouter);
  app.use("/calendar", calendarRouter);
  app.use("/service-catalogue", catalogueRouter);
  app.use("/quotes", quotesRouter);
  app.use("/recruitment", recruitmentRouter);
  app.use("/playbooks", playbooksRouter);
  app.use("/learning-rules", learningRouter);
  app.use("/communications", communicationsRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/data-quality", dataQualityRouter);
  app.use("/portfolio", portfolioRouter);
  app.use("/memory-model", memoryModelRouter);
  app.use("/business-context", businessContextRouter);
  app.use("/website-audits", websiteAuditsRouter);
  app.use("/website-content-proposals", websiteContentProposalsRouter);
  app.use("/tasks", tasksRouter);
  app.use("/crm/contacts", contactsRouter);
  app.use("/documents", documentsRouter);
  app.use("/industries", industriesRouter);
  app.use("/connectors", connectorsRouter);
  app.use("/metrics", metricsRouter);
  app.use("/invoices", invoicesRouter);

  // Fallback error handler — the system must fail safely, never crash silently.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && typeof err === "object" && "type" in err && err.type === "entity.too.large") {
      return res.status(413).json({ error: "PAYLOAD_TOO_LARGE", message: "The request body is too large." });
    }
    if (err && typeof err === "object" && "code" in err && ["P1001", "P1002", "P2024"].includes(String(err.code))) {
      console.error("Database temporarily unavailable", err);
      return res.status(503).json({ error: "DATABASE_UNAVAILABLE", message: "Secretary is reconnecting to the local database. Please try again in a moment." });
    }
    console.error(err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createServer();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => {
    console.log(`VCUBF Secretary backend listening on :${port}`);
    startConnectorBackgroundSync();
  });
}
