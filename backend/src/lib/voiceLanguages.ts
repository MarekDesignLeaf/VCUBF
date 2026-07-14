export const VOICE_LANGUAGES = ["en-GB", "en-US", "cs-CZ", "pl-PL", "fr-FR", "de-DE", "es-ES", "it-IT"] as const;

export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const VOICE_LANGUAGE_LABELS: Record<VoiceLanguage, string> = {
  "en-GB": "English (United Kingdom)",
  "en-US": "English (United States)",
  "cs-CZ": "Czech",
  "pl-PL": "Polish",
  "fr-FR": "French",
  "de-DE": "German",
  "es-ES": "Spanish",
  "it-IT": "Italian",
};

const LANGUAGE_ALIASES: Record<string, VoiceLanguage> = {
  "en-gb": "en-GB",
  ngb: "en-GB",
  "n gb": "en-GB",
  "n g b": "en-GB",
  mgb: "en-GB",
  "m gb": "en-GB",
  en: "en-GB",
  english: "en-GB",
  british: "en-GB",
  anglais: "en-GB",
  englisch: "en-GB",
  ingles: "en-GB",
  inglese: "en-GB",
  anglictina: "en-GB",
  anglictiny: "en-GB",
  anglictinu: "en-GB",
  anglicky: "en-GB",
  angielski: "en-GB",
  "angielski brytyjski": "en-GB",
  "brytyjski angielski": "en-GB",
  brytyjski: "en-GB",
  brytyjskim: "en-GB",
  "english uk": "en-GB",
  "british english": "en-GB",
  "english british": "en-GB",
  "en-us": "en-US",
  "american english": "en-US",
  "us english": "en-US",
  "cs-cz": "cs-CZ",
  cs: "cs-CZ",
  czech: "cs-CZ",
  tcheque: "cs-CZ",
  tschechisch: "cs-CZ",
  checo: "cs-CZ",
  ceco: "cs-CZ",
  cestina: "cs-CZ",
  cestiny: "cs-CZ",
  cestinu: "cs-CZ",
  cesky: "cs-CZ",
  czeski: "cs-CZ",
  "pl-pl": "pl-PL",
  pl: "pl-PL",
  polish: "pl-PL",
  polonais: "pl-PL",
  polnisch: "pl-PL",
  polaco: "pl-PL",
  polacco: "pl-PL",
  polski: "pl-PL",
  polsku: "pl-PL",
  polsky: "pl-PL",
  polstinu: "pl-PL",
  polstiny: "pl-PL",
  "fr-fr": "fr-FR",
  fr: "fr-FR",
  french: "fr-FR",
  franzosisch: "fr-FR",
  frances: "fr-FR",
  francese: "fr-FR",
  francuski: "fr-FR",
  francais: "fr-FR",
  francouzsky: "fr-FR",
  francouzstiny: "fr-FR",
  francouzstinu: "fr-FR",
  "de-de": "de-DE",
  de: "de-DE",
  german: "de-DE",
  allemand: "de-DE",
  aleman: "de-DE",
  tedesco: "de-DE",
  niemiecki: "de-DE",
  deutsch: "de-DE",
  nemecky: "de-DE",
  nemciny: "de-DE",
  nemcinu: "de-DE",
  "es-es": "es-ES",
  es: "es-ES",
  spanish: "es-ES",
  espagnol: "es-ES",
  spanisch: "es-ES",
  spagnolo: "es-ES",
  hiszpanski: "es-ES",
  espanol: "es-ES",
  spanelsky: "es-ES",
  spanelstiny: "es-ES",
  spanelstinu: "es-ES",
  "it-it": "it-IT",
  it: "it-IT",
  italian: "it-IT",
  italien: "it-IT",
  italienisch: "it-IT",
  wloski: "it-IT",
  italiano: "it-IT",
  italsky: "it-IT",
  italstiny: "it-IT",
  italstinu: "it-IT",
};

function normaliseLanguage(raw: string) {
  return raw
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[_\s]+/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/[.!?]+$/g, "");
}

export function isVoiceLanguage(value: string): value is VoiceLanguage {
  return (VOICE_LANGUAGES as readonly string[]).includes(value);
}

export function resolveVoiceLanguage(raw: string): VoiceLanguage | undefined {
  return LANGUAGE_ALIASES[normaliseLanguage(raw)];
}

export function languageSwitchMessage(language: VoiceLanguage) {
  const messages: Record<VoiceLanguage, string> = {
    "en-GB": "Language changed to English. Emma and the Secretary menu now use English.",
    "en-US": "Language changed to English. Emma and the Secretary menu now use English.",
    "cs-CZ": "Jazyk jsem změnila na češtinu. Emma i menu Secretary nyní používají češtinu.",
    "pl-PL": "Zmieniono język na polski. Emma i menu Secretary używają teraz języka polskiego.",
    "fr-FR": "La langue a été changée en français. Emma et le menu Secretary utilisent maintenant le français.",
    "de-DE": "Die Sprache wurde auf Deutsch geändert. Emma und das Secretary-Menü verwenden jetzt Deutsch.",
    "es-ES": "El idioma se ha cambiado a español. Emma y el menú de Secretary ahora usan español.",
    "it-IT": "La lingua è stata cambiata in italiano. Emma e il menu Secretary ora usano l'italiano.",
  };
  return messages[language];
}

export function languageChangeRejectedMessage(language: string) {
  const selected: VoiceLanguage = isVoiceLanguage(language) ? language : "en-GB";
  const messages: Record<VoiceLanguage, string> = {
    "en-GB": "I will keep the current language. Ask me explicitly if you want to change it.",
    "en-US": "I will keep the current language. Ask me explicitly if you want to change it.",
    "cs-CZ": "Ponechám současný jazyk. Pokud ho chcete změnit, požádejte mě o to výslovně.",
    "pl-PL": "Pozostanę przy obecnym języku. Jeśli chcesz go zmienić, poproś mnie o to wyraźnie.",
    "fr-FR": "Je conserve la langue actuelle. Demandez-moi explicitement si vous souhaitez la changer.",
    "de-DE": "Ich behalte die aktuelle Sprache bei. Bitten Sie mich ausdrücklich, wenn Sie sie ändern möchten.",
    "es-ES": "Mantendré el idioma actual. Pídame explícitamente que lo cambie si así lo desea.",
    "it-IT": "Manterrò la lingua attuale. Chiedimi esplicitamente di cambiarla se lo desideri.",
  };
  return messages[selected];
}
