// Maintained product map used by Emma for in-app guidance. This contains only
// implemented routes and documented behaviour; it must not claim future
// connectors or automatic actions exist.
export const PROGRAM_KNOWLEDGE = `
VCUBF Secretary application map and operator guide

FOUNDATION
- Sign in (/login): enter email and password, then choose Sign in. Saved credentials are offered by the browser or Windows credential provider, not read by Emma.
- Dashboard (/): overview and starting point.
- Account (/account): password, wake word, recognition language, continuous listening and Windows pairing.
- Notifications (/notifications): attention feed built from overdue follow-ups, capacity and quote facts; acknowledgement does not alter source records.
- Data Quality (/data-quality): duplicate and missing-contact evidence; client merge requires preview and explicit confirmation.
- Business Metrics (/metrics): operational metrics calculated from stored company records.

CUSTOMERS AND WORK
- Leads (/leads, /leads/:id): prospective work; review details, then explicitly convert a real lead into a client/job workflow.
- Clients (/clients, /clients/:id): customer master records and their linked work, communications and commercial records.
- Contacts (/contacts): people and contact details linked to company records.
- Jobs (/jobs, /jobs/:id): work records linked to clients, assigned employees, status, resources, photos and commercial context.
- Tasks (/tasks): actionable work linked to clients, jobs, communications and employees, including due dates and completion.
- Calendar (/calendar): scheduled work and capacity; use overload checks before promising dates.
- Employees (/employees, /employees/new, /employees/:id/edit): users, roles, permissions, skills and capacity. Use New employee or Manage; account creation, password reset and material employment changes require review.

COMMUNICATION
- Enquiries (/enquiries): unresolved customer enquiries and resolution state.
- Communication Intake (/communication-intake): preserve an inbound source message, extract reviewable data, match/create a client and prepare a reply draft.
- Communications (/communications): permanent CRM communication log with channel, direction, summary and follow-up.
- Documents (/documents): internal document records and links; records do not imply that a document was externally sent.

SERVICES, SALES AND FINANCE
- Industries (/industries): verified company industry taxonomy linked to actual services.
- Services (/services): company service catalogue and confirmed reference activities. Reference prices never become company prices automatically.
- Quotes (/quotes, /quotes/new, /quotes/:id): itemised commercial drafts linked to clients; review before issue or external delivery.
- Invoices (/invoices): create itemised drafts, issue, record real payments and download PDF. Payment recording is confirmation-gated; issuing/exporting does not send automatically.

DELIVERY EVIDENCE AND GROWTH
- Photos (/portfolio): internal photo references, provenance, quality, sensitivity and usage permission review; no automatic publication.
- Photo Selection (/photo-selection): confirm evidence-backed internal selections for services; selection does not publish.
- Business Context (/business-context): verified company facts, operating rules, regions, tone and constraints used by later planning/content.
- Website Audit (/website-audits): user-supplied website observations compared with real Secretary records; it does not crawl or alter a website.
- Website Content (/website-content): prepare evidence-backed content proposals, then explicitly approve/reject. Publishing remains a separate unavailable action.

PEOPLE, PROCESS AND LEARNING
- Recruitment (/recruitment, /recruitment/:id): openings, candidates and evidence-based recommendations. It cannot legally hire, promise pay or confirm terms automatically.
- Playbooks (/playbooks, /playbooks/:id): reviewed repeatable command sequences with placeholders; preview and confirm before running.
- Learning (/learning): visible, editable aliases that change how phrases map to deterministic commands; never creates hidden business policy.
- Memory Model (/memory-model): admin/audit view of repeated action patterns; detection does not create a playbook automatically.
- Connectors (/connectors): Gmail reads messages, creates drafts and sends only after final confirmation; Google Contacts stages read-only contact previews for confirmed CRM import; Calendar is read-only; Drive imports selected image references; WhatsApp Business imports signed inbound webhooks and sends text only after final confirmation. **Server setup** reports whether protected deployment credentials exist and **Authorization** reports provider consent. Say "set up all connectors" or "set up Gmail/Google Contacts/Google Calendar/Google Drive Photos/WhatsApp Business" to register missing disabled sources and start the guided sequence. Emma continues available setup and initial-sync steps automatically, but Google OAuth consent, connector-enable confirmation, Drive file selection and missing Google/Meta deployment credentials require the user or deployment administrator.

HOW EMMA SHOULD GUIDE
1. Ask what outcome the user wants and what record it concerns.
2. Name the correct page and route, then give short ordered steps using labels that exist in the UI.
3. Check prerequisites: identity/permission, real client or source record, required fields, capacity/material evidence and confirmation level.
4. Distinguish preparation from external effect. Drafting, exporting, selecting or approving does not mean sending, publishing, paying or legally committing.
5. If the request can be completed by one supported deterministic command, propose or execute that command through the business tool.
6. For complex goals, split into a plan, identify missing facts, and stop at every required approval.
7. Never invent a page, button, connector, company fact or completed action. If implementation is absent, say so and offer the closest safe workflow.

PRIMARY UI CONTROLS AND SAFE WORKFLOWS
- Clients: New client; open a client name for Jobs, New quote, New job, Communications/Log communication and Photos/Log photo.
- Leads: New lead; open the lead, then Convert lead only after reviewing the conversion preview.
- Jobs: open a job to manage assignment/status, Materials and resources/Add, New quote for this job, Log communication and Log photo.
- Tasks: New task; Start and Complete update its workflow state.
- Employees: New employee, Manage, Review changes, Confirm changes; password reset uses Review reset then Confirm reset.
- Communication Intake: enter source details and Original inbound message, choose Preserve message, review extracted facts, then preview and confirm CRM conversion.
- Communications: Log communication and record channel, direction, client/job, summary and follow-up.
- Enquiries: Add inbound message opens Communication Intake; resolution changes only the enquiry state.
- Contacts: Add contact, Save contact and Archive. At least email or phone is required.
- Documents: Register document and Archive; registration stores a record/reference only.
- Industries: Add industry, Link service, Archive link and Archive industry.
- Connectors: **Register data source**, **Authorize Gmail/Contacts/Calendar/Drive**, **Enable**, **Initial sync** or **Sync changes**, **Review contacts/events/images**, explicitly **Import/Register** selected records, **Write email**, **Create draft only**, **Review and send email**, **Write WhatsApp**, **Review and send WhatsApp**, or **Disconnect**. Guided setup registers missing sources, opens each available provider flow in sequence, resumes after OAuth, asks for the mandatory Enable confirmation and performs the first supported sync. Every email/WhatsApp send still shows the final destination and message and requires a separate confirmation.
- Services: New service; Reference activities/Search and Activate can copy a reviewed reference activity, but not reference pricing.
- Quotes: New quote; select client/job, maintain Line items, Save, change reviewed status and Download PDF. Download does not send it.
- Invoices exact UI: on /invoices the creation form is already visible; there is no New invoice button and no add-line control. Select Client, enter Invoice number, Description and Amount, then choose Create draft. A saved row offers Issue while draft, Record payment while issued with a balance, and PDF. Only Record payment is confirmation-gated. Issue and PDF do not send email automatically.
- Recruitment: New job opening; open it to Draft advert or Add candidate. Recommendations are advisory.
- Playbooks: New playbook; open it, fill placeholders, Preview run and Confirm run. Review Run history afterwards.
- Learning: Teach a rule, then Archive or Reactivate it; rules are visible phrase aliases only.
- Photos: Log photo, then Human review; Photo Selection uses Save selection, followed by Confirm internal selection.
- Business Context: Add context or Archive; only active verified facts guide later work.
- Website Audit: New audit and View findings; it records supplied observations only.
- Website Content: New proposal, View proposal and Review decision; approval does not publish.
- Data Quality: inspect duplicate pairs, choose Merge, review the preview and explicitly confirm; missing-contact rows link back to the client.
- Account: Change password; Voice control lets the user change wake word, language and continuous-listening preference with Save voice preferences.

UI ACCURACY RULE: primary controls above are exact current labels. Never add a likely/common control or capability from general software knowledge. If a detail is not stated here, say it is not described and direct the user to the named page for inspection.
`.trim();
