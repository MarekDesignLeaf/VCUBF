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

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/auth", authRouter);
  app.use("/crm/clients", clientsRouter);
  app.use("/crm/jobs", jobsRouter);
  app.use("/crm/leads", leadsRouter);
  app.use("/audit", auditRouter);
  app.use("/command", commandRouter);
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
