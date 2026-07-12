# VCUF Secretary MVP — User Guide

This guide describes the currently implemented web MVP. Secretary is the system of record: the web interface displays and submits data, while validation, permissions, capacity calculations and audit logging run on the backend.

## 1. Sign in and navigation

Open the frontend URL supplied by your administrator and sign in with your Secretary account. The sidebar shows the modules available to you. Recruitment and Memory Model are hidden unless your account has the required permission.

If an action is refused with `MISSING_PERMISSION`, ask an administrator to review your role. Do not share credentials or use another person's account.

Use **Account** to change your own password. You must enter the current password, and the new password must contain at least 12 characters with uppercase, lowercase and a number. Password values are never written to the audit log.

## 2. Safe command and voice input

The Dashboard command bar supports a defined set of deterministic text commands. Unsupported wording is rejected; Secretary does not guess an action.

Browser voice input is optional:

1. Select the microphone control and speak.
2. Stop listening.
3. Review and correct the transcript in the text field.
4. Select **Run** yourself.

Recognition never submits automatically. Secretary receives the reviewed transcript, not an audio recording. Browser speech recognition may use the browser vendor's online service. Use typed input when speech recognition is unavailable or unsuitable.

## 3. Enquiries, leads, clients and contacts

Use **Communication Intake** to enter an authorised inbound message. Extraction identifies only deterministic contact/service evidence from the entered text. Review the proposed match before converting it into a client and communication record.

Use **Enquiries** to monitor unresolved items and **Communications** to keep the client/job communication history and follow-up date.

Use **Leads** before a prospect becomes a client. Conversion preserves the lead as the source and checks for matching clients.

Use **Business Metrics** to review a selected date range of saved lead, quote and job activity plus current-week team capacity. The page compares this period with the immediately preceding equal-length period. Lead sources show converted and lost counts and rates; source-specific advice requires a minimum sample of three leads. Requested-service demand groups case variants of the exact text entered on leads, leaves blank requests unclassified and does not claim a catalogue relationship. The data-completeness table shows whether source, service, cost, duration and planned-date fields are sufficiently populated for reliable KPI calculations. Accepted quote value is grouped only when a line is linked to a real catalogue service; unlinked value remains separate and is not silently classified. Service quote margin appears only if every included line has a unit cost; the cost-coverage count shows what is missing. Recommendations are threshold-based and show their evidence. A metric marked unknown is not an error: Secretary states which source data or module is missing rather than estimating a value.

Use **Clients** for client accounts. Use **Contacts** for individual people:

- a contact may be independent or linked to a client;
- enter at least an email or phone number;
- contact source is recorded;
- a communication-derived contact also needs its source reference;
- matching normalised email or phone evidence is blocked as a possible duplicate;
- archive obsolete contacts instead of deleting history.

## 4. Services and industries

Use **Services** to record the actual service catalogue: description, price range, duration and required skills. Missing prices, costs or duration remain unknown.

Use **Industries** for the structured industry taxonomy. Add an explicit source and verification status, then link only applicable, existing catalogue services. Archive an industry or service link when it is no longer current.

Use **Business Context** for reusable company facts and rules that do not belong in an operational module. Mark each item with its source and verification status. Do not mark assumptions as confirmed.

## 5. Accepted jobs, assignment and capacity

Create jobs from a real client. Where possible, select a catalogue service and enter:

- planned start date;
- estimated duration;
- required skills;
- address and notes.

The lifecycle is **New → Accepted → Scheduled → In progress**, with waiting, completed and cancelled states where appropriate.

A worker can be assigned only while the job status is **Accepted**. This is the explicit proof that the company accepted the work. After assignment, move it to **Scheduled** when planning is complete.

Assignment checks declared employee skills and weekly capacity. A warning is evidence for review, not an automatic business decision. Secretary may permit a deliberate overload but records the warning in the audit trail. If a date or duration is missing, capacity cannot be fully evaluated and is shown as unknown.

Use **Tasks** for administrative and delivery work. A task with an assignee, due date and estimated duration contributes to capacity and appears in **Calendar**.

## 6. Quotes and document records

Use **Quotes** to prepare itemised quote records. Prices and costs come from entered values or the service catalogue. If any line cost is missing, margin is shown as unknown. Open a saved quote and select **Download PDF** to export a client-facing copy from the saved data. The PDF excludes internal cost and margin data and does not invent VAT, tax or payment terms. Changing a quote to sent or accepted records status only; it does not contact the client.

Use **Documents** to register metadata:

- title and document type;
- file path, URL or external storage identifier;
- client/job relationship;
- sensitivity and verification status;
- issue/expiry dates.

The MVP does not upload or retain file bytes. Confirm that the referenced storage location has the security, access control, retention and backup required for the document's sensitivity.

## 7. Photos and website work

Use **Photos** to record photo metadata and consent/marketing suitability. The MVP does not upload image files or run visual recognition.

Use **Photo Selection** to review real service evidence and confirm an exact internal selection. Selection never publishes anything.

Use **Website Audit** to record explicit manual observations. Unchecked items stay unknown. Use **Website Content** to prepare evidence-backed proposals and record approval or rejection. Approval is an internal decision only: there is no website publishing connector.

## 8. Recruitment decision support

The **Recruitment** page evaluates the next six weeks by default. It recommends a recruitment review only after capacity is overloaded in at least two distinct weeks.

When the threshold is met, review:

- the role derived from recorded required skills;
- source job/task titles;
- urgency;
- fastest relief route;
- missing evidence;
- affected weeks and employees.

The recommendation creates no opening and makes no employment commitment. If the evidence is sound, create a draft opening manually. Candidate stage `hired` remains a pipeline state; it does not create a user account, set pay or confirm terms.

## 9. Learning, playbooks and data quality

Use **Learning** only for explicit aliases or rules the user has taught Secretary. Archive a rule to stop it applying.

Use **Playbooks** for reviewed, repeatable command sequences. Check the resolved preview and confirm before execution. Playbooks stop on failure and do not hide individual action results.

Use **Data Quality** to review duplicate-client and missing-contact evidence. Client merge is confirmation-gated and archives the duplicate; review the preview carefully because there is no automatic unmerge.

Use **Memory Model** to view repeated audit patterns. It suggests candidates for review and never creates a rule or playbook automatically.

## 10. Notifications and audit

**Notifications** aggregates real Secretary signals such as unresolved enquiries, overdue follow-ups/tasks, overload, expiring quotes, stale leads and possible duplicates. Acknowledging a notification marks it handled; it does not alter the source record.

Important actions record actor, input, result, risk level and before/after evidence in the audit log. Contact an administrator if audit access or a formal export is required.

## 11. Connector data-source controls

Users with connector permissions can open **Connectors** to review the declared Gmail, Google Contacts, Google Calendar and Google Drive photo-storage contracts and register a company data source.

For Gmail, register a source with `read:messages`, choose **Authorize Gmail**, complete Google's consent screen, then review and explicitly **Enable** the source. **Initial sync** imports recent messages and stores a Gmail history cursor; **Sync changes** then reads only newly added messages. Repeated sync is idempotent, and an expired cursor safely falls back to a full sync.

Gmail, Contacts and Calendar are read-only. Drive uses per-file `drive.file`: choose images in Google Picker, review metadata, then confirm an internal Portfolio Photo reference. No image bytes are copied and marketing use remains disabled. Provider deletions never delete imported CRM data. Never paste credentials into Secretary.

Use **Disable** to stop access while retaining authorization. Use **Disconnect** only after reviewing its confirmation warning: it revokes the Google grant and deletes the encrypted local credential and sync cursor. Both actions are tenant-scoped and audited.

The **Service catalogue** page also includes **Browse reference activities**. The supplied CSV contains activity candidates across many industries. Activating one requires explicit confirmation that the company really performs it. The displayed Oxfordshire rate is reference-only and does not become the company price.

## 12. Current MVP limitations

The Google adapters require deployment-owned OAuth credentials and an encryption key. Synchronisation is manually triggered; scheduling/push notifications, attachments, Gmail writes, Drive image-byte storage, WhatsApp, SMS, job boards and website publishing are not implemented. The app also has no push delivery, automatic quote PDF delivery, native/offline voice runtime, automatic image analysis, automatic legal hiring action or automatic public content change.

Production encryption, TLS, database backups, monitoring, secret rotation, retention and disaster recovery depend on the selected hosting environment and must be configured and verified before production use.

## 13. Troubleshooting

- **Action rejected:** read the error message; check permissions, required fields and related record ownership.
- **Cannot assign a job:** set the job to **Accepted**, then retry.
- **Capacity unknown:** add a planned date and estimated duration; verify employee weekly capacity.
- **No recruitment recommendation:** fewer than two distinct overloaded weeks are currently evidenced.
- **Possible duplicate:** compare the candidate records; do not create a second record just to bypass the check.
- **Voice unavailable:** use text input. Browser support and policy vary.
- **Referenced document cannot be opened:** Secretary stores only the reference; check the external location and its access permissions.
- **Gmail cannot be authorized:** check the backend Google OAuth environment variables, exact redirect URI and encryption key. Do not send those values through chat or paste them into the UI.
- **Connector cannot be enabled:** every Google connector must finish its own OAuth flow. Drive Picker also requires the Cloud project number and browser-restricted Picker API key.
- **Gmail sync fails:** verify the source is enabled and consent still exists; inspect the non-secret error code. Disable the source if authorization is in doubt.
