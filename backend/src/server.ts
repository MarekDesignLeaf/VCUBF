import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./modules/auth/routes.js";
import { clientsRouter } from "./modules/crm/clients.js";
import { jobsRouter } from "./modules/crm/jobs.js";
import { leadsRouter } from "./modules/crm/leads.js";
import { auditRouter } from "./modules/audit/routes.js";
import { commandRouter } from "./modules/command/textCommand.js";
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

export function createServer() {
  const app = express();
  // Railway terminates the public connection at one reverse-proxy hop. Trusting
  // exactly that hop keeps req.ip tied to the real client for login throttling
  // without accepting an arbitrary client-supplied forwarding chain.
  app.set("trust proxy", 1);
  const allowedOrigins = (process.env.FRONTEND_URL ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/auth", authRouter);
  app.use("/auth/device", devicePairingRouter);
  app.use("/crm/clients", clientsRouter);
  app.use("/crm/jobs", jobsRouter);
  app.use("/crm/leads", leadsRouter);
  app.use("/audit", auditRouter);
  app.use("/command", commandRouter);
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
    console.error(err);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createServer();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => console.log(`VCUF Secretary backend listening on :${port}`));
}
