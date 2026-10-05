import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spokenError, spokenOutcome, spokenReview } from "../src/lib/spokenActionMessages.js";
import { addDays, localDateTime } from "../src/lib/spokenDate.js";

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
