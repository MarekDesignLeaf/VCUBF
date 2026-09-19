import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { prisma } from "../src/db.js";
import { resetDb, seedCompanyAndAdmin } from "./setup.js";
import {
  findMacroForPhrase,
  fingerprintSteps,
  listMacros,
  saveMacro,
} from "../src/services/voiceMacroService.js";

/** The same flow, performed with different text in the fields. */
const jobForNovak = [
  { kind: "navigate" as const, target: "/jobs", label: "Zakázky" },
  { kind: "click" as const, target: "button[data-action=new-job]", label: "Nová zakázka" },
  { kind: "type" as const, target: "input[name=title]", label: "Název", value: "Novák plot" },
  { kind: "submit" as const, target: "form[data-form=job]", label: "Uložit" },
];
const jobForSvoboda = jobForNovak.map((step) =>
  step.kind === "type" ? { ...step, value: "Svoboda terasa" } : step);

describe("Commands taught by doing them", () => {
  let user: never;

  before(async () => {
    await resetDb();
    await seedCompanyAndAdmin();
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@test.local" } });
    user = {
      id: admin.id, companyId: admin.companyId, email: admin.email,
      displayName: admin.displayName, role: admin.role, permissions: admin.permissions,
      mustChangePassword: false, voiceWakeWord: admin.voiceWakeWord,
      voiceContinuous: admin.voiceContinuous, voiceLanguage: admin.voiceLanguage,
      assistantName: admin.assistantName, voiceSpeechRate: admin.voiceSpeechRate,
    } as never;
  });

  after(async () => { await prisma.$disconnect(); });

  it("treats the same flow with different text as one command", () => {
    // This is what stops the list filling with near-identical macros whose only
    // difference is a client name.
    assert.equal(fingerprintSteps(jobForNovak), fingerprintSteps(jobForSvoboda));
  });

  it("treats a different sequence as a different command", () => {
    const shorter = jobForNovak.slice(0, 2);
    assert.notEqual(fingerprintSteps(jobForNovak), fingerprintSteps(shorter));
  });

  it("saves a recording under the names it was given", async () => {
    const outcome = await saveMacro(user, { steps: jobForNovak, names: ["nová zakázka", "založ zakázku"] });
    assert.ok(outcome);
    assert.equal(outcome!.alreadyKnown, false);
    assert.deepEqual(outcome!.addedNames, ["nová zakázka", "založ zakázku"]);
  });

  it("finds it by either name, ignoring diacritics", async () => {
    const byFirst = await findMacroForPhrase(user, "nova zakazka");
    const bySecond = await findMacroForPhrase(user, "Založ zakázku!");
    assert.ok(byFirst, "the first name must match without diacritics");
    assert.ok(bySecond, "the second name must match too");
    assert.equal(byFirst!.id, bySecond!.id);
  });

  it("does not store the same recording twice; it adds the new name to it", async () => {
    const before = await listMacros(user);
    const outcome = await saveMacro(user, { steps: jobForSvoboda, names: ["vytvoř zakázku"] });
    const after = await listMacros(user);

    assert.equal(outcome!.alreadyKnown, true, "must report that this was already taught");
    // What it is already called, so the assistant can say it out loud.
    assert.ok(outcome!.existingNames.includes("nová zakázka"));
    assert.deepEqual(outcome!.addedNames, ["vytvoř zakázku"]);
    assert.equal(after.length, before.length, "no second copy of the recording");

    const found = await findMacroForPhrase(user, "vytvoř zakázku");
    assert.equal(found!.id, outcome!.macroId, "the new name must run the existing command");
  });

  it("leaves a name that already belongs to another command where it is", async () => {
    const other = [
      { kind: "navigate" as const, target: "/invoices", label: "Faktury" },
      { kind: "click" as const, target: "button[data-action=new-invoice]", label: "Nová faktura" },
    ];
    const outcome = await saveMacro(user, { steps: other, names: ["nová zakázka", "nová faktura"] });
    assert.ok(outcome);
    // Moving it silently would break the command it already names.
    assert.deepEqual(outcome!.addedNames, ["nová faktura"]);
    assert.equal(outcome!.takenNames.length, 1);
    assert.equal(outcome!.takenNames[0].name, "nová zakázka");

    const stillOld = await findMacroForPhrase(user, "nova zakazka");
    assert.notEqual(stillOld!.id, outcome!.macroId);
  });

  it("prefers the longer name when one contains the other", async () => {
    await saveMacro(user, {
      steps: [{ kind: "navigate" as const, target: "/quotes", label: "Nabídky" }],
      names: ["nová zakázka pro klienta"],
    });
    const found = await findMacroForPhrase(user, "nová zakázka pro klienta");
    assert.equal(found!.matchedName, "nová zakázka pro klienta");
  });

  it("refuses a recording with no steps or no name", async () => {
    assert.equal(await saveMacro(user, { steps: [], names: ["nic"] }), null);
    assert.equal(await saveMacro(user, { steps: jobForNovak, names: [] }), null);
  });
});
