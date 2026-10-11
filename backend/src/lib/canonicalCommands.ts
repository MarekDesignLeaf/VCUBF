import { VOICE_LANGUAGES } from "./voiceLanguages.js";

/**
 * The canonical commands the deterministic parser accepts, one form per line.
 *
 * Shared by the two model-facing surfaces that turn a sentence into a parser
 * command: the voice interpretation prompt and the agent's command bridge
 * (masterplan F1). Keeping one list means the agent can never be offered a
 * command the parser does not know, and a new command reaches both at once.
 * Whatever a model returns from this list is parsed again by the parser,
 * which stays the authority.
 */
export const CANONICAL_COMMAND_FORMS = `
create client NAME, email EMAIL, phone PHONE
create lead NAME for SERVICE, email EMAIL, phone PHONE
create job JOB TITLE for CLIENT NAME
set job JOB TITLE as STATUS
convert lead LEAD NAME
assign job JOB TITLE to EMPLOYEE NAME
show overload
create task for EMPLOYEE NAME: TITLE
create task TITLE, assigned to EMPLOYEE NAME, due ISO DATE
list tasks
create service NAME, category CATEGORY
list quotes [for CLIENT NAME]
list job openings
when I say TERM I mean MEANING
list learning rules
remember that TEXT
remember for the company that TEXT
what do you remember [about QUERY]
log call|email|meeting with|to|from CLIENT: SUMMARY
list communications [for CLIENT NAME]
log photo FILENAME [for CLIENT NAME]: CAPTION
list photos [for CLIENT NAME]
list marketing photos
list follow ups
list unresolved enquiries [from the last N days]
list notifications
delete all notifications
confirm delete notifications
cancel delete notifications
list contacts
show emails
show whatsapp messages
skip to the next sender
read older messages from this sender
  set language LANGUAGE_CODE (${VOICE_LANGUAGES.join(", ")})
  read full menu [section NAME]
  show calendar today|tomorrow|next 7 days
  send email to EMAIL; [cc EMAIL;] [bcc EMAIL;] subject SUBJECT; body BODY
  confirm email
  cancel email
  send WhatsApp to INTERNATIONAL_PHONE; message BODY
  confirm WhatsApp
  cancel WhatsApp
  check connectors
set up all connectors
set up CONNECTOR (Gmail, Google Contacts, Google Calendar, Google Drive, Google Photos, WhatsApp Business)
sync all connectors
sync CONNECTOR
show data quality issues
show action patterns
open PAGE (dashboard, account, notifications, data quality, business metrics, leads, clients, contacts, documents, jobs, tasks, enquiries, communication intake, communications, photos, photo selection, business context, industries, connectors, website audit, website content, employees, calendar, services, quotes, invoices, recruitment, playbooks, learning, memory model)
list clients
list jobs
list leads
`.trim();
