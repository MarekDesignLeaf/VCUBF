import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isPromptEcho, transcribeVoiceAudio } from "../src/services/voiceAssistantService.js";

const realFetch = globalThis.fetch;

const PROMPT =
  "Emma. vytvoř klienta, nový klient, zakázka, nabídka, faktura, úkol, poptávka, " +
  "ukaž zakázky, ukaž faktury, ukaž úkoly, zaznamenej platbu, schval nabídku, " +
  "přidej poznámku, naplánuj schůzku, kalendář, zákazník, termín, cena";

describe("GPT transcription must not execute its own vocabulary prompt", () => {
  after(() => { globalThis.fetch = realFetch; });

  it("recognises the prompt echoed back for silent audio", () => {
    assert.equal(isPromptEcho("context: ### Emma ###", PROMPT), true);
    assert.equal(isPromptEcho("vytvoř klienta, nový klient, zakázka, nabídka, faktura", PROMPT), true);
    assert.equal(isPromptEcho("Emma. vytvoř klienta, nový klient, zakázka, nabídka, faktura, úkol, poptávka", PROMPT), true);
  });

  it("keeps a command that is one vocabulary phrase, with or without the wake word", () => {
    // These are word for word in the prompt, and are still exactly what people say.
    const prompt = "Alfonzo. vytvoř klienta, nový klient, zakázka, nabídka, faktura, úkol. nová zakázka pro klienta, přidej fotku k zakázce";
    assert.equal(isPromptEcho("Alfonzo, vytvoř klienta", prompt), false);
    assert.equal(isPromptEcho("vytvoř klienta", prompt), false);
    assert.equal(isPromptEcho("Nová zakázka pro klienta", prompt), false, "a learned alias of several words");
    assert.equal(isPromptEcho("Alfonzo nová zakázka pro klienta", prompt), false);
    assert.equal(isPromptEcho("create client", "Alfonzo. create client, new client, job, quote"), false);
    // Running across the list is still the model reading the prompt back.
    assert.equal(isPromptEcho("vytvoř klienta, nový klient, zakázka", prompt), true);
    assert.equal(isPromptEcho("Alfonzo. vytvoř klienta, nový klient", prompt), true);
  });

  it("keeps real commands that happen to use vocabulary words", () => {
    assert.equal(isPromptEcho("Emmo, vytvoř klienta Roger Novák", PROMPT), false);
    assert.equal(isPromptEcho("ukaž faktury", PROMPT), false);
    assert.equal(isPromptEcho("zaznamenej platbu deset tisíc od pana Nováka za zakázku v Oxfordu", PROMPT), false);
    assert.equal(isPromptEcho("kolik nám dluží zákazníci", PROMPT), false);
  });

  it("returns empty text through transcribeVoiceAudio when the model echoes the prompt", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let sentModel = "";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const form = init?.body as FormData;
      sentModel = String(form.get("model"));
      // Echoes the prompt when given one; without it, the audio holds nothing.
      const prompt = form.get("prompt");
      return new Response(JSON.stringify({ text: prompt === null ? "" : String(prompt) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
    assert.equal(result.text, "");
    assert.equal(result.dropped, "prompt_echo", "the client is told something was heard but not recognised");
    assert.equal(sentModel, process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe");
  });

  it("asks once more without the prompt when the model echoes it, and keeps what was really said", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const prompts: Array<string | null> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const form = init?.body as FormData;
      const prompt = form.get("prompt");
      prompts.push(prompt === null ? null : String(prompt));
      // With the prompt the model reads it back; without it, it hears the command.
      const text = prompt === null ? "Alfonzo, ukaž zakázky na zítra" : String(prompt);
      return new Response(JSON.stringify({ text }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Alfonzo");
    assert.equal(result.text, "Alfonzo, ukaž zakázky na zítra");
    assert.equal(result.dropped, undefined);
    assert.equal(prompts.length, 2);
    assert.ok(prompts[0] && prompts[0].includes("Alfonzo"), "the first request carries the prompt");
    assert.equal(prompts[1], null, "the retry carries none");
  });

  it("does not retry a real command", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ text: "Alfonzo, vytvoř klienta Roger Novák" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Alfonzo");
    assert.equal(result.text, "Alfonzo, vytvoř klienta Roger Novák");
    assert.equal(calls, 1);
  });
});
