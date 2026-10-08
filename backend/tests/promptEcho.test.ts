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
      return new Response(JSON.stringify({ text: String(form.get("prompt")) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
    assert.equal(result.text, "");
    assert.equal(sentModel, process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe");
  });
});
