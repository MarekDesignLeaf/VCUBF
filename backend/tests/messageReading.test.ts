import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANONICAL_COMMAND, parseTextCommand, readingControl } from "../src/lib/commandParser.js";
import { spokenNothingBeingRead, spokenReadingTurn } from "../src/lib/spokenActionMessages.js";
import { groupBySender, MESSAGES_PER_TURN, turnAt, type ReadingPlace, type SenderGroup } from "../src/services/messageReadingService.js";

// Reading received messages one sender at a time (Marek, 10. 10.: "když řeknu
// přeskoč ho, musí začít číst zprávy od dalšího uživatele"). Someone who wrote
// ten times used to fill the whole answer; now each answer is one sender, and
// "přeskoč" moves to the next.

const NOW = new Date("2026-10-10T20:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

function row(id: string, name: string, phone: string, text: string, hours: number, replied = false) {
  return {
    id,
    senderName: name,
    senderEmail: null,
    senderPhone: phone,
    messageText: text,
    receivedAt: hoursAgo(hours),
    sourceMetadata: replied ? { replies: [{ messageId: `wamid.${id}` }] } : null,
  };
}

// Petra wrote five times, Honza twice, Jana once; Honza wrote last.
const ROWS = [
  row("p1", "Petra Dvořáková", "+447700900222", "Petra 1", 2),
  row("p2", "Petra Dvořáková", "+447700900222", "Petra 2", 3, true),
  row("p3", "Petra Dvořáková", "+447700900222", "Petra 3", 4),
  row("p4", "Petra Dvořáková", "+447700900222", "Petra 4", 5),
  row("p5", "Petra Dvořáková", "+447700900222", "Petra 5", 30),
  row("h1", "Honza Novák", "+447700900111", "Honza 1", 1),
  row("h2", "Honza Novák", "+447700900111", "Honza 2", 26),
  row("j1", "Jana", "+447700900333", "Jana 1", 50),
];

const start = (groups: SenderGroup[]): ReadingPlace => ({ channel: "whatsapp", order: groups.map((group) => group.key), index: 0 });
// "přeskoč": the sender after this place, from their newest message.
const nextSender = (place: ReadingPlace): ReadingPlace => ({ channel: place.channel, order: place.order, index: place.index + 1 });

describe("grouping messages by sender", () => {
  it("puts the sender who wrote last first, each sender's messages newest first", () => {
    const groups = groupBySender(ROWS, "whatsapp");
    assert.deepEqual(groups.map((group) => [group.sender, group.messages.length]), [["Honza Novák", 2], ["Petra Dvořáková", 5], ["Jana", 1]]);
    assert.deepEqual(groups[1].messages.map((message) => message.text), ["Petra 1", "Petra 2", "Petra 3", "Petra 4", "Petra 5"]);
    assert.equal(groups[1].messages[1].replied, true);
    assert.equal(groups[1].messages[0].replied, false, "a WhatsApp message without a reply from here is unanswered");
  });

  it("tells WhatsApp senders apart by number, not by the name they gave", () => {
    const groups = groupBySender([
      row("a", "Jan", "+447700900001", "first Jan", 1),
      row("b", "Jan", "+447700900002", "second Jan", 2),
      row("c", "Jan N.", "+447700900001", "first Jan again", 3),
    ], "whatsapp");
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].messages.map((message) => message.text), ["first Jan", "first Jan again"]);
  });

  it("groups e-mail by address whatever its case, and claims an answer only when one left from here", () => {
    const groups = groupBySender([
      { id: "e1", senderName: "Jan", senderEmail: "Jan@Example.com", senderPhone: null, messageText: "Subject: A", receivedAt: hoursAgo(1), sourceMetadata: null },
      { id: "e2", senderName: null, senderEmail: "jan@example.com", senderPhone: null, messageText: "Subject: B", receivedAt: hoursAgo(2), sourceMetadata: { replies: [{}] } },
    ], "email");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].messages[0].replied, undefined, "it may have been answered from Gmail");
    assert.equal(groups[0].messages[1].replied, true);
  });
});

describe("moving through a reading", () => {
  it("reads one sender per answer, at most a few messages, and names who is next", () => {
    const groups = groupBySender(ROWS, "whatsapp");
    const first = turnAt(groups, start(groups));
    assert.equal(first.turn.sender?.name, "Honza Novák");
    assert.equal(first.turn.sender?.messages.length, 2);
    assert.deepEqual(first.turn.next, { sender: "Petra Dvořáková", count: 5 });
    assert.equal(first.turn.done, false);

    // "přeskoč": the next sender, from their newest message.
    const second = turnAt(groups, nextSender(first.place));
    assert.equal(second.turn.sender?.name, "Petra Dvořáková");
    assert.equal(second.turn.sender?.messages.length, MESSAGES_PER_TURN);
    assert.equal(second.turn.sender?.olderLeft, 5 - MESSAGES_PER_TURN);

    // "starší": more from the same sender, where the last answer stopped.
    const older = turnAt(groups, second.place);
    assert.deepEqual(older.turn.sender?.messages.map((message) => message.text), ["Petra 4", "Petra 5"]);
    assert.equal(older.turn.sender?.alreadyRead, MESSAGES_PER_TURN);
    assert.equal(older.turn.sender?.olderLeft, 0);
    assert.equal(older.turn.next?.sender, "Jana");

    // Nothing older left: said so, and the next sender is still named.
    const none = turnAt(groups, older.place);
    assert.equal(none.turn.sender?.messages.length, 0);
    assert.equal(none.turn.next?.sender, "Jana");

    const last = turnAt(groups, nextSender(older.place));
    assert.equal(last.turn.sender?.name, "Jana");
    assert.equal(last.turn.next, undefined);
    assert.equal(last.turn.done, true);

    const beyond = turnAt(groups, nextSender(last.place));
    assert.equal(beyond.turn.sender, undefined);
    assert.equal(beyond.turn.done, true);
  });

  it("keeps the announced order when someone writes again, and adds a new sender last", () => {
    const before = groupBySender(ROWS, "whatsapp");
    const place = { ...start(before), index: 1 };
    // Jana writes now (she would sort first) and Karel writes for the first time.
    const after = groupBySender([...ROWS, row("j2", "Jana", "+447700900333", "Jana 2", 0), row("k1", "Karel", "+447700900444", "Karel 1", 0)], "whatsapp");
    const { turn, place: next } = turnAt(after, place);
    assert.equal(turn.sender?.name, "Petra Dvořáková", "still the sender the user was told comes next");
    assert.equal(turn.next?.sender, "Jana");
    assert.equal(next.order[next.order.length - 1], "+447700900444", "the new sender goes last");
  });

  it("continues \"starší\" from the last message read, even when the sender writes again meanwhile", () => {
    const before = groupBySender(ROWS, "whatsapp");
    const petra = turnAt(before, { ...start(before), index: 1 });
    assert.deepEqual(petra.turn.sender?.messages.map((message) => message.text), ["Petra 1", "Petra 2", "Petra 3"]);
    // Petra writes again before "starší": nothing is read twice and nothing older is stepped over.
    const after = groupBySender([...ROWS, row("p0", "Petra Dvořáková", "+447700900222", "Petra 0", 0)], "whatsapp");
    const older = turnAt(after, petra.place);
    assert.deepEqual(older.turn.sender?.messages.map((message) => message.text), ["Petra 4", "Petra 5"]);
    assert.equal(older.turn.sender?.olderLeft, 0);
  });

  it("passes over a sender whose messages are gone", () => {
    const before = groupBySender(ROWS, "whatsapp");
    const after = groupBySender(ROWS.filter((message) => !message.id.startsWith("p")), "whatsapp");
    const { turn } = turnAt(after, { ...start(before), index: 1 });
    assert.equal(turn.sender?.name, "Jana");
  });
});

describe("the words that move through a reading", () => {
  const senders = ["Petra Dvořáková", "Honza Novák"];
  const cs = (text: string) => readingControl(text, "cs-CZ", { addressedAs: ["Alfonzo"], senders })?.intent;
  const pl = (text: string) => readingControl(text, "pl-PL", { senders: ["Ewa Nowak", "Jan Kowalski"] })?.intent;
  const en = (text: string) => readingControl(text, "en-GB", { senders: ["John Smith", "Petra"] })?.intent;

  it("hears skipping and older messages in Czech, as dictation writes them", () => {
    for (const text of ["Přeskoč ho.", "přeskoč", "Přeskoč, ho!", "Přeskočte.", "Další.", "dalšího", "dál", "přejdi na dalšího", "přejdi na další", "přečti další", "Alfonzo, přeskoč ho", "tak další", "další odesílatel"]) {
      assert.equal(cs(text), "next_message_sender", text);
    }
    for (const text of ["Starší.", "starší zprávy", "přečti starší zprávy", "ještě od něj", "další zprávy od ní", "přečti i starší", "víc"]) {
      assert.equal(cs(text), "older_sender_messages", text);
    }
    for (const text of ["přečti zprávy na WhatsAppu", "ano", "další faktura je po splatnosti", "kdo je další na řadě dnes odpoledne", "přeskočil jsem to"]) {
      assert.equal(cs(text), undefined, text);
    }
  });

  it("leaves \"pokračuj\" and \"continue\" to the Windows companion, which asks for them to read on", () => {
    for (const text of ["Pokračuj.", "pokračuj ve čtení", "čti dál"]) assert.equal(cs(text), undefined, text);
    for (const text of ["continue", "go on", "keep going"]) assert.equal(en(text), undefined, text);
    assert.equal(pl("kontynuuj"), undefined);
  });

  it("takes words after \"přeskoč\" only when they name the sender read or the one next", () => {
    assert.deepEqual(readingControl("přeskoč Petru", "cs-CZ", { senders }), { intent: "next_message_sender", entities: { sender: "petru" } });
    assert.equal(cs("přeskoč pana Nováka"), "next_message_sender");
    assert.equal(cs("přeskoč zítřejší zakázku"), undefined, "names nobody being read: left for the model");
    assert.equal(cs("přeskoč Karla"), undefined);
    assert.equal(en("skip Mr Smith"), "next_message_sender");
    assert.equal(en("skip tomorrow's job"), undefined);
    assert.equal(pl("pomiń Ewę"), "next_message_sender");
    assert.equal(pl("pomiń jutrzejsze zlecenie"), undefined);
    assert.equal(readingControl("přeskoč Petru", "cs-CZ"), undefined, "without the senders nothing can be named");
  });

  it("reads Czech words only with Czech on, and Polish and English in their own language", () => {
    assert.equal(readingControl("přeskoč ho", "en-GB"), undefined);
    assert.equal(readingControl("skip him", "cs-CZ"), undefined);
    for (const text of ["pomiń go", "Dalej.", "następny", "przejdź dalej", "przejdź do następnego"]) assert.equal(pl(text), "next_message_sender", text);
    for (const text of ["starsze", "przeczytaj starsze wiadomości", "więcej od niego", "więcej"]) assert.equal(pl(text), "older_sender_messages", text);
    for (const text of ["Skip him.", "skip", "next", "next one", "move on"]) assert.equal(en(text), "next_message_sender", text);
    for (const text of ["older", "read the older ones", "more from her", "read older messages from this sender", "more", "read more"]) assert.equal(en(text), "older_sender_messages", text);
    assert.equal(readingControl("další", "de-DE"), undefined, "languages without a grammar recognise none of it");
  });

  it("gives the model one canonical form for each, read whether or not anything is being read", () => {
    assert.equal(parseTextCommand("skip to the next sender", CANONICAL_COMMAND).intent, "next_message_sender");
    assert.equal(parseTextCommand("read older messages from this sender", CANONICAL_COMMAND).intent, "older_sender_messages");
    // A bare "další" is not a command by itself; only a reading in progress gives it meaning.
    assert.equal(parseTextCommand("další", "cs-CZ").intent, "unrecognized");
  });

  it("starts a reading of WhatsApp or e-mail without the model, full stop and all", () => {
    for (const text of ["Přečti zprávy na WhatsAppu.", "ukaž mi WhatsApp", "přečti WhatsAppové zprávy", "Přečti e-maily.", "ukaž poštu", "přečti zprávy z e-mailu"]) {
      const command = parseTextCommand(text, "cs-CZ");
      assert.equal(command.intent, "list_channel_messages", text);
    }
    assert.deepEqual(parseTextCommand("Přečti zprávy na WhatsAppu.", "cs-CZ").entities, { channel: "whatsapp" });
    assert.deepEqual(parseTextCommand("Přečti e-maily.", "cs-CZ").entities, { channel: "email" });
    assert.deepEqual(parseTextCommand("přečti zprávy v e-mailu", "cs-CZ").entities, { channel: "email" });
    assert.deepEqual(parseTextCommand("Przeczytaj wiadomości z WhatsAppa.", "pl-PL").entities, { channel: "whatsapp" });
    assert.deepEqual(parseTextCommand("pokaż e-maile", "pl-PL").entities, { channel: "email" });
  });
});

describe("what Alfonzo says while reading", () => {
  const groups = groupBySender(ROWS, "whatsapp");

  it("first says who has written, then reads the first sender, says who is next and how to move on", () => {
    const { turn } = turnAt(groups, start(groups));
    const spoken = spokenReadingTurn({
      ...turn,
      overview: { senders: groups.map((group) => ({ sender: group.sender, count: group.messages.length })), unansweredToday: 4 },
    }, "cs-CZ", NOW);
    assert.equal(spoken, "Na WhatsAppu máte zprávy od 3 odesílatelů: Honza Novák 2 zprávy, Petra Dvořáková 5 zpráv a Jana 1 zpráva. "
      + "Za posledních 24 hodin zůstává bez odpovědi 4. "
      + "Honza Novák. Před hodinou: „Honza 1“. Bez odpovědi. Včera: „Honza 2“. Bez odpovědi. "
      + "Další je Petra Dvořáková. Řekněte „přeskoč“ pro dalšího odesílatele. "
      + "Odpovědět můžete třeba: odpověz Honzovi, že…");
  });

  it("after a skip reads the next sender with how many older ones remain", () => {
    const place = { ...start(groups), index: 1 };
    const { turn } = turnAt(groups, place);
    assert.equal(spokenReadingTurn(turn, "cs-CZ", NOW),
      "Petra Dvořáková, 5 zpráv. Před 2 hodinami: „Petra 1“. Bez odpovědi. Před 3 hodinami: „Petra 2“. Odpovězeno. Před 4 hodinami: „Petra 3“. Bez odpovědi. "
      + "Ještě 2 starší zprávy. Další je Jana.");
    assert.equal(spokenReadingTurn(turn, "en-GB", NOW),
      "Petra Dvořáková, 5 messages. 2 hours ago: „Petra 1“. Not answered. 3 hours ago: „Petra 2“. Answered. 4 hours ago: „Petra 3“. Not answered. "
      + "2 older messages left. Next is Jana.");
    assert.match(spokenReadingTurn(turn, "pl-PL", NOW), /^Petra Dvořáková, 5 wiadomości\. 2 godziny temu: „Petra 1“\. Bez odpowiedzi\..* Jeszcze 2 starsze wiadomości\. Następny nadawca: Jana\.$/);
  });

  it("says when a sender has nothing older, when nobody is next, and when everything has been read", () => {
    const petra = { ...start(groups), index: 1, readTo: { at: hoursAgo(30).getTime(), id: "p5" } };
    assert.equal(spokenReadingTurn(turnAt(groups, petra).turn, "cs-CZ", NOW), "Starší zprávy od tohoto odesílatele už nejsou. Další je Jana.");
    const jana = turnAt(groups, { ...start(groups), index: 2 }).turn;
    assert.equal(spokenReadingTurn(jana, "cs-CZ", NOW), "Jana. Před 2 dny: „Jana 1“. Bez odpovědi. To jsou všechny zprávy.");
    const beyond = turnAt(groups, { ...start(groups), index: 3 }).turn;
    assert.equal(spokenReadingTurn(beyond, "cs-CZ", NOW), "Další odesílatel už není. To jsou všechny zprávy.");
    assert.equal(spokenReadingTurn(beyond, "en-GB", NOW), "There is no next sender. Those are all the messages.");
  });

  it("reads a single sender without an overview, and nothing at all as nothing", () => {
    const honza = groupBySender(ROWS.filter((message) => message.id.startsWith("h")), "whatsapp");
    const { turn } = turnAt(honza, start(honza));
    assert.equal(spokenReadingTurn({ ...turn, overview: { senders: [{ sender: "Honza Novák", count: 2 }], unansweredToday: 0 } }, "en-GB", NOW),
      "Honza Novák, 2 messages. An hour ago: „Honza 1“. Not answered. Yesterday: „Honza 2“. Not answered. Those are all the messages. You can reply, for example: reply to John that…");
    assert.equal(spokenReadingTurn({ channel: "whatsapp", overview: { senders: [], unansweredToday: 0 }, done: true }, "en-GB", NOW), "There are no received WhatsApp messages.");
    assert.equal(spokenReadingTurn({ channel: "email", overview: { senders: [], unansweredToday: 0 }, done: true }, "cs-CZ", NOW), "V e-mailu nejsou žádné přijaté zprávy.");
  });

  it("names five senders at most and counts the rest", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ sender: `S${index + 1}`, count: 1 }));
    const spoken = spokenReadingTurn({ channel: "email", overview: { senders: many, unansweredToday: 0 }, done: false }, "cs-CZ", NOW);
    assert.match(spoken, /^V e-mailu máte zprávy od 8 odesílatelů: S1 1 zpráva, S2 1 zpráva, S3 1 zpráva, S4 1 zpráva, S5 1 zpráva a 3 další\./);
  });

  it("says plainly when nothing is being read, and how to start", () => {
    assert.equal(spokenNothingBeingRead("cs-CZ"), "Teď vám žádné zprávy nečtu. Řekněte třeba: přečti zprávy na WhatsAppu.");
  });
});
