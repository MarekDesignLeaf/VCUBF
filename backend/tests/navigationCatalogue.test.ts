import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getNavigationCatalogue, SECRETARY_NAVIGATION_CATALOGUE } from "../src/lib/navigationCatalogue.js";
import { NAVIGATION_TRANSLATIONS } from "../src/lib/navigationTranslations.js";

const NON_ENGLISH_LANGUAGES = ["cs-CZ", "pl-PL", "fr-FR", "de-DE", "es-ES", "it-IT"] as const;

function cataloguePhrases() {
  const phrases = new Set<string>();
  for (const section of SECRETARY_NAVIGATION_CATALOGUE) {
    for (const item of section.items) {
      phrases.add(item.description);
      item.controls.forEach((control) => phrases.add(control));
      item.children?.forEach((child) => {
        phrases.add(child.label);
        phrases.add(child.description);
        child.controls.forEach((control) => phrases.add(control));
      });
    }
  }
  return phrases;
}

describe("localized Secretary navigation catalogue", () => {
  it("has a static translation for every detailed catalogue phrase in every supported non-English language", () => {
    const phrases = cataloguePhrases();
    for (const language of NON_ENGLISH_LANGUAGES) {
      const translations = NAVIGATION_TRANSLATIONS[language];
      assert.ok(translations, `missing navigation translations for ${language}`);
      for (const phrase of phrases) assert.ok(translations[phrase], `${language} is missing: ${phrase}`);
    }
  });

  it("returns Czech descriptions, descendants, controls and readout structure together", () => {
    const navigation = getNavigationCatalogue(["company.manage", "connectors.read", "recruitment.manage", "voice.execute", "audit.read"], undefined, "cs-CZ");
    const customers = navigation.sections.find((section) => section.id === "customers_and_work");
    const leads = customers?.items.find((item) => item.id === "leads");
    const invoices = navigation.sections.flatMap((section) => section.items).find((item) => item.id === "invoices");

    assert.equal(leads?.description, "Poptávky před převedením na skutečného klienta nebo zakázku.");
    assert.equal(leads?.children[0]?.label, "Podrobnosti poptávky");
    assert.ok(invoices?.controls.includes("Vystavit"));
    assert.match(navigation.readout, /Ovládací prvky:/);
    assert.match(navigation.readout, /Podstrom:/);
    assert.doesNotMatch(navigation.readout, /\b(?:Controls|Subtree):/);
  });
});
