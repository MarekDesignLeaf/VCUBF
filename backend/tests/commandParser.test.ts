import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isExplicitVoiceLanguageChange, isGmailCancellationPhrase, isGmailConfirmationPhrase, parseTextCommand } from "../src/lib/commandParser.js";

describe("commandParser", () => {
  it("parses 'create client' with email and phone", () => {
    const result = parseTextCommand("create client Jane Smith, email jane@example.com, phone 07700900000");
    assert.equal(result.intent, "create_client");
    if (result.intent === "create_client") {
      assert.equal(result.entities.display_name, "Jane Smith");
      assert.equal(result.entities.email_primary, "jane@example.com");
      assert.equal(result.entities.phone_primary, "07700900000");
    }
  });

  it("parses a bare 'add client' with no extra fields", () => {
    const result = parseTextCommand("add client Bob Jones");
    assert.equal(result.intent, "create_client");
    if (result.intent === "create_client") {
      assert.equal(result.entities.display_name, "Bob Jones");
      assert.equal(result.entities.email_primary, undefined);
    }
  });

  it("parses client edits and confirmed archival in English, Czech and Polish", () => {
    assert.deepEqual(parseTextCommand("change email for client Jane Smith to jane.new@example.com"), {
      intent: "update_client",
      entities: { client_name: "Jane Smith", email_primary: "jane.new@example.com" },
    });
    assert.deepEqual(parseTextCommand("změň telefon klienta Jane Smith na +420 777 123 456"), {
      intent: "update_client",
      entities: { client_name: "Jane Smith", phone_primary: "+420 777 123 456" },
    });
    assert.deepEqual(parseTextCommand("rename client Jane Smith to Jane Brown"), {
      intent: "update_client",
      entities: { client_name: "Jane Smith", display_name: "Jane Brown" },
    });
    assert.deepEqual(parseTextCommand("usuń klienta Jane Brown"), {
      intent: "prepare_archive_client",
      entities: { client_name: "Jane Brown" },
    });
    assert.equal(parseTextCommand("potvrď smazání klienta").intent, "confirm_archive_client");
    assert.equal(parseTextCommand("cancel client deletion").intent, "cancel_archive_client");
  });

  it("parses contact creation, editing and confirmed archival", () => {
    assert.deepEqual(parseTextCommand("create contact Alice Green, email alice@example.com, phone 07700900001"), {
      intent: "create_contact",
      entities: { display_name: "Alice Green", email: "alice@example.com", phone: "07700900001" },
    });
    assert.deepEqual(parseTextCommand("change phone for contact Alice Green to +44 7700 900002"), {
      intent: "update_contact",
      entities: { contact_name: "Alice Green", phone: "+44 7700 900002" },
    });
    assert.deepEqual(parseTextCommand("archive contact Alice Green"), {
      intent: "prepare_archive_contact",
      entities: { contact_name: "Alice Green" },
    });
    assert.equal(parseTextCommand("confirm contact deletion").intent, "confirm_archive_contact");
    assert.equal(parseTextCommand("zruš smazání kontaktu").intent, "cancel_archive_contact");
  });

  it("parses 'create lead' with a service and email", () => {
    const result = parseTextCommand("new lead Alice Green, email alice@example.com for fencing");
    assert.equal(result.intent, "create_lead");
    if (result.intent === "create_lead") {
      assert.equal(result.entities.name, "Alice Green");
      assert.equal(result.entities.service_requested, "fencing");
      assert.equal(result.entities.email, "alice@example.com");
    }
  });

  it("parses 'create job X for Y'", () => {
    const result = parseTextCommand("create job Hedge trimming for Jane Smith");
    assert.equal(result.intent, "create_job");
    if (result.intent === "create_job") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.client_name, "Jane Smith");
    }
  });

  it("parses 'set job X as scheduled'", () => {
    const result = parseTextCommand("set job Hedge trimming as scheduled");
    assert.equal(result.intent, "change_job_status");
    if (result.intent === "change_job_status") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.job_status, "scheduled");
    }
  });

  it("parses 'convert lead X'", () => {
    const result = parseTextCommand("convert lead Alice Green");
    assert.equal(result.intent, "convert_lead");
    if (result.intent === "convert_lead") {
      assert.equal(result.entities.lead_name, "Alice Green");
    }
  });

  it("parses list commands", () => {
    assert.equal(parseTextCommand("list clients").intent, "list_clients");
    assert.equal(parseTextCommand("show contacts").intent, "list_contacts");
    assert.deepEqual(parseTextCommand("read my emails"), { intent: "list_channel_messages", entities: { channel: "email" } });
    assert.deepEqual(parseTextCommand("show whatsapp messages"), { intent: "list_channel_messages", entities: { channel: "whatsapp" } });
    assert.equal(parseTextCommand("show jobs").intent, "list_jobs");
    assert.equal(parseTextCommand("list leads").intent, "list_leads");
  });

  it("parses reviewed notification deletion in English, Czech and Polish", () => {
    assert.equal(parseTextCommand("powiadomienia").intent, "list_notifications");
    assert.equal(parseTextCommand("ukaž oznámení").intent, "list_notifications");
    assert.equal(parseTextCommand("delete all notifications").intent, "prepare_delete_notifications");
    assert.equal(parseTextCommand("smaž všechna oznámení").intent, "prepare_delete_notifications");
    assert.equal(parseTextCommand("usuń wszystkie powiadomienia").intent, "prepare_delete_notifications");
    assert.equal(parseTextCommand("mazání powiadomienia").intent, "prepare_delete_notifications");
    assert.equal(parseTextCommand("confirm deleting notifications").intent, "confirm_delete_notifications");
    assert.equal(parseTextCommand("potvrď smazání všech oznámení").intent, "confirm_delete_notifications");
    assert.equal(parseTextCommand("potwierdź usunięcie wszystkich powiadomień").intent, "confirm_delete_notifications");
    assert.equal(parseTextCommand("cancel deleting notifications").intent, "cancel_delete_notifications");
    assert.equal(parseTextCommand("zruš smazání všech oznámení").intent, "cancel_delete_notifications");
    assert.equal(parseTextCommand("anuluj usunięcie wszystkich powiadomień").intent, "cancel_delete_notifications");
  });

  it("parses connector status, guided setup and synchronisation commands", () => {
    assert.deepEqual(parseTextCommand("check connectors"), { intent: "connector_status", entities: { connector_key: "all" } });
    assert.deepEqual(parseTextCommand("set up all connectors"), { intent: "setup_connectors", entities: { connector_key: "all" } });
    assert.deepEqual(parseTextCommand("configure Google Contacts"), { intent: "setup_connectors", entities: { connector_key: "google_contacts" } });
    assert.deepEqual(parseTextCommand("start WhatsApp Business connector"), { intent: "setup_connectors", entities: { connector_key: "whatsapp_business" } });
    assert.deepEqual(parseTextCommand("sync Gmail"), { intent: "sync_connectors", entities: { connector_key: "gmail" } });
    assert.deepEqual(parseTextCommand("synchronizuj kalendář"), { intent: "sync_connectors", entities: { connector_key: "google_calendar" } });
    assert.deepEqual(parseTextCommand("odśwież pocztę"), { intent: "sync_connectors", entities: { connector_key: "gmail" } });
  });

  it("parses a reviewed Gmail send command and explicit email confirmation controls", () => {
    assert.deepEqual(
      parseTextCommand("send email to jane@example.com and sam@example.com; cc accounts@example.com; bcc archive@example.com; subject Quote review; body Hello, please review the attached quote."),
      {
        intent: "prepare_gmail_message",
        entities: {
          to: ["jane@example.com", "sam@example.com"],
          cc: ["accounts@example.com"],
          bcc: ["archive@example.com"],
          subject: "Quote review",
          body: "Hello, please review the attached quote.",
        },
      }
    );
    assert.deepEqual(parseTextCommand("send email to jane@example.com, subject Quick update, body I will call tomorrow."), {
      intent: "prepare_gmail_message",
      entities: { to: ["jane@example.com"], cc: [], bcc: [], subject: "Quick update", body: "I will call tomorrow." },
    });
    assert.equal(parseTextCommand("confirm email").intent, "confirm_gmail_message");
    assert.equal(parseTextCommand("cancel email").intent, "cancel_gmail_message");
    assert.equal(isGmailConfirmationPhrase("Yes."), true);
    assert.equal(isGmailCancellationPhrase("Do not send"), true);
    assert.deepEqual(parseTextCommand("pošli email na jane@example.com; předmět Nabídka; zpráva Dobrý den."), {
      intent: "prepare_gmail_message",
      entities: { to: ["jane@example.com"], cc: [], bcc: [], subject: "Nabídka", body: "Dobrý den." },
    });
    assert.deepEqual(parseTextCommand("wyślij email do jane@example.com; temat Oferta; treść Dzień dobry."), {
      intent: "prepare_gmail_message",
      entities: { to: ["jane@example.com"], cc: [], bcc: [], subject: "Oferta", body: "Dzień dobry." },
    });
  });

  it("parses language changes in English, Czech and Polish", () => {
    assert.deepEqual(parseTextCommand("set language cs-CZ"), { intent: "set_voice_language", entities: { language: "cs-CZ" } });
    assert.deepEqual(parseTextCommand("switch language to Polish"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(parseTextCommand("Turn on Polish language now"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(parseTextCommand("změň jazyk na francouzštinu"), { intent: "set_voice_language", entities: { language: "fr-FR" } });
    assert.deepEqual(parseTextCommand("mluv německy"), { intent: "set_voice_language", entities: { language: "de-DE" } });
    assert.deepEqual(parseTextCommand("mów po polsku"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(parseTextCommand("zmień język na angielski"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Włącz angielski, brytyjski język, kurwa."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Przełącz na angielski język brytyjski."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Nie będę się kurwa prosił, przełącz to od razu na angielski język."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Chcę język na angielski, kurwa."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("język NGB."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Ustaw język MGB."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("brytyjskim"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Přepni se do angličtiny."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Přepni se do češtiny."), { intent: "set_voice_language", entities: { language: "cs-CZ" } });
    assert.deepEqual(parseTextCommand("Přepni jazyk do češtiny."), { intent: "set_voice_language", entities: { language: "cs-CZ" } });
    assert.deepEqual(parseTextCommand("Změň jazyk Emmy na francouzštinu."), { intent: "set_voice_language", entities: { language: "fr-FR" } });
    assert.deepEqual(parseTextCommand("Přepni se do němčiny."), { intent: "set_voice_language", entities: { language: "de-DE" } });
    assert.deepEqual(parseTextCommand("Ne, přepni se okamžitě do angličtiny!"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Switch to Polish"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(parseTextCommand("Yes, switch to Polish."), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(parseTextCommand("Passe la langue en allemand."), { intent: "set_voice_language", entities: { language: "de-DE" } });
    assert.deepEqual(parseTextCommand("Wechsle die Sprache auf Spanisch."), { intent: "set_voice_language", entities: { language: "es-ES" } });
    assert.deepEqual(parseTextCommand("Cambia el idioma a italiano."), { intent: "set_voice_language", entities: { language: "it-IT" } });
    assert.deepEqual(parseTextCommand("Cambia la lingua in francese."), { intent: "set_voice_language", entities: { language: "fr-FR" } });
    assert.equal(isExplicitVoiceLanguageChange("změň jazyk na češtinu", "cs-CZ"), true);
    assert.equal(isExplicitVoiceLanguageChange("show me contacts", "en-GB"), false);
    assert.equal(isExplicitVoiceLanguageChange("mluv česky", "en-GB"), false);
  });

  it("parses calendar agenda requests in English, Czech and Polish", () => {
    assert.deepEqual(parseTextCommand("what is on my calendar tomorrow"), { intent: "list_calendar_events", entities: { period: "tomorrow" } });
    assert.deepEqual(parseTextCommand("co mám zítra v kalendáři"), { intent: "list_calendar_events", entities: { period: "tomorrow" } });
    assert.deepEqual(parseTextCommand("jakie mam jutro wydarzenia w kalendarzu"), { intent: "list_calendar_events", entities: { period: "tomorrow" } });
    assert.deepEqual(parseTextCommand("ukaž kalendář na příštích 7 dní"), { intent: "list_calendar_events", entities: { period: "next_7_days" } });
  });

  it("parses reviewed WhatsApp messages in English, Czech and Polish", () => {
    assert.deepEqual(parseTextCommand("send WhatsApp to +447700900123; message Hello"), {
      intent: "prepare_whatsapp_message",
      entities: { to: "+447700900123", body: "Hello" },
    });
    assert.deepEqual(parseTextCommand("pošli zprávu na WhatsApp na +420777123456 zpráva Ahoj"), {
      intent: "prepare_whatsapp_message",
      entities: { to: "+420777123456", body: "Ahoj" },
    });
    assert.deepEqual(parseTextCommand("wyślij wiadomość na WhatsApp do +48500100200 wiadomość Cześć"), {
      intent: "prepare_whatsapp_message",
      entities: { to: "+48500100200", body: "Cześć" },
    });
    assert.equal(parseTextCommand("potwierdź WhatsApp").intent, "confirm_whatsapp_message");
    assert.equal(parseTextCommand("zruš zprávu na WhatsApp").intent, "cancel_whatsapp_message");
  });

  it("parses complete menu and named menu-subtree requests in English and Czech", () => {
    assert.deepEqual(parseTextCommand("read the full menu"), { intent: "describe_menu", entities: {} });
    assert.deepEqual(parseTextCommand("what is in the menu"), { intent: "describe_menu", entities: {} });
    assert.deepEqual(parseTextCommand("read full menu customers and work"), { intent: "describe_menu", entities: { section: "customers_and_work" } });
    assert.deepEqual(parseTextCommand("přečti menu klienti"), { intent: "describe_menu", entities: { section: "customers_and_work" } });
    assert.deepEqual(parseTextCommand("co je v menu obchod"), { intent: "describe_menu", entities: { section: "sales_and_finance" } });
  });

  it("parses direct navigation across the Secretary hierarchy", () => {
    assert.deepEqual(parseTextCommand("open dashboard"), { intent: "navigate", entities: { page: "dashboard" } });
    assert.deepEqual(parseTextCommand("Opan calendar."), { intent: "navigate", entities: { page: "calendar" } });
    assert.deepEqual(parseTextCommand("oppen quotes"), { intent: "navigate", entities: { page: "quotes" } });
    assert.deepEqual(parseTextCommand("go to invoices"), { intent: "navigate", entities: { page: "invoices" } });
    assert.deepEqual(parseTextCommand("take me to communication intake"), { intent: "navigate", entities: { page: "communication_intake" } });
    assert.deepEqual(parseTextCommand("show me business metrics"), { intent: "navigate", entities: { page: "metrics" } });
    assert.deepEqual(parseTextCommand("otwórz oferty"), { intent: "navigate", entities: { page: "quotes" } });
    assert.deepEqual(parseTextCommand("otwórz usługi"), { intent: "navigate", entities: { page: "services" } });
    assert.deepEqual(parseTextCommand("otevři nabídky"), { intent: "navigate", entities: { page: "quotes" } });
    assert.deepEqual(parseTextCommand("öffne Angebote"), { intent: "navigate", entities: { page: "quotes" } });
  });

  it("parses 'assign job X to Y'", () => {
    const result = parseTextCommand("assign job Hedge trimming to Test Worker");
    assert.equal(result.intent, "assign_job");
    if (result.intent === "assign_job") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.employee_name, "Test Worker");
    }
  });

  it("parses 'show overload'", () => {
    assert.equal(parseTextCommand("show overload").intent, "detect_overload");
    assert.equal(parseTextCommand("check overload").intent, "detect_overload");
  });

  it("parses unresolved enquiry commands with an optional evidence window", () => {
    const all = parseTextCommand("show unresolved enquiries");
    assert.equal(all.intent, "list_unresolved_enquiries");
    if (all.intent === "list_unresolved_enquiries") assert.equal(all.entities.since_days, undefined);

    const week = parseTextCommand("check unresolved enquiries from the last week");
    assert.equal(week.intent, "list_unresolved_enquiries");
    if (week.intent === "list_unresolved_enquiries") assert.equal(week.entities.since_days, 7);

    const days = parseTextCommand("find unresolved enquiries in last 3 days");
    assert.equal(days.intent, "list_unresolved_enquiries");
    if (days.intent === "list_unresolved_enquiries") assert.equal(days.entities.since_days, 3);
  });

  it("parses task creation and listing commands", () => {
    const assigned = parseTextCommand("create task for Test Worker: Prepare materials");
    assert.equal(assigned.intent, "create_task");
    if (assigned.intent === "create_task") {
      assert.equal(assigned.entities.title, "Prepare materials");
      assert.equal(assigned.entities.employee_name, "Test Worker");
    }

    const dated = parseTextCommand(
      "create task Send quote, assigned to Test Admin, due 2027-01-04T09:00:00.000Z"
    );
    assert.equal(dated.intent, "create_task");
    if (dated.intent === "create_task") {
      assert.equal(dated.entities.title, "Send quote");
      assert.equal(dated.entities.employee_name, "Test Admin");
      assert.equal(dated.entities.due_at, "2027-01-04T09:00:00.000Z");
    }
    assert.equal(parseTextCommand("list tasks").intent, "list_tasks");
  });

  it("parses task workflow status commands", () => {
    assert.deepEqual(parseTextCommand("start task Prepare quote"), {
      intent: "change_task_status",
      entities: { title: "Prepare quote", task_status: "in_progress" },
    });
    assert.deepEqual(parseTextCommand("complete task Prepare quote"), {
      intent: "change_task_status",
      entities: { title: "Prepare quote", task_status: "completed" },
    });
  });

  it("parses 'create service X, category Y'", () => {
    const result = parseTextCommand("create service Fence repair, category Fencing");
    assert.equal(result.intent, "create_service");
    if (result.intent === "create_service") {
      assert.equal(result.entities.name, "Fence repair");
      assert.equal(result.entities.category, "Fencing");
    }
  });

  it("parses a bare 'create service X' with no category", () => {
    const result = parseTextCommand("create service Hedge trim");
    assert.equal(result.intent, "create_service");
    if (result.intent === "create_service") {
      assert.equal(result.entities.name, "Hedge trim");
      assert.equal(result.entities.category, undefined);
    }
  });

  it("parses 'list quotes' and 'list quotes for X'", () => {
    const bare = parseTextCommand("list quotes");
    assert.equal(bare.intent, "list_quotes");
    if (bare.intent === "list_quotes") assert.equal(bare.entities.client_name, undefined);

    const scoped = parseTextCommand("show quotes for Quote Test Client");
    assert.equal(scoped.intent, "list_quotes");
    if (scoped.intent === "list_quotes") assert.equal(scoped.entities.client_name, "Quote Test Client");
  });

  it("parses 'list job openings'", () => {
    const result = parseTextCommand("list job openings");
    assert.equal(result.intent, "list_job_openings");
    assert.equal(parseTextCommand("show job opening").intent, "list_job_openings");
  });

  it("parses 'when I say X I mean Y' and 'teach me X means Y'", () => {
    const r1 = parseTextCommand("when I say old client I mean a client from the last two years");
    assert.equal(r1.intent, "create_learning_rule");
    if (r1.intent === "create_learning_rule") {
      assert.equal(r1.entities.term, "old client");
      assert.equal(r1.entities.meaning, "a client from the last two years");
    }

    const r2 = parseTextCommand("teach me: Riverside means Riverside Apartments Ltd");
    assert.equal(r2.intent, "create_learning_rule");
    if (r2.intent === "create_learning_rule") {
      assert.equal(r2.entities.term, "Riverside");
      assert.equal(r2.entities.meaning, "Riverside Apartments Ltd");
    }
  });

  it("parses 'list learning rules'", () => {
    assert.equal(parseTextCommand("list learning rules").intent, "list_learning_rules");
    assert.equal(parseTextCommand("show learning rule").intent, "list_learning_rules");
  });

  it("parses explicit personal and company memory commands in English and Czech", () => {
    assert.deepEqual(parseTextCommand("remember that invoice numbers use YYYY-001"), {
      intent: "create_assistant_memory",
      entities: { content: "invoice numbers use YYYY-001", scope: "personal" },
    });
    assert.deepEqual(parseTextCommand("remember for the company that invoice numbers use YYYYMMDD-001"), {
      intent: "create_assistant_memory",
      entities: { content: "invoice numbers use YYYYMMDD-001", scope: "company" },
    });
    assert.deepEqual(parseTextCommand("zapamatuj si, že čísla faktur začínají rokem"), {
      intent: "create_assistant_memory",
      entities: { content: "čísla faktur začínají rokem", scope: "personal" },
    });
    assert.deepEqual(parseTextCommand("zapamatuj si ze invoice cisla konci 001"), {
      intent: "create_assistant_memory",
      entities: { content: "invoice cisla konci 001", scope: "personal" },
    });
    assert.deepEqual(parseTextCommand("zapamatuj si pro firmu, že faktury končí trojčíslím 001"), {
      intent: "create_assistant_memory",
      entities: { content: "faktury končí trojčíslím 001", scope: "company" },
    });
  });

  it("parses memory recall commands", () => {
    assert.deepEqual(parseTextCommand("what do you remember about invoice numbers?"), {
      intent: "recall_assistant_memory",
      entities: { query: "invoice numbers" },
    });
    assert.deepEqual(parseTextCommand("co si pamatuješ o fakturách?"), {
      intent: "recall_assistant_memory",
      entities: { query: "fakturách" },
    });
    assert.deepEqual(parseTextCommand("co máš v paměti"), {
      intent: "recall_assistant_memory",
      entities: { query: undefined },
    });
    assert.deepEqual(parseTextCommand("co si pamatujes o invoices?"), {
      intent: "recall_assistant_memory",
      entities: { query: "invoices" },
    });
  });

  it("returns unrecognized for gibberish instead of guessing", () => {
    const result = parseTextCommand("please make the weather nicer today");
    assert.equal(result.intent, "unrecognized");
  });

  it("parses only allowlisted structured Emma actions", () => {
    assert.deepEqual(parseTextCommand('voice action set_quote_status {"quote_title":"Kitchen","quote_status":"sent"}'), {
      intent: "execute_action",
      entities: { action: "set_quote_status", parameters: { quote_title: "Kitchen", quote_status: "sent" } },
    });
    assert.equal(parseTextCommand('voice action drop_database {"confirmed":true}').intent, "unrecognized");
    assert.equal(parseTextCommand("voice action set_quote_status not-json").intent, "unrecognized");
  });
});
