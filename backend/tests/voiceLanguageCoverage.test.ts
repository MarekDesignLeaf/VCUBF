import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTextCommand } from "../src/lib/commandParser.js";

// The constitution puts the deterministic parser, not the language model, in
// charge of what a spoken sentence means. A command the parser does not know
// still reaches the model, which costs a round trip, costs money per sentence
// and adds a place to be misheard — measured: "ukaž klienty" came back from
// the model as "delete all notifications" after the transcript said "Ukaž k
// věrty". So the coverage of each language is a number this suite keeps.
//
// One row per command, the same command in both languages. A row marked
// `pending` records a gap that is known and not yet closed; moving a row out
// of `pending` is how progress is recorded, and a row that stops matching
// fails the build.

interface Row {
  intent: string;
  english: string;
  czech: string;
  /** Known gap: the Czech form is not understood without the model yet. */
  pending?: true;
  /** The English form this suite tried is not understood either. */
  englishPending?: true;
}

const COMMANDS: Row[] = [
  { intent: "list_clients", english: "list clients", czech: "ukaž klienty" },
  { intent: "list_contacts", english: "list contacts", czech: "ukaž kontakty" },
  { intent: "list_jobs", english: "list jobs", czech: "ukaž zakázky" },
  { intent: "list_tasks", english: "list tasks", czech: "ukaž úkoly" },
  { intent: "list_leads", english: "list leads", czech: "ukaž poptávky" },
  { intent: "list_quotes", english: "list quotes", czech: "ukaž nabídky" },
  { intent: "list_communications", english: "list communications", czech: "ukaž komunikaci" },
  { intent: "list_notifications", english: "list notifications", czech: "ukaž oznámení" },
  { intent: "list_data_quality", english: "list data quality", czech: "ukaž kvalitu dat" },
  { intent: "list_portfolio_photos", english: "list photos", czech: "ukaž fotky" },
  { intent: "list_job_openings", english: "list job openings", czech: "ukaž volná místa" },
  { intent: "list_learning_rules", english: "list learning rules", czech: "ukaž pravidla učení" },
  { intent: "list_follow_ups", english: "list follow ups", czech: "ukaž následné kroky" },
  { intent: "list_unresolved_enquiries", english: "list unresolved enquiries", czech: "ukaž nevyřízené poptávky" },
  { intent: "navigate", english: "open invoices", czech: "otevři faktury" },
  { intent: "navigate", english: "open dashboard", czech: "přejdi na přehled" },
  { intent: "describe_menu", english: "read the menu", czech: "přečti menu" },
  { intent: "execute_action:get_unpaid_invoices", english: "how many unpaid invoices do I have", czech: "kolik mám nezaplacených faktur" },
  { intent: "execute_action:get_unpaid_invoices", english: "who owes us money", czech: "kdo mi nezaplatil" },
  { intent: "set_speech_rate", english: "speak faster", czech: "mluv rychleji" },
  { intent: "setup_connectors", english: "set up connectors", czech: "nastav konektory" },
  { intent: "sync_connectors", english: "sync gmail", czech: "synchronizuj gmail" },
  { intent: "create_assistant_memory", english: "remember that the client pays by transfer", czech: "zapamatuj si že klient platí převodem" },
  { intent: "recall_assistant_memory", english: "what do you remember about the client", czech: "co si pamatuješ o klientovi" },

  // Writes. These still go through the model in Czech.
  { intent: "create_client", english: "create client Jane Smith, email jane@example.com, phone 07700900000", czech: "vytvoř klienta Jan Novák, email jan@example.com, telefon 777123456" },
  { intent: "create_job", english: "create job Garden for client Jane Smith", czech: "vytvoř zakázku Zahrada pro klienta Jan Novák" },
  { intent: "create_task", english: "create task Call the client", czech: "vytvoř úkol Zavolat klientovi" },
  { intent: "create_lead", english: "create lead New garden", czech: "vytvoř poptávku Nová zahrada" },
  { intent: "create_service", english: "create service Lawn mowing", czech: "vytvoř službu Sekání trávy" },
  { intent: "assign_job", english: "assign job Garden to Peter", czech: "přiřaď zakázku Zahrada zaměstnanci Petr" },
  { intent: "change_job_status", english: "change job Garden status to completed", czech: "změň stav zakázky Zahrada na dokončeno" },
  { intent: "convert_lead", english: "convert lead New garden to client", czech: "převeď poptávku Nová zahrada na klienta" },
  { intent: "detect_overload", english: "check overload", czech: "zkontroluj přetížení" },
  { intent: "detect_action_patterns", english: "detect action patterns", czech: "najdi opakované činnosti" },

  // The English wording this suite tried is not understood either; whether
  // that is a missing pattern or simply another phrasing is not yet decided.
  { intent: "create_contact", english: "create contact Peter Free, email peter@example.com", czech: "vytvoř kontakt Petr Svoboda, email petr@example.com" },
  { intent: "change_task_status", english: "complete task Call the client", czech: "dokonči úkol Zavolat klientovi" },
  { intent: "update_lead", english: "mark lead New garden as contacted", czech: "označ poptávku Nová zahrada jako kontaktovaný" },
  { intent: "log_communication", english: "log call with Jane Smith: agreed the start date", czech: "zaznamenej hovor s klientem Jan Novák: dohodnut termín" },
  { intent: "connector_status", english: "check gmail status", czech: "stav gmailu" },
];

function resolvedIntent(phrase: string) {
  const parsed = parseTextCommand(phrase);
  return parsed.intent === "execute_action"
    ? `execute_action:${(parsed as { entities: { action: string } }).entities.action}`
    : parsed.intent;
}

describe("spoken command coverage by language", () => {
  it("understands the English form of every command without the model", () => {
    for (const row of COMMANDS) {
      if (row.englishPending) continue;
      assert.equal(resolvedIntent(row.english), row.intent, row.english);
    }
  });

  it("understands the Czech form of every command that is not a recorded gap", () => {
    for (const row of COMMANDS) {
      if (row.pending) continue;
      assert.equal(resolvedIntent(row.czech), row.intent, row.czech);
    }
  });

  it("records a gap only while it is still a gap", () => {
    const closed = COMMANDS.filter((row) => row.pending && resolvedIntent(row.czech) === row.intent);
    assert.deepEqual(
      closed.map((row) => row.czech),
      [],
      "these Czech commands now work; remove their pending flag so a regression fails this suite",
    );
  });

  it("keeps Czech coverage from falling", () => {
    // Raise this floor as gaps close. It may never be lowered: a drop means a
    // command a Czech speaker used yesterday now needs the model again.
    const CZECH_FLOOR = 38;
    const understood = COMMANDS.filter((row) => resolvedIntent(row.czech) === row.intent).length;
    assert.ok(
      understood >= CZECH_FLOOR,
      `Czech commands understood without the model: ${understood}/${COMMANDS.length}, floor is ${CZECH_FLOOR}`,
    );
  });
});
