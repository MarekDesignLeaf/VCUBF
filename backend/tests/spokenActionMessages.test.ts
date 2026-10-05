import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spokenChannelMessages, spokenError, spokenOutcome, spokenReview } from "../src/lib/spokenActionMessages.js";
import { addDays, localDateTime } from "../src/lib/spokenDate.js";
import { speechChunks } from "../src/services/voiceSpeechService.js";

// A review is only a review if the person hears what will happen. These
// sentences are what Alfonzo says before the yes: who, the exact words or the
// exact time, in the user's own language, ending with the question the yes
// answers. They word only the facts the service returned.

const ZONE = "Europe/London";
const tomorrow = () => addDays(localDateTime(new Date(), ZONE).date, 1);

describe("Spoken reviews", () => {
  it("reads a WhatsApp reply back with recipient, original message and the exact English text", () => {
    const preview = { to: "+447700900111", recipientName: "Honza Novák", inReplyTo: { text: "What time will you arrive?" }, body: "Hello, we will arrive on Monday at eight.", sentIn: "English (United Kingdom)" };
    assert.equal(
      spokenReview("reply_whatsapp", preview, "cs-CZ"),
      "Odpověď pro Honza Novák na zprávu „What time will you arrive?“. Pošlu anglicky: „Hello, we will arrive on Monday at eight.“. Mám ji odeslat?",
    );
    assert.match(spokenReview("reply_whatsapp", preview, "en-GB")!, /I will send in English: “Hello, we will arrive on Monday at eight\.”\. Shall I send it\?$/);
  });

  it("reads a calendar entry back with the day, time, an assumed length and clashes", () => {
    const day = tomorrow();
    const spoken = spokenReview("create_calendar_event", {
      title: "Prohlídka zahrady", date: day, allDay: false, start: "08:00", end: "09:00", timeZone: ZONE, durationAssumed: true,
      clashes: [{ title: "Telefon s dodavatelem", start: { date: day, time: "08:30" } }],
    }, "cs-CZ")!;
    assert.match(spokenEscape(spoken), /^Zapíšu „Prohlídka zahrady“ zítra \d{1,2}\. \S+ od 08:00 do 09:00\. Délku jste neřekl, počítám hodinu\. Pozor, v tu dobu už je v kalendáři: Telefon s dodavatelem \(08:30\)\. Mám to zapsat\?$/);
  });

  it("names a weekday with the right Czech preposition when the day is not today or tomorrow", () => {
    const spoken = spokenReview("cancel_calendar_event", { title: "Kontrola", when: { date: "2030-01-02", allDay: true }, timeZone: ZONE }, "cs-CZ")!;
    assert.equal(spoken, "Zruším „Kontrola“ na celý den ve středu 2. ledna. Mám ji zrušit?");
  });

  it("reads a move as from and to", () => {
    const spoken = spokenReview("move_calendar_event", {
      title: "Návštěva u Dvořáků", timeZone: ZONE,
      from: { date: "2030-01-03", allDay: false, start: "10:00", end: "11:30" },
      to: { date: "2030-01-03", allDay: false, start: "14:00", end: "15:30" },
    }, "en-GB")!;
    assert.equal(spoken, "I will move “Návštěva u Dvořáků”. Now: on Thursday 3 January from 10:00 to 11:30. New time: on Thursday 3 January from 14:00 to 15:30. Shall I move it?");
  });

  it("never shortens the words that will actually be sent", () => {
    const long = "Hello, ".repeat(120).trim();
    assert.ok(spokenReview("send_whatsapp", { to: "+447700900111", body: long }, "en-GB")!.includes(long));
    const email = spokenReview("send_email", { to: ["jan@example.com"], subject: "Quote", body: long, sentIn: "English (United Kingdom)" }, "cs-CZ")!;
    assert.ok(email.includes(long));
    assert.match(email, /^Pošlu e-mail na jan@example\.com anglicky\. Předmět: „Quote“\./);
  });

  it("says when an event ends on a later day, and the last day of a multi-day event", () => {
    const overnight = spokenReview("create_calendar_event", { title: "Noční práce", date: "2030-01-03", allDay: false, start: "22:00", end: "01:00", endDate: "2030-01-04", timeZone: ZONE }, "cs-CZ")!;
    assert.equal(overnight, "Zapíšu „Noční práce“ od čtvrtka 3. ledna 22:00 do pátku 4. ledna 01:00. Mám to zapsat?");
    const holiday = spokenReview("cancel_calendar_event", { title: "Dovolená", when: { date: "2030-01-07", lastDate: "2030-01-11", allDay: true }, timeZone: ZONE }, "en-GB")!;
    assert.equal(holiday, "I will cancel “Dovolená” all day from Monday 7 January to Friday 11 January. Shall I cancel it?");
  });

  it("says what happened after the yes, and refuses in plain words", () => {
    assert.equal(spokenOutcome("reply_whatsapp", {}, "cs-CZ"), "Zpráva je odeslaná.");
    assert.equal(spokenOutcome("create_calendar_event", { alreadyCreated: true }, "cs-CZ"), "Tahle událost už v kalendáři je, druhou jsem nezapsal.");
    assert.match(spokenError("WHATSAPP_REPLY_WINDOW_CLOSED", undefined, "cs-CZ")!, /před víc než 24 hodinami/);
    assert.equal(spokenError("AMBIGUOUS_REFERENCE", { candidates: ["Jan Novák", "Jan Dvořák"] }, "cs-CZ"), "Na to sedí víc možností: Jan Novák, Jan Dvořák. Řekněte prosím přesněji, kterou myslíte.");
    assert.equal(spokenError("SOMETHING_ELSE", undefined, "cs-CZ"), undefined, "unknown errors keep the service's own text");
    assert.equal(spokenReview("unknown_action", { to: "x" }, "cs-CZ"), undefined);
  });
});

function spokenEscape(value: string) { return value.replace(/ /g, " "); }

describe("Reading received messages aloud", () => {
  it("reads the newest messages with sender, age, text and whether they were answered", () => {
    const now = new Date("2026-10-05T20:00:00Z");
    const spoken = spokenChannelMessages("whatsapp", {
      items: [
        { sender: "Honza Novák", text: "What time will you arrive?", receivedAt: new Date("2026-10-05T18:00:00Z"), replied: true },
        { sender: "+447700900222", text: "Thanks for the quote.", receivedAt: new Date("2026-10-04T19:00:00Z"), replied: false },
      ],
      unansweredToday: 1,
    }, "cs-CZ", now);
    assert.equal(spoken, "Poslední zprávy na WhatsAppu: 1. Honza Novák, před 2 hodinami: „What time will you arrive?“. Odpovězeno. 2. +447700900222, včera: „Thanks for the quote.“. Bez odpovědi. Za posledních 24 hodin zůstává bez odpovědi 1. Odpovědět můžete třeba: odpověz Honzovi, že…");
    assert.equal(spokenChannelMessages("whatsapp", { items: [], unansweredToday: 0 }, "en-GB"), "There are no received WhatsApp messages.");
  });
});

describe("Long reviews are heard in full", () => {
  it("splits a long reply at sentence ends into pieces the voice service accepts, losing nothing", () => {
    const text = Array.from({ length: 300 }, (_, index) => `Sentence number ${index} of the reviewed message.`).join(" ");
    const chunks = speechChunks(text);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 3800, `chunk of ${chunk.length}`);
    assert.equal(chunks.join(" "), text, "every word is still spoken, in order");
    assert.ok(chunks.slice(0, -1).every((chunk) => chunk.endsWith(".")), "pieces end at sentence ends");
  });

  it("names the account an email leaves from, and asks when that is unclear", () => {
    const spoken = spokenReview("send_email", { fromAccount: "marek@designleaf.co.uk", to: ["jan@example.com"], subject: "Quote", body: "Hello.", sentIn: "English (United Kingdom)" }, "cs-CZ")!;
    assert.equal(spoken, "Pošlu z účtu marek@designleaf.co.uk e-mail na jan@example.com anglicky. Předmět: „Quote“. Text: „Hello.“. Mám ho odeslat?");
    assert.equal(
      spokenError("AMBIGUOUS_GMAIL_SOURCE", { accounts: ["Business Gmail (marek@designleaf.co.uk)", "Osobní Gmail (marek.private@gmail.com)"] }, "cs-CZ"),
      "Mám připojených víc e-mailových účtů: Business Gmail (marek@designleaf.co.uk), Osobní Gmail (marek.private@gmail.com). Řekněte, ze kterého mám poslat, nebo v Konektorech nastavte výchozí účet pro odesílání.",
    );
    assert.equal(spokenOutcome("set_default_email_account", { accountEmail: "marek@designleaf.co.uk" }, "cs-CZ"), "E-maily teď budu posílat z účtu marek@designleaf.co.uk, pokud neřeknete jiný.");
  });

  it("says copy and blind copy separately", () => {
    const spoken = spokenReview("send_email", { to: ["a@example.com"], cc: ["b@example.com"], bcc: ["c@example.com"], subject: "S", body: "B" }, "cs-CZ")!;
    assert.equal(spoken, "Pošlu e-mail na a@example.com, v kopii b@example.com, ve skryté kopii c@example.com. Předmět: „S“. Text: „B“. Mám ho odeslat?");
  });
});
