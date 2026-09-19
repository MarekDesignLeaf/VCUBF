import fs from "node:fs";
import path from "node:path";
import { extractVisiblePhrases } from "./audit-i18n.mjs";
import { commonUiPhrases } from "./ui-translation-common.mjs";

const locales = ["cs-CZ", "pl-PL", "fr-FR", "de-DE", "es-ES", "it-IT"];
const expected = new Set([...extractVisiblePhrases().map(([text]) => text), ...commonUiPhrases]);
let failed = false;

for (const locale of locales) {
  const file = path.resolve(`src/locales/generated/${locale}.ts`);
  if (!fs.existsSync(file)) {
    console.error(`${locale}: generated catalogue is missing`);
    failed = true;
    continue;
  }
  const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const match = source.match(/= (\{[\s\S]*\});\s*\n\nexport default catalogue;/);
  if (!match) {
    console.error(`${locale}: generated catalogue has an invalid shape`);
    failed = true;
    continue;
  }
  const catalogue = JSON.parse(match[1]);
  const missing = [...expected].filter((phrase) => typeof catalogue[phrase] !== "string" || !catalogue[phrase].trim());
  const stale = Object.keys(catalogue).filter((phrase) => !expected.has(phrase));
  if (missing.length || stale.length) {
    console.error(`${locale}: ${missing.length} missing, ${stale.length} stale phrases`);
    if (missing.length) console.error(`  Missing: ${missing.slice(0, 8).join(" | ")}`);
    failed = true;
  } else {
    console.log(`${locale}: ${Object.keys(catalogue).length} phrases complete`);
  }
}

if (failed) {
  console.error("Run scripts/generate-ui-translations.mjs after changing visible UI text.");
  process.exit(1);
}
