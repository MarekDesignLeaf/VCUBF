import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { transcribeVoiceAudio } from "../src/services/voiceAssistantService.js";

const realFetch = globalThis.fetch;

/** What the recogniser returns for one utterance, as if from the model. */
async function transcribed(text: string): Promise<string> {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.WHISPER_SERVER_URL;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const result = await transcribeVoiceAudio(Buffer.alloc(64), "cs-CZ", "Emma");
  return result.text;
}

describe("Room noise must not become a command", () => {
  after(() => { globalThis.fetch = realFetch; });

  // Straight from the speech log, where each of these was executed as a command
  // and each reply held the microphone open for another twenty seconds.
  for (const noise of [
    "(Titulky)",
    "(Tutulky)",
    "(Titulky zvukovat)",
    "[Hudba]",
    "(hudba hraje)",
    "(šum)",
    // Measured on the Snapdragon NPU model, which drops diacritics: these came
    // back for silence and for a keyboard, and each one was executed.
    "Titulky vytvořil JohnyX",
    "Titulky vytvoril JohnyX",
    "Titulky vytvořil Jirka Kováč",
    "[MUZIĘ]",
    "Pokračování příště",
    "Překlad a titulky: někdo",
  ]) {
    it(`rejects ${noise}`, async () => {
      assert.equal(await transcribed(noise), "");
    });
  }

  it("still accepts a real command that contains brackets", async () => {
    assert.equal(
      await transcribed("Emmo, vytvoř klienta (firma) Novák"),
      "Emmo, vytvoř klienta (firma) Novák",
    );
  });

  it("still accepts an ordinary command", async () => {
    assert.equal(await transcribed("Emmo, ukaž klienty"), "Emmo, ukaž klienty");
  });
});
