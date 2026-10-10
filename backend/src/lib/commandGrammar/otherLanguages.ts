// French, German, Spanish and Italian have no command grammar of their own
// yet: with one of them switched on, the language model reads the request.
// Only switching the language and opening a page of the menu are recognised
// directly, each in its own language.

import { NEVER, parseLanguageSwitch, parseNavigation, type CommandGrammar } from "./shared.js";

function switchAndNavigate(language: string, patterns: RegExp[], fillers: string[], navigation: string): CommandGrammar {
  const grammar: CommandGrammar = {
    language,
    yes: NEVER,
    no: NEVER,
    readingSkip: NEVER,
    readingOlder: NEVER,
    languageSwitch: { patterns, fillers },
    parse: (text) => parseLanguageSwitch(text, grammar.languageSwitch) ?? parseNavigation(text, navigation),
  };
  return grammar;
}

export const french = switchAndNavigate("fr", [
  /^(?:change|passe|bascule|mets)\s+(?:la\s+)?langue\s*(?:(?:en|vers)\s+)?(.+)$/iu,
  /^(?:parle|réponds|reponds)\s+(?:en\s+)?(.+)$/iu,
], [], "ouvre|ouvrir|va\\s+à|va\\s+a|affiche");

export const german = switchAndNavigate("de", [
  /^(?:wechsle|ändere|andere|stelle)\s+(?:die\s+)?sprache\s*(?:(?:auf|zu)\s+)?(.+)$/iu,
  /^(?:wechsle|wechsel|schalte)(?:\s+die)?(?:\s+sprache)?\s*(?:(?:auf|zu)\s+)?(.+)$/iu,
  /^(?:ich\s+(?:will|möchte|mochte)|bitte)(?:\s+die)?(?:\s+sprache)?\s*(?:(?:auf|in)\s+)?(.+)$/iu,
  /^(?:kann\s+ich|kannst\s+du|können\s+sie|konnen\s+sie)(?:\s+die)?\s+sprache\s*(?:(?:auf|in)\s+)?(.+)$/iu,
  /^(?:bestell|stell|stelle|setz|setze|wähl|wahl|wahle)(?:\s+die)?(?:\s+sprache)?\s*(?:auf\s+)?(.+)$/iu,
  /^sprache\s+(.+)$/iu,
  /^(.+)\s+sprache$/iu,
  /^(?:sprich|antworte)\s+(?:auf\s+)?(.+)$/iu,
], ["sprache", "spreche", "sprechen"], "öffne|offne|gehe\\s+zu|zeige");

export const spanish = switchAndNavigate("es", [
  /^(?:cambia|cambiar|pon)\s+(?:el\s+)?idioma\s*(?:(?:a|en)\s+)?(.+)$/iu,
  /^(?:habla|responde)\s+(?:en\s+)?(.+)$/iu,
], [], "abre|abrir|ve\\s+a|muestra");

export const italian = switchAndNavigate("it", [
  /^(?:cambia|imposta)\s+(?:la\s+)?lingua\s*(?:(?:in|su)\s+)?(.+)$/iu,
  /^(?:parla|rispondi)\s+(?:in\s+)?(.+)$/iu,
], [], "apri|vai\\s+a|mostra");
