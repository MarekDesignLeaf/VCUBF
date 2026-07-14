import type { AuthedUser } from "../middleware/auth.js";
import { EMMA_EXECUTABLE_ACTIONS, type EmmaExecutableActionName, type EmmaExecutableActionRequest } from "../lib/emmaExecutableActionCatalogue.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { fail, ok, type ServiceResult } from "./result.js";
import * as clientService from "./clientService.js";
import * as jobService from "./jobService.js";
import * as taskService from "./taskService.js";
import * as documentRecordService from "./documentRecordService.js";
import * as businessContextService from "./businessContextService.js";
import * as industryService from "./industryService.js";
import * as serviceCatalogueService from "./serviceCatalogueService.js";
import * as quoteService from "./quoteService.js";
import * as invoiceService from "./invoiceService.js";
import * as jobResourceService from "./jobResourceService.js";
import * as recruitmentService from "./recruitmentService.js";
import * as communicationService from "./communicationService.js";
import * as notificationService from "./notificationService.js";
import * as learningService from "./learningService.js";
import * as assistantMemoryService from "./assistantMemoryService.js";
import * as metricsService from "./metricsService.js";
import * as calendarService from "./calendarService.js";
import * as dataQualityService from "./dataQualityService.js";
import * as capacityService from "./capacityService.js";
import * as portfolioService from "./portfolioService.js";
import * as playbookService from "./playbookService.js";
import * as websiteAuditService from "./websiteAuditService.js";
import * as websiteContentProposalService from "./websiteContentProposalService.js";
import * as activityReferenceService from "./activityReferenceService.js";
import * as employeeService from "./employeeService.js";
import * as connectorService from "./connectorService.js";
import * as gmailConnectorService from "./gmailConnectorService.js";
import * as googleContactsConnectorService from "./googleContactsConnectorService.js";
import * as googleCalendarConnectorService from "./googleCalendarConnectorService.js";
import * as googleDriveConnectorService from "./googleDriveConnectorService.js";
import * as googlePhotosConnectorService from "./googlePhotosConnectorService.js";
import * as whatsappBusinessConnectorService from "./whatsappBusinessConnectorService.js";
import * as emmaBehaviorService from "./emmaBehaviorService.js";
import * as emmaPolicyService from "./emmaPolicyService.js";

type Row = Record<string, any>;

function stringValue(parameters: Record<string, unknown>, key: string): string | undefined {
  const value = parameters[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(parameters: Record<string, unknown>, key: string): number | undefined {
  const value = parameters[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lookup<T extends Row>(items: T[], query: string | undefined, fields: Array<keyof T>, entity: string): ServiceResult<T> {
  if (!query) return fail(400, "VALIDATION_FAILED", `${entity} name is required.`);
  const needle = query.toLocaleLowerCase();
  const exact = items.filter((item) => fields.some((field) => String(item[field] ?? "").toLocaleLowerCase() === needle));
  const matches = exact.length ? exact : items.filter((item) => fields.some((field) => String(item[field] ?? "").toLocaleLowerCase().includes(needle)));
  if (!matches.length) return fail(404, `${entity.toUpperCase()}_NOT_FOUND`, `${entity} '${query}' was not found.`);
  if (matches.length > 1) return fail(409, "AMBIGUOUS_REFERENCE", `More than one ${entity} matches '${query}'. Please use the exact name.`);
  return ok(200, matches[0]);
}

async function clientByName(user: AuthedUser, name: string | undefined) {
  return lookup(await clientService.listClients(user), name, ["displayName"], "client");
}

async function jobByTitle(user: AuthedUser, title: string | undefined) {
  return lookup(await jobService.listJobs(user, {}), title, ["jobTitle"], "job");
}

async function intakeByReference(user: AuthedUser, reference: string | undefined) {
  return lookup(await communicationService.listCommunicationIntakes(user), reference, ["senderName", "senderEmail", "senderPhone", "messageText"], "communication_intake");
}

async function connectorSource(user: AuthedUser, connectorKey: string) {
  const sources = await connectorService.listConnectorSources(user, false);
  const matches = sources.filter((source) => source.connectorKey === connectorKey && source.isActive);
  if (!matches.length) return fail(404, "CONNECTOR_SOURCE_NOT_FOUND", `Set up ${connectorKey} first.`);
  const enabled = matches.filter((source) => source.isEnabled);
  return ok(200, (enabled[0] ?? matches[0]) as Row);
}

function without(parameters: Record<string, unknown>, ...keys: string[]) {
  return Object.fromEntries(Object.entries(parameters).filter(([key]) => !keys.includes(key)));
}

async function executeEmmaActionDirect(
  user: AuthedUser,
  request: EmmaExecutableActionRequest,
  confirmed = false,
): Promise<ServiceResult<unknown>> {
  const p = request.parameters;
  switch (request.action) {
    case "create_document": {
      const clientName = stringValue(p, "client_name");
      const jobTitle = stringValue(p, "job_title");
      const client = clientName ? await clientByName(user, clientName) : undefined;
      if (client && !client.ok) return client;
      const job = jobTitle ? await jobByTitle(user, jobTitle) : undefined;
      if (job && !job.ok) return job;
      return documentRecordService.createDocumentRecord(user, {
        ...without(p, "client_name", "job_title"),
        client_id: client?.data.id,
        job_id: job?.data.id,
      });
    }
    case "archive_document": {
      const item = lookup(await documentRecordService.listDocumentRecords(user), stringValue(p, "document_title"), ["title"], "document");
      return item.ok ? documentRecordService.updateDocumentRecord(user, item.data.id, { is_active: false }) : item;
    }
    case "set_task_status": {
      const item = lookup(await taskService.listTasks(user), stringValue(p, "task_title"), ["title"], "task");
      return item.ok ? taskService.updateTask(user, item.data.id, { task_status: p.task_status }) : item;
    }
    case "create_business_context":
      return businessContextService.createBusinessContextItem(user, p);
    case "archive_business_context": {
      const item = lookup(await businessContextService.listBusinessContextItems(user), stringValue(p, "label"), ["label"], "business_context");
      return item.ok ? businessContextService.updateBusinessContextItem(user, item.data.id, { is_active: false }) : item;
    }
    case "create_industry":
      return industryService.createIndustry(user, p);
    case "archive_industry": {
      const item = lookup(await industryService.listIndustries(user), stringValue(p, "name"), ["name"], "industry");
      return item.ok ? industryService.updateIndustry(user, item.data.id, { is_active: false }) : item;
    }
    case "link_industry_service": {
      const industry = lookup(await industryService.listIndustries(user), stringValue(p, "industry_name"), ["name"], "industry");
      if (!industry.ok) return industry;
      const service = lookup(await serviceCatalogueService.listServices(user), stringValue(p, "service_name"), ["name"], "service");
      return service.ok ? industryService.linkIndustryService(user, industry.data.id, { service_catalogue_item_id: service.data.id, notes: p.notes }) : service;
    }
    case "archive_industry_service_link": {
      const industry = lookup(await industryService.listIndustries(user), stringValue(p, "industry_name"), ["name"], "industry");
      if (!industry.ok) return industry;
      const serviceName = stringValue(p, "service_name");
      const link = lookup(industry.data.serviceLinks ?? [], serviceName, ["serviceCatalogueItem.name" as never], "industry_service_link");
      if (!link.ok) {
        const links = (industry.data.serviceLinks ?? []).filter((candidate: Row) => String(candidate.serviceCatalogueItem?.name ?? "").toLocaleLowerCase().includes((serviceName ?? "").toLocaleLowerCase()));
        if (links.length !== 1) return links.length ? fail(409, "AMBIGUOUS_REFERENCE") : fail(404, "INDUSTRY_SERVICE_LINK_NOT_FOUND");
        return industryService.updateIndustryServiceLink(user, links[0].id, { is_active: false });
      }
      return industryService.updateIndustryServiceLink(user, link.data.id, { is_active: false });
    }
    case "set_service_active": {
      const item = lookup(await serviceCatalogueService.listServices(user), stringValue(p, "service_name"), ["name"], "service");
      return item.ok ? serviceCatalogueService.updateService(user, item.data.id, { is_active: p.is_active }) : item;
    }
    case "create_quote": {
      const client = await clientByName(user, stringValue(p, "client_name"));
      if (!client.ok) return client;
      const jobTitle = stringValue(p, "job_title");
      const job = jobTitle ? await jobByTitle(user, jobTitle) : undefined;
      if (job && !job.ok) return job;
      return quoteService.createQuote(user, { ...without(p, "client_name", "job_title"), client_id: client.data.id, job_id: job?.data.id });
    }
    case "set_quote_status": {
      const item = lookup(await quoteService.listQuotes(user), stringValue(p, "quote_title"), ["title"], "quote");
      return item.ok ? quoteService.changeQuoteStatus(user, item.data.id, { quote_status: p.quote_status }) : item;
    }
    case "update_quote": {
      const item = lookup(await quoteService.listQuotes(user), stringValue(p, "quote_title"), ["title"], "quote");
      return item.ok ? quoteService.updateQuote(user, item.data.id, without(p, "quote_title")) : item;
    }
    case "export_quote_pdf": {
      const item = lookup(await quoteService.listQuotes(user), stringValue(p, "quote_title"), ["title"], "quote");
      return item.ok ? ok(200, { downloadPath: `/quotes/${item.data.id}/pdf`, filename: `quote-${item.data.id}.pdf` }) : item;
    }
    case "create_invoice": {
      const client = await clientByName(user, stringValue(p, "client_name"));
      return client.ok ? invoiceService.createInvoice(user, { ...without(p, "client_name"), client_id: client.data.id }) : client;
    }
    case "issue_invoice": {
      const item = lookup(await invoiceService.listInvoices(user), stringValue(p, "invoice_number"), ["invoiceNumber"], "invoice");
      return item.ok ? invoiceService.changeInvoiceStatus(user, item.data.id, { invoice_status: "issued" }) : item;
    }
    case "record_invoice_payment": {
      const item = lookup(await invoiceService.listInvoices(user), stringValue(p, "invoice_number"), ["invoiceNumber"], "invoice");
      return item.ok ? invoiceService.addPayment(user, item.data.id, { ...without(p, "invoice_number", "confirmed"), paid_at: p.paid_at ?? new Date().toISOString(), confirmed }) : item;
    }
    case "export_invoice_pdf": {
      const item = lookup(await invoiceService.listInvoices(user), stringValue(p, "invoice_number"), ["invoiceNumber"], "invoice");
      return item.ok ? ok(200, { downloadPath: `/invoices/${item.data.id}/pdf`, filename: `invoice-${item.data.invoiceNumber}.pdf` }) : item;
    }
    case "add_job_resource": {
      const job = await jobByTitle(user, stringValue(p, "job_title"));
      return job.ok ? jobResourceService.add(user, job.data.id, without(p, "job_title")) : job;
    }
    case "set_job_resource_status":
    case "set_job_resource_cost": {
      const job = await jobByTitle(user, stringValue(p, "job_title"));
      if (!job.ok) return job;
      const resources = await jobResourceService.list(user, job.data.id);
      if (!resources) return fail(404, "JOB_NOT_FOUND");
      const resource = lookup(resources.items, stringValue(p, "resource_name"), ["name"], "resource");
      return resource.ok ? jobResourceService.change(user, job.data.id, resource.data.id, without(p, "job_title", "resource_name")) : resource;
    }
    case "create_job_opening":
      return recruitmentService.createJobOpening(user, p);
    case "set_job_opening_status": {
      const item = lookup(await recruitmentService.listJobOpenings(user), stringValue(p, "title"), ["title"], "job_opening");
      return item.ok ? recruitmentService.updateJobOpening(user, item.data.id, { opening_status: p.opening_status }) : item;
    }
    case "draft_job_advert": {
      const item = lookup(await recruitmentService.listJobOpenings(user), stringValue(p, "title"), ["title"], "job_opening");
      return item.ok ? recruitmentService.draftJobAdvert(user, item.data.id) : item;
    }
    case "create_candidate": {
      const opening = lookup(await recruitmentService.listJobOpenings(user), stringValue(p, "job_opening_title"), ["title"], "job_opening");
      return opening.ok ? recruitmentService.createCandidate(user, opening.data.id, without(p, "job_opening_title")) : opening;
    }
    case "set_candidate_stage": {
      const candidates = (await recruitmentService.listJobOpenings(user)).flatMap((opening) => opening.candidates);
      const candidate = lookup(candidates, stringValue(p, "candidate_name"), ["name"], "candidate");
      return candidate.ok ? recruitmentService.updateCandidate(user, candidate.data.id, { stage: p.stage }) : candidate;
    }
    case "create_communication_intake":
      return communicationService.createCommunicationIntake(user, { ...p, received_at: p.received_at ?? new Date().toISOString() });
    case "extract_communication_intake": {
      const intake = await intakeByReference(user, stringValue(p, "sender_or_message"));
      return intake.ok ? communicationService.extractCommunicationIntake(user, intake.data.id) : intake;
    }
    case "draft_communication_reply": {
      const intake = await intakeByReference(user, stringValue(p, "sender_or_message"));
      return intake.ok ? communicationService.prepareCommunicationReply(user, intake.data.id) : intake;
    }
    case "set_communication_intake_resolution": {
      const intake = await intakeByReference(user, stringValue(p, "sender_or_message"));
      return intake.ok ? communicationService.updateCommunicationIntakeResolution(user, intake.data.id, { resolution_needed: p.resolution_needed }) : intake;
    }
    case "convert_communication_intake": {
      const intake = await intakeByReference(user, stringValue(p, "sender_or_message"));
      if (!intake.ok) return intake;
      const clientName = stringValue(p, "client_name");
      const client = clientName ? await clientByName(user, clientName) : undefined;
      if (client && !client.ok) return client;
      return communicationService.convertCommunicationIntake(user, intake.data.id, { client_id: client?.data.id, confirmed });
    }
    case "acknowledge_notification":
      return notificationService.acknowledgeNotification(user, p);
    case "unacknowledge_notification": {
      const key = stringValue(p, "notification_key");
      return key ? notificationService.unacknowledgeNotification(user, key) : fail(400, "VALIDATION_FAILED", "notification_key is required.");
    }
    case "archive_learning_rule":
    case "reactivate_learning_rule": {
      const item = lookup(await learningService.listLearningRules(user, { status: undefined }), stringValue(p, "term"), ["term"], "learning_rule");
      return item.ok ? learningService.updateLearningRule(user, item.data.id, { status: request.action === "archive_learning_rule" ? "archived" : "active" }) : item;
    }
    case "archive_memory": {
      const item = lookup(await assistantMemoryService.listAssistantMemories(user, { status: "active" }), stringValue(p, "content"), ["content"], "assistant_memory");
      return item.ok ? assistantMemoryService.archiveAssistantMemory(user, item.data.id) : item;
    }
    case "get_metrics": {
      const parsed = metricsService.metricsQuerySchema.safeParse(p);
      return parsed.success ? ok(200, await metricsService.getMetricsOverview(user, parsed.data)) : fail(400, "VALIDATION_FAILED", parsed.error.message);
    }
    case "suggest_schedule":
      return ok(200, await calendarService.suggestEmployeesForJob(user, {
        estimatedDurationHours: numberValue(p, "estimated_duration_hours") ?? null,
        requiredSkills: Array.isArray(p.required_skills) ? p.required_skills.filter((value): value is string => typeof value === "string") : [],
        weeksAhead: numberValue(p, "weeks_ahead"),
      }));
    case "get_recruitment_recommendation":
      return ok(200, await recruitmentService.getCapacityRecruitmentRecommendation(user, {
        weeksAhead: numberValue(p, "weeks_ahead") ?? 8,
        minimumRepeatedWeeks: numberValue(p, "minimum_repeated_weeks") ?? 3,
      }));
    case "check_capacity": {
      const employee = lookup(await employeeService.listEmployees(user), stringValue(p, "employee_name"), ["displayName"], "employee");
      if (!employee.ok) return employee;
      const reference = stringValue(p, "reference_date");
      const data = await capacityService.computeEmployeeCapacity(user, employee.data.id, reference ? new Date(reference) : new Date());
      return data ? ok(200, data) : fail(404, "EMPLOYEE_NOT_FOUND");
    }
    case "update_communication": {
      const item = lookup(await communicationService.listCommunicationRecords(user), stringValue(p, "communication_summary"), ["summary"], "communication");
      return item.ok ? communicationService.updateCommunicationRecord(user, item.data.id, without(p, "communication_summary")) : item;
    }
    case "update_portfolio_photo": {
      const item = lookup(await portfolioService.listPortfolioPhotos(user), stringValue(p, "filename"), ["filename"], "portfolio_photo");
      return item.ok ? portfolioService.updatePortfolioPhoto(user, item.data.id, without(p, "filename")) : item;
    }
    case "create_playbook":
      return playbookService.createPlaybook(user, p);
    case "update_playbook": {
      const item = lookup(await playbookService.listPlaybooks(user), stringValue(p, "playbook_name"), ["name"], "playbook");
      return item.ok ? playbookService.updatePlaybook(user, item.data.id, without(p, "playbook_name")) : item;
    }
    case "run_playbook": {
      const item = lookup(await playbookService.listPlaybooks(user), stringValue(p, "playbook_name"), ["name"], "playbook");
      return item.ok ? playbookService.runPlaybook(user, item.data.id, { variables: p.variables, confirmed }) : item;
    }
    case "create_website_audit":
      return websiteAuditService.createWebsiteAudit(user, p);
    case "prepare_website_content":
      return websiteContentProposalService.createWebsiteContentProposal(user, p);
    case "decide_website_content": {
      const proposalId = stringValue(p, "proposal_id");
      if (!proposalId) return fail(400, "VALIDATION_FAILED", "proposal_id is required.");
      return websiteContentProposalService.decideWebsiteContentProposal(user, proposalId, { ...without(p, "proposal_id", "confirmed"), confirmed });
    }
    case "list_reference_activities":
      return activityReferenceService.listReferenceActivities(user, p);
    case "activate_reference_activity": {
      const activityCode = stringValue(p, "activity_code");
      return activityCode
        ? activityReferenceService.activateReferenceActivity(user, activityCode, { ...without(p, "activity_code", "confirmed"), confirmed })
        : fail(400, "VALIDATION_FAILED", "activity_code is required.");
    }
    case "start_gmail_oauth":
    case "start_google_contacts_oauth":
    case "start_google_calendar_oauth":
    case "start_google_drive_oauth":
    case "start_google_photos_oauth": {
      const key = request.action.replace(/^start_/, "").replace(/_oauth$/, "");
      const source = await connectorSource(user, key);
      if (!source.ok) return source;
      if (request.action === "start_gmail_oauth") return gmailConnectorService.startGmailOAuth(user, source.data.id);
      if (request.action === "start_google_contacts_oauth") return googleContactsConnectorService.startGoogleContactsOAuth(user, source.data.id);
      if (request.action === "start_google_calendar_oauth") return googleCalendarConnectorService.startGoogleCalendarOAuth(user, source.data.id);
      if (request.action === "start_google_drive_oauth") return googleDriveConnectorService.startGoogleDriveOAuth(user, source.data.id);
      return googlePhotosConnectorService.startGooglePhotosOAuth(user, source.data.id);
    }
    case "sync_gmail": {
      const source = await connectorSource(user, "gmail");
      return source.ok ? gmailConnectorService.syncGmailMessages(user, source.data.id, { max_results: p.max_results ?? 25 }) : source;
    }
    case "sync_google_contacts": {
      const source = await connectorSource(user, "google_contacts");
      return source.ok ? googleContactsConnectorService.syncGoogleContacts(user, source.data.id) : source;
    }
    case "sync_google_calendar": {
      const source = await connectorSource(user, "google_calendar");
      return source.ok ? googleCalendarConnectorService.syncGoogleCalendar(user, source.data.id) : source;
    }
    case "disconnect_gmail":
    case "disconnect_google_contacts":
    case "disconnect_google_calendar":
    case "disconnect_google_drive":
    case "disconnect_google_photos":
    case "disconnect_whatsapp": {
      const key = request.action.replace(/^disconnect_/, "");
      const connectorKey = key === "whatsapp" ? "whatsapp_business" : key;
      const source = await connectorSource(user, connectorKey);
      if (!source.ok) return source;
      const payload = { confirmed };
      if (request.action === "disconnect_gmail") return gmailConnectorService.disconnectGmailSource(user, source.data.id, payload);
      if (request.action === "disconnect_google_contacts") return googleContactsConnectorService.disconnectGoogleContactsSource(user, source.data.id, payload);
      if (request.action === "disconnect_google_calendar") return googleCalendarConnectorService.disconnectGoogleCalendarSource(user, source.data.id, payload);
      if (request.action === "disconnect_google_drive") return googleDriveConnectorService.disconnectGoogleDriveSource(user, source.data.id, payload);
      if (request.action === "disconnect_google_photos") return googlePhotosConnectorService.disconnectGooglePhotosSource(user, source.data.id, payload);
      return whatsappBusinessConnectorService.disconnectWhatsAppSource(user, source.data.id, payload);
    }
    case "update_connector_source":
    case "disable_connector_source":
    case "enable_connector_source": {
      const key = stringValue(p, "connector_key");
      if (!key) return fail(400, "VALIDATION_FAILED", "connector_key is required.");
      const source = await connectorSource(user, key);
      if (!source.ok) return source;
      if (request.action === "update_connector_source") return connectorService.updateConnectorSource(user, source.data.id, without(p, "connector_key"));
      if (request.action === "disable_connector_source") return connectorService.disableConnectorSource(user, source.data.id);
      return connectorService.enableConnectorSource(user, source.data.id, { confirmed });
    }
    case "create_gmail_draft": {
      const source = await connectorSource(user, "gmail");
      return source.ok ? gmailConnectorService.createGmailDraftMessage(user, source.data.id, p) : source;
    }
    case "delete_gmail_message": {
      const intake = await intakeByReference(user, stringValue(p, "sender_or_message"));
      return intake.ok ? gmailConnectorService.deleteGmailIntake(user, intake.data.id, { confirmed }) : intake;
    }
    case "import_google_contact": {
      const source = await connectorSource(user, "google_contacts");
      const externalContactId = stringValue(p, "external_contact_id");
      if (!source.ok) return source;
      return externalContactId
        ? googleContactsConnectorService.importGoogleContact(user, source.data.id, externalContactId, { confirmed })
        : fail(400, "VALIDATION_FAILED", "external_contact_id is required.");
    }
    case "create_google_photos_picker": {
      const source = await connectorSource(user, "google_photos");
      return source.ok ? googlePhotosConnectorService.createGooglePhotosSelectionSession(user, source.data.id) : source;
    }
    case "stage_google_photos": {
      const source = await connectorSource(user, "google_photos");
      const sessionId = stringValue(p, "session_id");
      if (!source.ok) return source;
      return sessionId ? googlePhotosConnectorService.stageGooglePhotosSelection(user, source.data.id, sessionId) : fail(400, "VALIDATION_FAILED", "session_id is required.");
    }
    case "register_google_photos_photo": {
      const source = await connectorSource(user, "google_photos");
      const photoId = stringValue(p, "photo_id");
      if (!source.ok) return source;
      return photoId
        ? googlePhotosConnectorService.registerGooglePhotosPortfolioPhoto(user, source.data.id, photoId, { ...without(p, "photo_id", "confirmed"), confirmed })
        : fail(400, "VALIDATION_FAILED", "photo_id is required.");
    }
    case "stage_google_drive_images": {
      const source = await connectorSource(user, "google_drive");
      return source.ok ? googleDriveConnectorService.stageGoogleDriveImages(user, source.data.id, p) : source;
    }
    case "register_google_drive_photo": {
      const source = await connectorSource(user, "google_drive");
      const imageId = stringValue(p, "image_id");
      if (!source.ok) return source;
      return imageId
        ? googleDriveConnectorService.registerDrivePortfolioPhoto(user, source.data.id, imageId, { ...without(p, "image_id", "confirmed"), confirmed })
        : fail(400, "VALIDATION_FAILED", "image_id is required.");
    }
    case "find_photos_for_service": {
      const service = lookup(await serviceCatalogueService.listServices(user), stringValue(p, "service_name"), ["name"], "service");
      return service.ok ? portfolioService.getPhotoSelectionWorkspace(user, service.data.id, p.own_production_only !== false) : service;
    }
    case "select_photos_for_service": {
      const service = lookup(await serviceCatalogueService.listServices(user), stringValue(p, "service_name"), ["name"], "service");
      if (!service.ok) return service;
      if (!Array.isArray(p.photo_filenames) || !p.photo_filenames.length) return fail(400, "VALIDATION_FAILED", "photo_filenames is required.");
      const photos = await portfolioService.listPortfolioPhotos(user);
      const selected: string[] = [];
      for (const filename of p.photo_filenames) {
        const photo = lookup(photos, typeof filename === "string" ? filename : undefined, ["filename"], "portfolio_photo");
        if (!photo.ok) return photo;
        selected.push(photo.data.id);
      }
      return portfolioService.selectPhotosForService(user, {
        service_catalogue_item_id: service.data.id,
        photo_ids: selected,
        own_production_only: p.own_production_only !== false,
        review_notes: p.review_notes,
        confirmed,
      });
    }
    case "update_employee": {
      const employee = lookup(await employeeService.listEmployees(user), stringValue(p, "employee_name"), ["displayName"], "employee");
      return employee.ok ? employeeService.updateEmployee(user, employee.data.id, { ...without(p, "employee_name", "confirmed"), confirmed }) : employee;
    }
    case "update_emma_behavior":
      return emmaBehaviorService.updateEmmaBehaviorScenario(user, p);
    case "update_emma_permissions": {
      if (!emmaPolicyService.isAdministrator(user)) return fail(403, "ADMINISTRATOR_REQUIRED");
      const parsed = emmaPolicyService.updateEmmaPolicySchema.safeParse(p);
      return parsed.success
        ? ok(200, await emmaPolicyService.updateEmmaPolicy(user, parsed.data.disabled_capabilities))
        : fail(400, "VALIDATION_FAILED", parsed.error.message);
    }
    case "merge_clients": {
      const primary = await clientByName(user, stringValue(p, "primary_client_name"));
      if (!primary.ok) return primary;
      const duplicate = await clientByName(user, stringValue(p, "duplicate_client_name"));
      return duplicate.ok ? dataQualityService.mergeClients(user, { primary_client_id: primary.data.id, duplicate_client_id: duplicate.data.id, confirmed }) : duplicate;
    }
  }
}

const PENDING_ACTION_TYPE = "emma_universal_action";
const PENDING_TTL_MS = 10 * 60 * 1000;

async function expirePending(user: AuthedUser) {
  await prisma.voicePendingAction.updateMany({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_ACTION_TYPE, status: "pending", expiresAt: { lte: new Date() } },
    data: { status: "expired", payload: Prisma.DbNull, resolvedAt: new Date() },
  });
}

async function pendingAction(user: AuthedUser) {
  await expirePending(user);
  return prisma.voicePendingAction.findFirst({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_ACTION_TYPE, status: "pending", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPendingEmmaActionName(user: AuthedUser): Promise<EmmaExecutableActionName | undefined> {
  const pending = await pendingAction(user);
  const payload = pending?.payload as { action?: string } | null;
  return payload?.action && Object.prototype.hasOwnProperty.call(EMMA_EXECUTABLE_ACTIONS, payload.action)
    ? payload.action as EmmaExecutableActionName
    : undefined;
}

export async function executeEmmaAction(user: AuthedUser, request: EmmaExecutableActionRequest): Promise<ServiceResult<unknown>> {
  const definition = EMMA_EXECUTABLE_ACTIONS[request.action];
  const sanitized = { ...request, parameters: without(request.parameters, "confirmed") };
  const result = await executeEmmaActionDirect(user, sanitized, false);
  if (definition.confirmation !== "service_preview" || result.ok || result.error !== "CONFIRMATION_REQUIRED") return result;

  await prisma.$transaction([
    prisma.voicePendingAction.updateMany({
      where: { companyId: user.companyId, userId: user.id, actionType: PENDING_ACTION_TYPE, status: "pending" },
      data: { status: "replaced", payload: Prisma.DbNull, resolvedAt: new Date() },
    }),
    prisma.voicePendingAction.create({
      data: {
        companyId: user.companyId,
        userId: user.id,
        actionType: PENDING_ACTION_TYPE,
        status: "pending",
        payload: sanitized as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    }),
  ]);
  return result;
}

export async function confirmPendingEmmaAction(user: AuthedUser): Promise<ServiceResult<unknown>> {
  const pending = await pendingAction(user);
  if (!pending) return fail(409, "NO_PENDING_ACTION", "There is no reviewed Emma action waiting for confirmation.");
  const request = pending.payload as unknown as EmmaExecutableActionRequest;
  if (!request?.action || !Object.prototype.hasOwnProperty.call(EMMA_EXECUTABLE_ACTIONS, request.action)) {
    await prisma.voicePendingAction.update({ where: { id: pending.id }, data: { status: "failed", payload: Prisma.DbNull, resolvedAt: new Date() } });
    return fail(409, "PENDING_ACTION_INVALID");
  }
  const claimed = await prisma.voicePendingAction.updateMany({ where: { id: pending.id, status: "pending" }, data: { status: "executing" } });
  if (claimed.count !== 1) return fail(409, "PENDING_ACTION_ALREADY_RESOLVED");
  const result = await executeEmmaActionDirect(user, request, true);
  await prisma.voicePendingAction.update({
    where: { id: pending.id },
    data: { status: result.ok ? "completed" : "failed", payload: Prisma.DbNull, resolvedAt: new Date() },
  });
  return result;
}

export async function cancelPendingEmmaAction(user: AuthedUser): Promise<ServiceResult<unknown>> {
  await expirePending(user);
  const cancelled = await prisma.voicePendingAction.updateMany({
    where: { companyId: user.companyId, userId: user.id, actionType: PENDING_ACTION_TYPE, status: "pending" },
    data: { status: "cancelled", payload: Prisma.DbNull, resolvedAt: new Date() },
  });
  return ok(200, { cancelled: cancelled.count > 0 });
}
