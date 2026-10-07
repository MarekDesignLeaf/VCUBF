import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANONICAL_COMMAND, isExplicitVoiceLanguageChange, isGmailCancellationPhrase, isGmailConfirmationPhrase, parseStoredCommand, parseTextCommand } from "../src/lib/commandParser.js";
import { EMMA_EXECUTABLE_ACTION_GUIDE } from "../src/lib/emmaExecutableActionCatalogue.js";
import { VOICE_PAGE_ROUTES } from "../src/lib/voiceNavigation.js";
import { buildCommandUiAction } from "../src/lib/voiceNavigation.js";

// A sentence is read only in the language switched on.
const en = (text: string) => parseTextCommand(text, "en-GB");
const cs = (text: string) => parseTextCommand(text, "cs-CZ");
const pl = (text: string) => parseTextCommand(text, "pl-PL");

describe("commandParser", () => {
  it("parses 'create client' with email and phone", () => {
    const result = en("create client Jane Smith, email jane@example.com, phone 07700900000");
    assert.equal(result.intent, "create_client");
    if (result.intent === "create_client") {
      assert.equal(result.entities.display_name, "Jane Smith");
      assert.equal(result.entities.email_primary, "jane@example.com");
      assert.equal(result.entities.phone_primary, "07700900000");
    }
  });

  it("keeps and normalizes a phone number dictated with comma-separated digits", () => {
    const result = en("create client George, email george@gmail.com, phone 0,7,3,9,8,5,6,3,9,8");
    assert.deepEqual(result, {
      intent: "create_client",
      entities: {
        display_name: "George",
        email_primary: "george@gmail.com",
        phone_primary: "0739856398",
      },
    });
  });

  it("parses a bare 'add client' with no extra fields", () => {
    const result = en("add client Bob Jones");
    assert.equal(result.intent, "create_client");
    if (result.intent === "create_client") {
      assert.equal(result.entities.display_name, "Bob Jones");
      assert.equal(result.entities.email_primary, undefined);
    }
  });

  it("parses client edits and confirmed archival in English, Czech and Polish", () => {
    assert.deepEqual(en("change email for client Jane Smith to jane.new@example.com"), {
      intent: "update_client",
      entities: { client_name: "Jane Smith", email_primary: "jane.new@example.com" },
    });
    assert.deepEqual(cs("změň telefon klienta Jane Smith na +420 777 123 456"), {
      intent: "update_client",
      entities: { client_name: "Jane Smith", phone_primary: "+420 777 123 456" },
    });
    assert.deepEqual(en("rename client Jane Smith to Jane Brown"), {
      intent: "update_client",
      entities: { client_name: "Jane Smith", display_name: "Jane Brown" },
    });
    assert.deepEqual(pl("usuń klienta Jane Brown"), {
      intent: "prepare_archive_client",
      entities: { client_name: "Jane Brown" },
    });
    assert.equal(cs("potvrď smazání klienta").intent, "confirm_archive_client");
    assert.equal(en("cancel client deletion").intent, "cancel_archive_client");
  });

  it("parses contact creation, editing and confirmed archival", () => {
    assert.deepEqual(en("create contact Alice Green, email alice@example.com, phone 07700900001"), {
      intent: "create_contact",
      entities: { display_name: "Alice Green", email: "alice@example.com", phone: "07700900001" },
    });
    assert.deepEqual(en("change phone for contact Alice Green to +44 7700 900002"), {
      intent: "update_contact",
      entities: { contact_name: "Alice Green", phone: "+44 7700 900002" },
    });
    assert.deepEqual(en("archive contact Alice Green"), {
      intent: "prepare_archive_contact",
      entities: { contact_name: "Alice Green" },
    });
    assert.equal(en("confirm contact deletion").intent, "confirm_archive_contact");
    assert.equal(cs("zruš smazání kontaktu").intent, "cancel_archive_contact");
  });

  it("parses 'create lead' with a service and email", () => {
    const result = en("new lead Alice Green, email alice@example.com for fencing");
    assert.equal(result.intent, "create_lead");
    if (result.intent === "create_lead") {
      assert.equal(result.entities.name, "Alice Green");
      assert.equal(result.entities.service_requested, "fencing");
      assert.equal(result.entities.email, "alice@example.com");
    }
  });

  it("parses 'create job X for Y'", () => {
    const result = en("create job Hedge trimming for Jane Smith");
    assert.equal(result.intent, "create_job");
    if (result.intent === "create_job") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.client_name, "Jane Smith");
    }
  });

  it("parses 'set job X as scheduled'", () => {
    const result = en("set job Hedge trimming as scheduled");
    assert.equal(result.intent, "change_job_status");
    if (result.intent === "change_job_status") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.job_status, "scheduled");
    }
  });

  it("parses 'convert lead X'", () => {
    const result = en("convert lead Alice Green");
    assert.equal(result.intent, "convert_lead");
    if (result.intent === "convert_lead") {
      assert.equal(result.entities.lead_name, "Alice Green");
    }
  });

  it("parses list commands", () => {
    assert.equal(en("list clients").intent, "list_clients");
    assert.equal(en("show contacts").intent, "list_contacts");
    assert.deepEqual(en("read my emails"), { intent: "list_channel_messages", entities: { channel: "email" } });
    assert.deepEqual(en("show whatsapp messages"), { intent: "list_channel_messages", entities: { channel: "whatsapp" } });
    assert.equal(en("show jobs").intent, "list_jobs");
    assert.equal(en("list leads").intent, "list_leads");
  });

  it("parses reviewed notification deletion in English, Czech and Polish", () => {
    assert.equal(pl("powiadomienia").intent, "list_notifications");
    assert.equal(cs("ukaž oznámení").intent, "list_notifications");
    assert.equal(en("delete all notifications").intent, "prepare_delete_notifications");
    assert.equal(cs("smaž všechna oznámení").intent, "prepare_delete_notifications");
    assert.equal(pl("usuń wszystkie powiadomienia").intent, "prepare_delete_notifications");
    assert.equal(cs("mazání oznámení").intent, "prepare_delete_notifications");
    assert.equal(pl("usuwanie powiadomień").intent, "prepare_delete_notifications");
    assert.equal(en("confirm deleting notifications").intent, "confirm_delete_notifications");
    assert.equal(cs("potvrď smazání všech oznámení").intent, "confirm_delete_notifications");
    assert.equal(pl("potwierdź usunięcie wszystkich powiadomień").intent, "confirm_delete_notifications");
    assert.equal(en("cancel deleting notifications").intent, "cancel_delete_notifications");
    assert.equal(cs("zruš smazání všech oznámení").intent, "cancel_delete_notifications");
    assert.equal(pl("anuluj usunięcie wszystkich powiadomień").intent, "cancel_delete_notifications");
  });

  it("parses connector status, guided setup and synchronisation commands", () => {
    assert.deepEqual(en("check connectors"), { intent: "connector_status", entities: { connector_key: "all" } });
    assert.deepEqual(en("set up all connectors"), { intent: "setup_connectors", entities: { connector_key: "all" } });
    assert.deepEqual(en("configure Google Contacts"), { intent: "setup_connectors", entities: { connector_key: "google_contacts" } });
    assert.deepEqual(en("start WhatsApp Business connector"), { intent: "setup_connectors", entities: { connector_key: "whatsapp_business" } });
    assert.deepEqual(en("sync Gmail"), { intent: "sync_connectors", entities: { connector_key: "gmail" } });
    assert.deepEqual(cs("synchronizuj kalendář"), { intent: "sync_connectors", entities: { connector_key: "google_calendar" } });
    assert.deepEqual(pl("odśwież pocztę"), { intent: "sync_connectors", entities: { connector_key: "gmail" } });
  });

  it("parses a reviewed Gmail send command and explicit email confirmation controls", () => {
    assert.deepEqual(
      en("send email to jane@example.com and sam@example.com; cc accounts@example.com; bcc archive@example.com; subject Quote review; body Hello, please review the attached quote."),
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
    assert.deepEqual(en("send email to jane@example.com, subject Quick update, body I will call tomorrow."), {
      intent: "prepare_gmail_message",
      entities: { to: ["jane@example.com"], cc: [], bcc: [], subject: "Quick update", body: "I will call tomorrow." },
    });
    assert.equal(en("confirm email").intent, "confirm_gmail_message");
    assert.equal(en("cancel email").intent, "cancel_gmail_message");
    assert.equal(isGmailConfirmationPhrase("Yes.", "en-GB"), true);
    assert.equal(isGmailCancellationPhrase("Do not send", "en-GB"), true);
    assert.deepEqual(cs("pošli email na jane@example.com; předmět Nabídka; zpráva Dobrý den."), {
      intent: "prepare_gmail_message",
      entities: { to: ["jane@example.com"], cc: [], bcc: [], subject: "Nabídka", body: "Dobrý den." },
    });
    assert.deepEqual(pl("wyślij email do jane@example.com; temat Oferta; treść Dzień dobry."), {
      intent: "prepare_gmail_message",
      entities: { to: ["jane@example.com"], cc: [], bcc: [], subject: "Oferta", body: "Dzień dobry." },
    });
  });

  it("understands only the language switched on: Czech with Czech on, Polish only after switching to it", () => {
    const polish = ["usuń wszystkie powiadomienia", "zarchiwizuj klienta Jan Kowalski", "zmień email kontaktu Dvořák na new@example.com",
      "pokaż powiadomienia", "co mam jutro w kalendarzu", "przełącz na angielski", "otwórz oferty", "zapamiętaj że Kowalski płaci gotówką",
      "wyślij email do jane@example.com; temat Oferta; treść Dzień dobry."];
    const english = ["delete all notifications", "create client Jane Smith, email jane@example.com", "list clients", "switch to Polish",
      "open dashboard", "show calendar today", "speak faster", "who owes us money"];
    const czech = ["smaž všechna oznámení", "vytvoř klienta Jan Novák, email jan@example.com", "ukaž klienty", "přepni na polštinu",
      "otevři kalendář", "co mám zítra v kalendáři", "mluv rychleji", "kdo mi dluží", "zapamatuj si že klient platí převodem"];
    for (const sentence of [...polish, ...english]) assert.equal(cs(sentence).intent, "unrecognized", `Czech on: ${sentence}`);
    for (const sentence of [...czech, ...english]) assert.equal(pl(sentence).intent, "unrecognized", `Polish on: ${sentence}`);
    for (const sentence of [...polish, ...czech]) assert.equal(en(sentence).intent, "unrecognized", `English on: ${sentence}`);
    for (const sentence of polish) assert.notEqual(pl(sentence).intent, "unrecognized", `Polish on: ${sentence}`);
    for (const sentence of czech) assert.notEqual(cs(sentence).intent, "unrecognized", `Czech on: ${sentence}`);
    for (const sentence of english) assert.notEqual(en(sentence).intent, "unrecognized", `English on: ${sentence}`);
    // A sentence mixing the two is neither.
    assert.equal(cs("mazání powiadomienia").intent, "unrecognized");
    assert.equal(pl("mazání powiadomienia").intent, "unrecognized");
  });

  it("answers yes and no only in the language switched on", () => {
    assert.equal(isGmailConfirmationPhrase("Ano.", "cs-CZ"), true);
    assert.equal(isGmailConfirmationPhrase("potwierdzam", "cs-CZ"), false);
    assert.equal(isGmailConfirmationPhrase("yes", "cs-CZ"), false);
    assert.equal(isGmailConfirmationPhrase("potwierdzam", "pl-PL"), true);
    assert.equal(isGmailConfirmationPhrase("ano", "pl-PL"), false);
    assert.equal(isGmailCancellationPhrase("nie", "cs-CZ"), false);
    assert.equal(isGmailCancellationPhrase("ne", "cs-CZ"), true);
    // "zruš akci" answers the waiting review; it is not a task called "akci".
    assert.equal(cs("zruš akci").intent, "unrecognized");
    assert.equal(isGmailCancellationPhrase("zruš akci", "cs-CZ"), true);
  });

  it("reads the system's own canonical commands in English whatever language is on", () => {
    assert.equal(parseTextCommand("delete all notifications", CANONICAL_COMMAND).intent, "prepare_delete_notifications");
    assert.equal(parseTextCommand("set language pl-PL", CANONICAL_COMMAND).intent, "set_voice_language");
    // The exact confirmations the model and the companion are told to use.
    assert.equal(parseTextCommand("confirm delete notifications", CANONICAL_COMMAND).intent, "confirm_delete_notifications");
    assert.equal(parseTextCommand("cancel delete notifications", CANONICAL_COMMAND).intent, "cancel_delete_notifications");
    assert.equal(parseTextCommand("cancel action", CANONICAL_COMMAND).intent, "unrecognized", "a no to the waiting review, not a task called action");
    assert.equal(isGmailCancellationPhrase("cancel action", CANONICAL_COMMAND), true);
    assert.equal(isGmailConfirmationPhrase("confirm action", "cs-CZ"), true, "the companion's fixed confirmation");
    assert.equal(cs("confirm email").intent, "confirm_gmail_message");
    assert.equal(cs("voice action get_unpaid_invoices {}").intent, "execute_action");
  });

  it("reads every canonical form the language model is told to use", () => {
    const canonical: Array<[string, string]> = [
      ["create client Jane Smith, email jane@example.com, phone 07700900000", "create_client"],
      ["create lead Alice Green for fencing, email alice@example.com, phone 07700900001", "create_lead"],
      ["create job Hedge trim for Jane Smith", "create_job"],
      ["set job Hedge trim as scheduled", "change_job_status"],
      ["convert lead Alice Green", "convert_lead"],
      ["assign job Hedge trim to Test Worker", "assign_job"],
      ["show overload", "detect_overload"],
      ["create task for Test Worker: Prepare materials", "create_task"],
      ["create task Send quote, assigned to Test Admin, due 2027-01-04T09:00:00.000Z", "create_task"],
      ["list tasks", "list_tasks"],
      ["create service Fence repair, category Fencing", "create_service"],
      ["list quotes for Jane Smith", "list_quotes"],
      ["list job openings", "list_job_openings"],
      ["when I say RAL I mean Riverside Apartments Ltd", "create_learning_rule"],
      ["list learning rules", "list_learning_rules"],
      ["remember that invoices end in 001", "create_assistant_memory"],
      ["remember for the company that invoices end in 001", "create_assistant_memory"],
      ["what do you remember about invoices", "recall_assistant_memory"],
      ["log call with Jane Smith: discussed timeline", "log_communication"],
      ["list communications for Jane Smith", "list_communications"],
      ["log photo IMG_001.jpg for Jane Smith: kitchen", "log_portfolio_photo"],
      ["list photos for Jane Smith", "list_portfolio_photos"],
      ["list marketing photos", "list_portfolio_photos"],
      ["list follow ups", "list_follow_ups"],
      ["list unresolved enquiries from the last 7 days", "list_unresolved_enquiries"],
      ["list notifications", "list_notifications"],
      ["delete all notifications", "prepare_delete_notifications"],
      ["confirm delete notifications", "confirm_delete_notifications"],
      ["cancel delete notifications", "cancel_delete_notifications"],
      ["list contacts", "list_contacts"],
      ["show emails", "list_channel_messages"],
      ["show whatsapp messages", "list_channel_messages"],
      ["set language cs-CZ", "set_voice_language"],
      ["read full menu", "describe_menu"],
      ["read full menu section customers and work", "describe_menu"],
      ["show calendar today", "list_calendar_events"],
      ["show calendar tomorrow", "list_calendar_events"],
      ["show calendar next 7 days", "list_calendar_events"],
      ["send email to jane@example.com; subject Hi; body Hello", "prepare_gmail_message"],
      ["confirm email", "confirm_gmail_message"],
      ["cancel email", "cancel_gmail_message"],
      ["send WhatsApp to +447700900123; message Hello", "prepare_whatsapp_message"],
      ["confirm WhatsApp", "confirm_whatsapp_message"],
      ["cancel WhatsApp", "cancel_whatsapp_message"],
      ["check connectors", "connector_status"],
      ["set up all connectors", "setup_connectors"],
      ["set up Gmail", "setup_connectors"],
      ["sync all connectors", "sync_connectors"],
      ["sync Gmail", "sync_connectors"],
      ["show data quality issues", "list_data_quality"],
      ["show action patterns", "detect_action_patterns"],
      ["open dashboard", "navigate"],
      ["list clients", "list_clients"],
      ["list jobs", "list_jobs"],
      ["list leads", "list_leads"],
    ];
    for (const [command, intent] of canonical) {
      assert.equal(parseTextCommand(command, CANONICAL_COMMAND).intent, intent, command);
    }
  });

  it("leaves a way out of any language: its name alone switches to it", () => {
    for (const reader of ["cs-CZ", "pl-PL", "en-GB", "de-DE"]) {
      assert.deepEqual(parseTextCommand("English", reader), { intent: "set_voice_language", entities: { language: "en-GB" } }, reader);
      assert.deepEqual(parseTextCommand("čeština", reader), { intent: "set_voice_language", entities: { language: "cs-CZ" } }, reader);
    }
  });

  it("reads a written playbook step in whichever language it was written", () => {
    assert.equal(parseStoredCommand("list clients").intent, "list_clients");
    assert.equal(parseStoredCommand("ukaž klienty").intent, "list_clients");
    assert.equal(parseStoredCommand("pokaż powiadomienia").intent, "list_notifications");
  });

  it("keeps a named sending account out of the message, and never takes it from the body", () => {
    const named = (text: string) => {
      const parsed = text.startsWith("send") ? en(text) : cs(text);
      return parsed.intent === "prepare_gmail_message" ? parsed.entities : undefined;
    };
    assert.deepEqual(named("send email from my personal account to jane@example.com; subject Hi; body Hello."),
      { to: ["jane@example.com"], cc: [], bcc: [], subject: "Hi", body: "Hello.", from: "my personal account" });
    assert.equal(named("send email to jane@example.com from personal; subject Hi; body Hello.")?.from, "personal");
    assert.equal(named("send email to jane@example.com; from: personal; subject Hi; body Hello.")?.from, "personal");
    assert.equal(named("pošli e-mail z osobního účtu na jane@example.com; předmět Ahoj; zpráva Dobrý den.")?.from, "osobního účtu");
    assert.equal(named("pošli z firemního mailu e-mail na jane@example.com; předmět Ahoj; zpráva Dobrý den.")?.from, "firemního mailu");
    assert.equal(named("pošli e-mail na jane@example.com; z účtu: osobní; předmět Ahoj; zpráva Dobrý den.")?.from, "osobní");
    assert.equal(named("pošli e-mail na jane@example.com, z osobního, předmět Ahoj, zpráva Dobrý den.")?.from, "osobního");
    const polish = pl("wyślij e-mail z konta prywatnego do jane@example.com; temat Hej; treść Cześć");
    assert.equal(polish.intent === "prepare_gmail_message" ? polish.entities.from : undefined, "prywatnego", "once Polish is switched on");
    const inBody = named("send email to jane@example.com; subject Hi; body Hello, from my personal account.");
    assert.equal(inBody?.from, undefined);
    assert.equal(inBody?.body, "Hello, from my personal account.");
  });

  it("parses language changes in English, Czech and Polish", () => {
    assert.deepEqual(en("set language cs-CZ"), { intent: "set_voice_language", entities: { language: "cs-CZ" } });
    assert.deepEqual(en("switch language to Polish"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(en("Turn on Polish language now"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(cs("změň jazyk na francouzštinu"), { intent: "set_voice_language", entities: { language: "fr-FR" } });
    assert.deepEqual(cs("mluv německy"), { intent: "set_voice_language", entities: { language: "de-DE" } });
    assert.deepEqual(pl("mów po polsku"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(pl("zmień język na angielski"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(pl("Włącz angielski, brytyjski język, kurwa."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(pl("Przełącz na angielski język brytyjski."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(pl("Nie będę się kurwa prosił, przełącz to od razu na angielski język."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(pl("Chcę język na angielski, kurwa."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(pl("język NGB."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(pl("Ustaw język MGB."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(en("brytyjskim"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(cs("Přepni se do angličtiny."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(cs("Přepni se do češtiny."), { intent: "set_voice_language", entities: { language: "cs-CZ" } });
    assert.deepEqual(cs("Přepni jazyk do češtiny."), { intent: "set_voice_language", entities: { language: "cs-CZ" } });
    assert.deepEqual(cs("Změň jazyk Emmy na francouzštinu."), { intent: "set_voice_language", entities: { language: "fr-FR" } });
    assert.deepEqual(cs("Přepni se do němčiny."), { intent: "set_voice_language", entities: { language: "de-DE" } });
    assert.deepEqual(cs("Ne, přepni se okamžitě do angličtiny!"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(en("Switch to Polish"), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(en("Yes, switch to Polish."), { intent: "set_voice_language", entities: { language: "pl-PL" } });
    assert.deepEqual(parseTextCommand("Passe la langue en allemand.", "fr-FR"), { intent: "set_voice_language", entities: { language: "de-DE" } });
    assert.deepEqual(parseTextCommand("Wechsle die Sprache auf Spanisch.", "de-DE"), { intent: "set_voice_language", entities: { language: "es-ES" } });
    assert.deepEqual(en("Switch English."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(en("Switch Switch Englischspreche."), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Wechsle auf Englisch.", "de-DE"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Ich will Englisch.", "de-DE"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Kann ich Sprache Englisch?", "de-DE"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Sprache Englisch.", "de-DE"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(en("Tschechische Sprache."), { intent: "set_voice_language", entities: { language: "cs-CZ" } });
    assert.deepEqual(parseTextCommand("Bestell ENGB.", "de-DE"), { intent: "set_voice_language", entities: { language: "en-GB" } });
    assert.deepEqual(parseTextCommand("Cambia el idioma a italiano.", "es-ES"), { intent: "set_voice_language", entities: { language: "it-IT" } });
    assert.deepEqual(parseTextCommand("Cambia la lingua in francese.", "it-IT"), { intent: "set_voice_language", entities: { language: "fr-FR" } });
    assert.equal(isExplicitVoiceLanguageChange("změň jazyk na češtinu", "cs-CZ"), true);
    assert.equal(isExplicitVoiceLanguageChange("show me contacts", "en-GB"), false);
    assert.equal(isExplicitVoiceLanguageChange("mluv česky", "en-GB"), false);
  });

  it("parses calendar agenda requests in English, Czech and Polish", () => {
    assert.deepEqual(en("what is on my calendar tomorrow"), { intent: "list_calendar_events", entities: { period: "tomorrow" } });
    assert.deepEqual(cs("co mám zítra v kalendáři"), { intent: "list_calendar_events", entities: { period: "tomorrow" } });
    assert.deepEqual(pl("jakie mam jutro wydarzenia w kalendarzu"), { intent: "list_calendar_events", entities: { period: "tomorrow" } });
    assert.deepEqual(cs("ukaž kalendář na příštích 7 dní"), { intent: "list_calendar_events", entities: { period: "next_7_days" } });
  });

  it("parses reviewed WhatsApp messages in English, Czech and Polish", () => {
    assert.deepEqual(en("send WhatsApp to +447700900123; message Hello"), {
      intent: "prepare_whatsapp_message",
      entities: { to: "+447700900123", body: "Hello" },
    });
    assert.deepEqual(cs("pošli zprávu na WhatsApp na +420777123456 zpráva Ahoj"), {
      intent: "prepare_whatsapp_message",
      entities: { to: "+420777123456", body: "Ahoj" },
    });
    assert.deepEqual(pl("wyślij wiadomość na WhatsApp do +48500100200 wiadomość Cześć"), {
      intent: "prepare_whatsapp_message",
      entities: { to: "+48500100200", body: "Cześć" },
    });
    assert.equal(pl("potwierdź WhatsApp").intent, "confirm_whatsapp_message");
    assert.equal(cs("zruš zprávu na WhatsApp").intent, "cancel_whatsapp_message");
  });

  it("parses complete menu and named menu-subtree requests in English and Czech", () => {
    assert.deepEqual(en("read the full menu"), { intent: "describe_menu", entities: {} });
    assert.deepEqual(en("what is in the menu"), { intent: "describe_menu", entities: {} });
    assert.deepEqual(en("read full menu customers and work"), { intent: "describe_menu", entities: { section: "customers_and_work" } });
    assert.deepEqual(cs("přečti menu klienti"), { intent: "describe_menu", entities: { section: "customers_and_work" } });
    assert.deepEqual(cs("co je v menu obchod"), { intent: "describe_menu", entities: { section: "sales_and_finance" } });
  });

  it("parses direct navigation across the Secretary hierarchy", () => {
    assert.deepEqual(en("open dashboard"), { intent: "navigate", entities: { page: "dashboard" } });
    assert.deepEqual(en("Opan calendar."), { intent: "navigate", entities: { page: "calendar" } });
    assert.deepEqual(en("oppen quotes"), { intent: "navigate", entities: { page: "quotes" } });
    assert.deepEqual(en("go to invoices"), { intent: "navigate", entities: { page: "invoices" } });
    assert.deepEqual(en("take me to communication intake"), { intent: "navigate", entities: { page: "communication_intake" } });
    assert.deepEqual(en("show me business metrics"), { intent: "navigate", entities: { page: "metrics" } });
    assert.deepEqual(pl("otwórz oferty"), { intent: "navigate", entities: { page: "quotes" } });
    assert.deepEqual(pl("otwórz usługi"), { intent: "navigate", entities: { page: "services" } });
    assert.deepEqual(cs("otevři nabídky"), { intent: "navigate", entities: { page: "quotes" } });
    assert.deepEqual(parseTextCommand("öffne Angebote", "de-DE"), { intent: "navigate", entities: { page: "quotes" } });
    for (const [page, definition] of Object.entries(VOICE_PAGE_ROUTES)) {
      const command = en(`open ${definition.label}`);
      const uiAction = buildCommandUiAction(command.intent, {}, command.entities, "en-GB");
      assert.equal(uiAction?.kind, "navigate", definition.label);
      if (uiAction?.kind === "navigate") assert.equal(uiAction.path, definition.path, `${page}: ${definition.label}`);
    }
    assert.deepEqual(en("open reset password"), { intent: "navigate", entities: { page: "reset_password" } });
  });

  it("parses 'assign job X to Y'", () => {
    const result = en("assign job Hedge trimming to Test Worker");
    assert.equal(result.intent, "assign_job");
    if (result.intent === "assign_job") {
      assert.equal(result.entities.job_title, "Hedge trimming");
      assert.equal(result.entities.employee_name, "Test Worker");
    }
  });

  it("parses 'show overload'", () => {
    assert.equal(en("show overload").intent, "detect_overload");
    assert.equal(en("check overload").intent, "detect_overload");
  });

  it("parses unresolved enquiry commands with an optional evidence window", () => {
    const all = en("show unresolved enquiries");
    assert.equal(all.intent, "list_unresolved_enquiries");
    if (all.intent === "list_unresolved_enquiries") assert.equal(all.entities.since_days, undefined);

    const week = en("check unresolved enquiries from the last week");
    assert.equal(week.intent, "list_unresolved_enquiries");
    if (week.intent === "list_unresolved_enquiries") assert.equal(week.entities.since_days, 7);

    const days = en("find unresolved enquiries in last 3 days");
    assert.equal(days.intent, "list_unresolved_enquiries");
    if (days.intent === "list_unresolved_enquiries") assert.equal(days.entities.since_days, 3);
  });

  it("parses task creation and listing commands", () => {
    const assigned = en("create task for Test Worker: Prepare materials");
    assert.equal(assigned.intent, "create_task");
    if (assigned.intent === "create_task") {
      assert.equal(assigned.entities.title, "Prepare materials");
      assert.equal(assigned.entities.employee_name, "Test Worker");
    }

    const dated = en("create task Send quote, assigned to Test Admin, due 2027-01-04T09:00:00.000Z");
    assert.equal(dated.intent, "create_task");
    if (dated.intent === "create_task") {
      assert.equal(dated.entities.title, "Send quote");
      assert.equal(dated.entities.employee_name, "Test Admin");
      assert.equal(dated.entities.due_at, "2027-01-04T09:00:00.000Z");
    }
    assert.equal(en("list tasks").intent, "list_tasks");
  });

  it("parses task workflow status commands", () => {
    assert.deepEqual(en("start task Prepare quote"), {
      intent: "change_task_status",
      entities: { title: "Prepare quote", task_status: "in_progress" },
    });
    assert.deepEqual(en("complete task Prepare quote"), {
      intent: "change_task_status",
      entities: { title: "Prepare quote", task_status: "completed" },
    });
  });

  it("parses 'create service X, category Y'", () => {
    const result = en("create service Fence repair, category Fencing");
    assert.equal(result.intent, "create_service");
    if (result.intent === "create_service") {
      assert.equal(result.entities.name, "Fence repair");
      assert.equal(result.entities.category, "Fencing");
    }
  });

  it("parses a bare 'create service X' with no category", () => {
    const result = en("create service Hedge trim");
    assert.equal(result.intent, "create_service");
    if (result.intent === "create_service") {
      assert.equal(result.entities.name, "Hedge trim");
      assert.equal(result.entities.category, undefined);
    }
  });

  it("parses 'list quotes' and 'list quotes for X'", () => {
    const bare = en("list quotes");
    assert.equal(bare.intent, "list_quotes");
    if (bare.intent === "list_quotes") assert.equal(bare.entities.client_name, undefined);

    const scoped = en("show quotes for Quote Test Client");
    assert.equal(scoped.intent, "list_quotes");
    if (scoped.intent === "list_quotes") assert.equal(scoped.entities.client_name, "Quote Test Client");
  });

  it("parses 'list job openings'", () => {
    const result = en("list job openings");
    assert.equal(result.intent, "list_job_openings");
    assert.equal(en("show job opening").intent, "list_job_openings");
  });

  it("parses 'when I say X I mean Y' and 'teach me X means Y'", () => {
    const r1 = en("when I say old client I mean a client from the last two years");
    assert.equal(r1.intent, "create_learning_rule");
    if (r1.intent === "create_learning_rule") {
      assert.equal(r1.entities.term, "old client");
      assert.equal(r1.entities.meaning, "a client from the last two years");
    }

    const r2 = en("teach me: Riverside means Riverside Apartments Ltd");
    assert.equal(r2.intent, "create_learning_rule");
    if (r2.intent === "create_learning_rule") {
      assert.equal(r2.entities.term, "Riverside");
      assert.equal(r2.entities.meaning, "Riverside Apartments Ltd");
    }
  });

  it("parses 'list learning rules'", () => {
    assert.equal(en("list learning rules").intent, "list_learning_rules");
    assert.equal(en("show learning rule").intent, "list_learning_rules");
  });

  it("parses explicit personal and company memory commands in English and Czech", () => {
    assert.deepEqual(en("remember that invoice numbers use YYYY-001"), {
      intent: "create_assistant_memory",
      entities: { content: "invoice numbers use YYYY-001", scope: "personal" },
    });
    assert.deepEqual(en("remember for the company that invoice numbers use YYYYMMDD-001"), {
      intent: "create_assistant_memory",
      entities: { content: "invoice numbers use YYYYMMDD-001", scope: "company" },
    });
    assert.deepEqual(cs("zapamatuj si, že čísla faktur začínají rokem"), {
      intent: "create_assistant_memory",
      entities: { content: "čísla faktur začínají rokem", scope: "personal" },
    });
    assert.deepEqual(cs("zapamatuj si ze invoice cisla konci 001"), {
      intent: "create_assistant_memory",
      entities: { content: "invoice cisla konci 001", scope: "personal" },
    });
    assert.deepEqual(cs("zapamatuj si pro firmu, že faktury končí trojčíslím 001"), {
      intent: "create_assistant_memory",
      entities: { content: "faktury končí trojčíslím 001", scope: "company" },
    });
  });

  it("stores a dictated memory even when the conjunction is not spoken", () => {
    assert.deepEqual(en("remember the client pays by transfer"), {
      intent: "create_assistant_memory",
      entities: { content: "the client pays by transfer", scope: "personal" },
    });
    assert.deepEqual(cs("zapamatuj si klient platí převodem"), {
      intent: "create_assistant_memory",
      entities: { content: "klient platí převodem", scope: "personal" },
    });
    assert.deepEqual(cs("zapamatuj si pro firmu faktury končí 001"), {
      intent: "create_assistant_memory",
      entities: { content: "faktury končí 001", scope: "company" },
    });
    assert.deepEqual(en("remember for the company invoices end in 001"), {
      intent: "create_assistant_memory",
      entities: { content: "invoices end in 001", scope: "company" },
    });
  });

  it("parses Polish memory commands", () => {
    assert.deepEqual(pl("zapamiętaj, że klient płaci przelewem"), {
      intent: "create_assistant_memory",
      entities: { content: "klient płaci przelewem", scope: "personal" },
    });
    assert.deepEqual(pl("zapamiętaj sobie klient płaci przelewem"), {
      intent: "create_assistant_memory",
      entities: { content: "klient płaci przelewem", scope: "personal" },
    });
    assert.deepEqual(pl("zapamiętaj dla firmy faktury kończą się na 001"), {
      intent: "create_assistant_memory",
      entities: { content: "faktury kończą się na 001", scope: "company" },
    });
    assert.deepEqual(pl("co pamiętasz o kliencie?"), {
      intent: "recall_assistant_memory",
      entities: { query: "kliencie" },
    });
  });

  it("parses memory recall commands", () => {
    assert.deepEqual(en("what do you remember about invoice numbers?"), {
      intent: "recall_assistant_memory",
      entities: { query: "invoice numbers" },
    });
    assert.deepEqual(cs("co si pamatuješ o fakturách?"), {
      intent: "recall_assistant_memory",
      entities: { query: "fakturách" },
    });
    assert.deepEqual(cs("co máš v paměti"), {
      intent: "recall_assistant_memory",
      entities: { query: undefined },
    });
    assert.deepEqual(cs("co si pamatujes o invoices?"), {
      intent: "recall_assistant_memory",
      entities: { query: "invoices" },
    });
  });

  it("returns unrecognized for gibberish instead of guessing", () => {
    const result = en("please make the weather nicer today");
    assert.equal(result.intent, "unrecognized");
  });

  it("parses only allowlisted structured Emma actions", () => {
    assert.deepEqual(en('voice action set_quote_status {"quote_title":"Kitchen","quote_status":"sent"}'), {
      intent: "execute_action",
      entities: { action: "set_quote_status", parameters: { quote_title: "Kitchen", quote_status: "sent" } },
    });
    assert.equal(en('voice action drop_database {"confirmed":true}').intent, "unrecognized");
    assert.equal(en("voice action set_quote_status not-json").intent, "unrecognized");
    assert.equal(en('voice action set_quote_status {"quote_title":"Kitchen","quote_status":"invented"}').intent, "unrecognized");
  });

  it("accepts an allowlisted action that arrives without the voice action prefix", () => {
    assert.deepEqual(en("get_unpaid_invoices {}"), {
      intent: "execute_action",
      entities: { action: "get_unpaid_invoices", parameters: {} },
    });
    assert.deepEqual(en('set_quote_status {"quote_title":"Kitchen","quote_status":"sent"}'), {
      intent: "execute_action",
      entities: { action: "set_quote_status", parameters: { quote_title: "Kitchen", quote_status: "sent" } },
    });
    // Dropping the prefix must not widen what may run.
    assert.equal(en('drop_database {"confirmed":true}').intent, "unrecognized");
    assert.equal(en('set_quote_status {"quote_title":"Kitchen","quote_status":"invented"}').intent, "unrecognized");
  });

  it("answers the spoken money questions from one allowlisted invoice action", () => {
    const asked = [
      "Kolik mam nezaplacenych faktur?",
      "Kolik máme neuhrazených faktury",
      "Kdo mi nezaplatil?",
      "Kdo nám dluží",
      "Who owes us money?",
      "Who hasn\u2019t paid us",
      "How much are we owed?",
      "unpaid invoices",
    ];
    for (const question of asked) {
      assert.deepEqual(
        /^(?:who|how|unpaid)/i.test(question) ? en(question) : cs(question),
        { intent: "execute_action", entities: { action: "get_unpaid_invoices", parameters: {} } },
        question,
      );
    }
    // A question about money we owe is not the same question and must not be
    // answered with our own receivables.
    assert.equal(en("How much do we owe?").intent, "unrecognized");
    assert.equal(cs("Komu dlužíme?").intent, "unrecognized");
  });

  it("shows every allowlisted action to the model in its full canonical form", () => {
    for (const line of EMMA_EXECUTABLE_ACTION_GUIDE.split("\n")) {
      assert.match(line, /^- voice action [a-z_]+ \{/);
    }
  });
});
