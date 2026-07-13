# VCUF Secretary MVP — User Guide

This guide describes the currently implemented web MVP. Secretary is the system of record: the web interface displays and submits data, while validation, permissions, capacity calculations and audit logging run on the backend.

## 1. Sign in and navigation

Open the frontend URL supplied by your administrator and sign in with your Secretary account. The sidebar shows the modules available to you. Recruitment and Memory Model are hidden unless your account has the required permission.

If an action is refused with `MISSING_PERMISSION`, ask an administrator to review your role. Do not share credentials or use another person's account.

Repeated failed sign-in attempts for the same account and network are temporarily limited. Wait for the indicated retry period before trying again; successful sign-ins do not consume the failure allowance.

Use **Account** to change your own password. You must enter the current password, and the new password must contain at least 12 characters with uppercase, lowercase and a number. Password values are never written to the audit log. Changing the password invalidates previously issued sign-in tokens, so other active sessions must sign in again.

Administrators can reset another active employee's password from the employee edit page. The reset requires a preview and explicit confirmation, invalidates that employee's existing sessions and marks the supplied password as temporary. The employee is restricted to the Account page until they replace it. Share temporary passwords through a secure channel; they are never displayed again or written to the audit log.

## 2. Safe command and voice input

Windows Emma is the only voice interface. She listens through the Windows companion, not through the browser, so there is no second browser microphone, wake-word button or **Run** step for normal voice interaction. The default wake word is **Emma**, but you can replace it from **Account** at any time.

The collapsed **Type to Emma (optional)** field above each signed-in page is a keyboard fallback only. It sends a defined deterministic text command through the same authenticated backend used by Emma. Unsupported wording is rejected; Secretary does not guess an action. Backend permissions, ambiguity rejection and action-specific confirmation remain active for both typed and spoken requests.

On Windows 11, install the native companion from `windows-companion` with `Install.ps1 -StartNow`. Its tray icon keeps local wake-word recognition active even when the browser is closed. Emma opens the normal VCUBF login in your default browser, where saved-password autofill works. Sign in and approve the matching eight-character code on Account; the pairing expires after ten minutes and can be consumed only once. No password is entered into or saved by the companion, and its API token is encrypted by Windows for the signed-in Windows account. The wake word has a dedicated high-priority local recognition grammar. Say `Emma` alone to enter Realtime listening before speaking naturally, or include an English command in the same phrase. For a same-phrase command, Windows detects activation and the recognised utterance is held in memory only while the authenticated backend obtains a more accurate OpenAI transcription; the WAV is never written to disk or stored by VCUBF. The accurate text is shown in **What Emma hears**, executed, and retained in the text conversation history. The default Windows hands-free mode speaks the result and accepts follow-up speech for twelve seconds; say `stop` to end. The monitor also displays microphone level, local hypotheses and activated Realtime turns; it can be closed and reopened from the tray with **Show live hearing**. Its pre-wake preview stays on the PC and is neither uploaded nor saved in conversation history. Backend permissions, ambiguity rejection and any action-specific confirmation remain active. Allow desktop microphone access in Windows Privacy settings.

Natural assistant mode lets Emma understand ordinary phrasing, hold a short follow-up conversation, ask for missing details and describe a safe plan for a complex business objective. With Realtime disabled, OpenAI receives recognized text and a short six-message conversation window rather than microphone audio. Exact commands remain deterministic. The language model can only propose one of the existing canonical commands; the backend reparses it and remains the only component allowed to execute it. Say, for example, **“Emma, switch language to Czech”** or **“Emma, změň jazyk na češtinu”** to change both Emma and the Secretary navigation menu. Supported languages are English (UK/US), Czech, Polish, French, German, Spanish and Italian. Legal, financial, deletion, publishing, hiring, payment and other risky requests are not converted into direct voice actions and must use their reviewed confirmation flow. Right-click the tray icon for **Talk to Emma now**, listening controls and settings for wake word, language, assistant mode, speech speed and volume.

Emma can send a Gmail email only when exactly one enabled Gmail source has **Send email** permission. Say, for example, `Emma, send email to customer@example.com; subject Quote ready; body Your quote is attached.` Emma repeats the recipient, subject and message preview, then waits for **yes**, **confirm**, **no** or **cancel**. A confirmation sends the reviewed message once; cancellation, transcript deletion, failure or a five-minute expiry removes the temporary pending message content without sending it.

When **Realtime audio and interruption** is enabled, the local recognizer still detects `Emma` before cloud audio starts. The activated conversation then uses a temporary OpenAI speech-to-speech session with automatic voice-activity detection. You do not need to press a button or wait for a beep between follow-ups, and speaking over Emma stops the current response so the new request can be heard. Company requests are executed only by calling back into the authenticated VCUBF command endpoint. The backend OpenAI key is never sent to the PC; the companion receives only a short-lived session credential. Realtime closes after inactivity or three minutes and falls back to the authenticated text assistant if unavailable.

The **Windows Emma** control centre above each signed-in page shows whether the companion is offline, listening, hearing, thinking, speaking or paused. It displays the latest command and answer plus **Saved conversation transcripts**, grouped by activated conversation with every completed user/Emma text turn, order, time, mode and completion state. These text transcripts remain in Secretary until the user chooses **Delete transcript history** and confirms deletion; deletion also ends any active conversation and cancels any pending Emma email so no later turn can send it. Background speech that does not activate the wake word is not uploaded, and VCUBF never stores microphone audio. Choose **Pause listening** whenever Emma must ignore the wake word, **Resume listening** to reactivate it, or **End conversation** to leave Realtime mode while keeping local wake-word listening available.

Emma also receives a backend-maintained map of every implemented program route, its purpose, primary controls, prerequisites and safety boundaries. Ask, for example, “Emma, where do I create an invoice?” or describe the result you want. She should name the correct page and existing controls, give short ordered steps, identify missing records or permissions, and explain when a preview or confirmation is required. She must not invent pages or claim that a draft, PDF, approval or internal selection was externally sent or published. An automated test fails when a new frontend route is not represented in this map.

The installer also creates a single **VCUBF Secretary** desktop icon. Double-clicking it starts Emma before opening one production sign-in flow in the default browser. The one-time device handoff completes automatically after a successful login, so the browser and companion use the same VCUBF account without a second approval click. On a fresh companion start Emma says that she is active and listening. After the first successful login, the page pre-fills the last-used email on this PC; the browser remains responsible for offering any saved password. The encrypted device session lasts up to 30 days but is revoked by password changes, account disablement or session invalidation.

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

Open a job to record required materials, equipment, vehicles, hire and waste handling, including quantity, unit, estimated cost and later actual cost. Each requirement has an explicit readiness state; missing costs and cost variance remain unknown until all relevant values are entered. A job planned to start within three days appears in Notifications when any recorded requirement is not ready. Changing a state records the real operational state but does not order or hire anything externally.

Use **Tasks** for administrative and delivery work. A task with an assignee, due date and estimated duration contributes to capacity and appears in **Calendar**.

## 6. Quotes and document records

Use **Quotes** to prepare itemised quote records. Prices and costs come from entered values or the service catalogue. If any line cost is missing, margin is shown as unknown. Open a saved quote and select **Download PDF** to export a client-facing copy from the saved data. The PDF excludes internal cost and margin data and does not invent VAT, tax or payment terms. Changing a quote to sent or accepted records status only; it does not contact the client.

Use **Invoices** to create an itemised draft linked to a real client. Invoice numbers are unique within the company. Issue a draft, record only payments actually received and download a client-facing PDF from the saved record. Recording a payment always shows a preview with the client, amount and resulting balance and requires a second explicit confirmation; cancelling the preview writes no payment. Secretary calculates total, paid amount and remaining balance, rejects overpayments and marks a fully settled invoice paid. An issued invoice with an entered due date and an outstanding balance is shown as overdue and appears in Notifications after that date. Issuing or exporting does not send the invoice automatically.

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

Users with connector permissions can open **Connectors** to review Gmail, Google Contacts, Google Calendar, Google Drive, Google Photos and WhatsApp Business. **Server setup** shows whether the required protected deployment configuration exists; it never exposes a secret. Say “Emma, set up all connectors” or name one connector. Emma registers missing disabled sources, starts each available OAuth flow, resumes after the provider redirects back, asks for the mandatory Enable confirmation, and runs the first supported Gmail/Contacts/Calendar synchronisation. She reports missing Google or Meta deployment configuration instead of inventing it. Google consent, Enable confirmation, Drive image selection and Google Photos selection remain explicit user actions.

For Gmail, register a source with `read:messages`, choose **Authorize Gmail**, complete Google's consent screen, then review and explicitly **Enable** the source. Secretary starts the initial server-side sync automatically, stores a Gmail history cursor and later reads only new changes. **Sync now** remains available when an immediate refresh is useful. Repeated sync is idempotent, and an expired cursor safely falls back to a full sync. The same automatic background schedule applies to enabled read-only Google Contacts and Google Calendar sources.

Gmail can be configured for reading, draft creation and confirmed sending. Emma supports a hands-free send preview and final spoken confirmation when one enabled Gmail source has `send:messages`; multiple eligible Gmail sources must be resolved in **Connectors** before she will send. Contacts and Calendar are read-only. Google Drive uses per-file `drive.file`: choose image files in Google Picker, review metadata, then confirm an internal Portfolio Photo reference. Google Photos is separate: choose **Select Google Photos**, select exact items in the Google Photos picker and then review the staged metadata. The app cannot browse your whole Google Photos library. Neither connector copies image bytes, and marketing use remains disabled. WhatsApp imports signed inbound messages and automatically synchronises the sender's valid contact: a new number creates a CRM contact, one matching active number is linked without being changed, and ambiguous duplicates remain for review. It cannot import a complete historic WhatsApp address book. Text still sends only after final review and confirmation. Provider deletions never delete imported CRM data. Never paste credentials into Secretary.

Use **Disable** to stop access while retaining authorization. Use **Disconnect** only after reviewing its confirmation warning: it revokes the Google grant and deletes the encrypted local credential and sync cursor. Both actions are tenant-scoped and audited.

The **Service catalogue** page also includes **Browse reference activities**. The supplied CSV contains activity candidates across many industries. Activating one requires explicit confirmation that the company really performs it. The displayed Oxfordshire rate is reference-only and does not become the company price.

## 12. Current MVP limitations

The Google adapters require deployment-owned OAuth credentials and an encryption key; WhatsApp requires deployment-owned Meta credentials and currently supports one business phone number. Guided setup can detect and report missing configuration but cannot create provider projects, secrets or approve provider consent. Gmail push notifications, attachments, Drive image-byte storage, WhatsApp media/template workflows, SMS, job boards and website publishing are not implemented. The app also has no push delivery, automatic quote PDF delivery, fully offline natural-language voice runtime, automatic image analysis, automatic legal hiring action or automatic public content change.

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
