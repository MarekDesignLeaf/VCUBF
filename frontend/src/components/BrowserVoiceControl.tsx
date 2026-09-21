import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DEFAULT_ASSISTANT_NAME } from "../assistantName";
import { api, getToken, refreshLocalSessionToken, type MobileAssistantResponse } from "../api/client";
import { appLanguage } from "../i18n";
import { useAuth } from "../context/useAuth";
import { MacroRecorder, replayMacro, type MacroStep } from "../lib/macroRecorder";
import {
  learningPhrases,
  learningSpeech,
  matchesAny,
  splitNames,
} from "../lib/learningPhrases";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/** The recogniser state that means the sign-in ended, not that recognition broke. */
const SESSION_EXPIRED = "session-expired";

/**
 * Voice control built on the browser's streaming speech recogniser.
 *
 * This replaces an earlier version that recorded audio, judged for itself where
 * a sentence ended, and uploaded a WAV file for transcription. Every difficult
 * problem this feature had came from that one decision: a loudness threshold
 * guessing at sentence boundaries clipped words and fired on room noise; silence
 * sent to a transcription model returns invented text; there were gaps between
 * recordings where speech was simply lost; and the assistant's own reply was
 * recorded back in as a new command.
 *
 * A streaming recogniser has none of those problems, because the engine decides
 * where a sentence ends. There is no threshold to tune, nothing to clip, and no
 * silence to hallucinate from.
 *
 * The one thing a streaming recogniser does need is to be restarted: browsers
 * end a session after a pause. LiveTranslator solves the same thing on Android
 * by keeping two recognisers and switching to the warm one the instant the
 * active one returns a result. Here that is a restart on `end` plus a watchdog
 * for a session that stops reporting anything at all.
 *
 * Neither the assistant's name nor the hotword is hardcoded. Both are settings.
 */

/**
 * A backstop for a session that has genuinely wedged, not a heartbeat.
 *
 * Restarting on silence was wrong: the browser emits nothing while nobody
 * speaks, so a short threshold killed recognition every few seconds and lost
 * audio each time. The ordinary restart happens on `end`; this only catches a
 * session that has stopped responding altogether.
 */
const WATCHDOG_INTERVAL_MS = 5000;
const STALE_AFTER_MS = 30_000;

/** How long the assistant keeps taking commands without being named again. */
const ACTIVE_WINDOW_MS = 20_000;
const CONVERSATION_CAP_MS = 90_000;

type RecogniserState = {
  status: "starting" | "running" | "stopped" | "error";
  error?: string;
  // Kept until a phrase actually arrives. Recognition restarts after every failure,
  // and clearing the error on restart turned a permanent fault into a flicker.
  errorCount: number;
  phrases: number;
  lastPhraseAt?: number;
};

/**
 * What the speech recognition line says.
 *
 * Decided here rather than inside the markup so that an end of session is named
 * in the person's own language. An expired sign-in used to arrive on this line
 * as "error: http-401", which describes the wire and not the situation.
 */
function recogniserLabel(state: RecogniserState, copy: Copy): string {
  if (state.error === SESSION_EXPIRED) return copy.recogniserSessionExpired;
  if (state.error) {
    return `${copy.recogniserErrorPrefix}: ${state.error}`
      + (state.errorCount > 1 ? ` \u00d7${state.errorCount}` : "");
  }
  if (state.status === "running") return copy.recogniserRunning;
  if (state.status === "starting") return copy.recogniserStarting;
  return copy.recogniserStopped;
}

type Copy = {
  title: (name: string) => string;
  listening: string;
  paused: string;
  thinking: string;
  hearing: string;
  enable: (name: string) => string;
  pause: (name: string) => string;
  heard: string;
  answered: string;
  hint: (word: string) => string;
  micDenied: string;
  unsupported: string;
  connectionError: string;
  completed: string;
  failed: string;
  send: string;
  typeHere: string;
  monitor: string;
  monitorEmpty: string;
  meter: string;
  meterLive: string;
  meterSilent: string;
  meterDenied: string;
  meterOff: string;
  recogniser: string;
  recogniserRunning: string;
  recogniserStarting: string;
  recogniserStopped: string;
  recogniserPhrases: (count: number) => string;
  recogniserErrorPrefix: string;
  /** A refused sign-in is a state of the session, never an HTTP number. */
  recogniserSessionExpired: string;
  recogniserNetworkHint: string;
  matched: string;
  ignored: string;
  clearLog: string;
  knownAs: (list: string[]) => string;
  otherWindow: string;
  /** Shown while a new command is being taught, so the mode is never invisible. */
  learningOffered: string;
  learningRecording: (steps: number) => string;
  learningNaming: string;
  learningConfirming: string;
  learningStop: string;
};

function copyFor(language: string): Copy {
  const base = language.slice(0, 2).toLowerCase();
  const table: Record<string, Copy> = {
    en: {
      title: (n) => `${n} on this computer`, listening: "Listening", paused: "Paused",
      thinking: "Thinking", hearing: "Hearing you…",
      enable: (n) => `Turn ${n} on`, pause: (n) => `Pause ${n}`,
      heard: "Heard", answered: "Answered",
      hint: (w) => `Say “${w}” and then your command. Speech is recognised as you speak.`,
      micDenied: "Microphone access was refused. Allow it and turn listening on again.",
      unsupported: "This browser cannot recognise speech. Use Edge or Chrome.",
      connectionError: "Could not reach Secretary.", completed: "Done.",
      failed: "That request could not be completed.", send: "Send", typeHere: "…or type a command",
      monitor: "What was heard (this computer only)", monitorEmpty: "Nothing yet.",
      meter: "Microphone", meterLive: "The microphone is picking up sound.",
      meterSilent: "Silence — nothing is reaching the microphone.",
      meterDenied: "No access to the microphone.", meterOff: "Voice control is off.",
      recogniser: "Speech recognition", recogniserRunning: "running",
      recogniserStarting: "starting", recogniserStopped: "stopped",
      recogniserPhrases: (count) => `${count} phrase${count === 1 ? "" : "s"} returned`,
      recogniserErrorPrefix: "error",
      recogniserSessionExpired: "your sign-in has ended — sign in again",
      recogniserNetworkHint: "Browser speech recognition sends audio to Google. A VPN, a firewall or being offline stops it completely.",
      matched: "recognised", ignored: "not addressed — ignored", clearLog: "Clear",
      knownAs: (list) => `Also recognised as: ${list.join(", ")}.`,
      otherWindow: "Another window is listening; this one stays quiet so you are not heard twice.",
      learningOffered: "Say “teach command” to show me how.",
      learningRecording: (steps) => `Recording what you do — ${steps} steps so far. Say “end learning” when finished.`,
      learningNaming: "Say one or two names for this command.",
      learningConfirming: "Say “save” to keep it.",
      learningStop: "Cancel teaching",
    },
    cs: {
      title: (n) => `${n} v tomto počítači`, listening: "Naslouchá", paused: "Pozastavena",
      thinking: "Přemýšlí", hearing: "Slyším vás…",
      enable: (n) => `Zapnout ${n}`, pause: (n) => `Pozastavit ${n}`,
      heard: "Slyšela", answered: "Odpověděla",
      hint: (w) => `Řekněte „${w}“ a potom příkaz. Řeč se rozpoznává průběžně, jak mluvíte.`,
      micDenied: "Přístup k mikrofonu byl odmítnut. Povolte ho a zapněte naslouchání znovu.",
      unsupported: "Tento prohlížeč neumí rozpoznávat řeč. Použijte Edge nebo Chrome.",
      connectionError: "Nepodařilo se spojit se Secretary.", completed: "Hotovo.",
      failed: "Tento požadavek se nepodařilo dokončit.", send: "Odeslat", typeHere: "…nebo napište příkaz",
      monitor: "Co bylo slyšet (jen tento počítač)", monitorEmpty: "Zatím nic.",
      meter: "Mikrofon", meterLive: "Mikrofon snímá zvuk.",
      meterSilent: "Ticho — do mikrofonu nic nepřichází.",
      meterDenied: "Bez přístupu k mikrofonu.", meterOff: "Hlasové ovládání je vypnuté.",
      recogniser: "Rozpoznávání řeči", recogniserRunning: "běží",
      recogniserStarting: "spouští se", recogniserStopped: "zastaveno",
      recogniserPhrases: (count) => `rozpoznaných úseků: ${count}`,
      recogniserErrorPrefix: "chyba",
      recogniserSessionExpired: "přihlášení vypršelo — přihlaste se znovu",
      recogniserNetworkHint: "Rozpoznávání řeči v prohlížeči posílá zvuk na Google. VPN, firewall nebo chybějící připojení ho zastaví úplně.",
      matched: "rozpoznáno", ignored: "bez oslovení — ignorováno", clearLog: "Vymazat",
      knownAs: (list) => `Rozpozná také: ${list.join(", ")}.`,
      otherWindow: "Poslouchá jiné okno; tohle mlčí, abyste nebyli slyšet dvakrát.",
      learningOffered: "Řekněte „Naučit příkaz“ a ukažte mi to.",
      learningRecording: (steps) => `Nahrávám, co děláte — zatím ${steps} kroků. Až budete hotovi, řekněte „Konec učení“.`,
      learningNaming: "Řekněte jeden nebo dva názvy tohoto příkazu.",
      learningConfirming: "Řekněte „Ulož“ a uložím to.",
      learningStop: "Zrušit učení",
    },
    pl: {
      title: (n) => `${n} na tym komputerze`, listening: "Nasłuchuje", paused: "Wstrzymana",
      thinking: "Myśli", hearing: "Słyszę…",
      enable: (n) => `Włącz ${n}`, pause: (n) => `Wstrzymaj ${n}`,
      heard: "Usłyszała", answered: "Odpowiedziała",
      hint: (w) => `Powiedz „${w}”, a potem polecenie. Mowa jest rozpoznawana na bieżąco.`,
      micDenied: "Odmówiono dostępu do mikrofonu. Zezwól i włącz nasłuchiwanie ponownie.",
      unsupported: "Ta przeglądarka nie rozpoznaje mowy. Użyj Edge lub Chrome.",
      connectionError: "Nie udało się połączyć z Secretary.", completed: "Gotowe.",
      failed: "Nie udało się wykonać tego żądania.", send: "Wyślij", typeHere: "…albo wpisz polecenie",
      monitor: "Co było słychać (tylko ten komputer)", monitorEmpty: "Jeszcze nic.",
      meter: "Mikrofon", meterLive: "Mikrofon odbiera dźwięk.",
      meterSilent: "Cisza — do mikrofonu nic nie dochodzi.",
      meterDenied: "Brak dostępu do mikrofonu.", meterOff: "Sterowanie głosem jest wyłączone.",
      recogniser: "Rozpoznawanie mowy", recogniserRunning: "działa",
      recogniserStarting: "uruchamia się", recogniserStopped: "zatrzymane",
      recogniserPhrases: (count) => `rozpoznanych fragmentów: ${count}`,
      recogniserErrorPrefix: "błąd",
      recogniserSessionExpired: "sesja wygasła — zaloguj się ponownie",
      recogniserNetworkHint: "Rozpoznawanie mowy w przeglądarce wysyła dźwięk do Google. VPN, zapora lub brak połączenia zatrzymuje je całkowicie.",
      matched: "rozpoznano", ignored: "bez wywołania — pominięto", clearLog: "Wyczyść",
      knownAs: (list) => `Rozpoznaje też: ${list.join(", ")}.`,
      otherWindow: "Słucha inne okno; to milczy, aby nie słyszeć Cię dwa razy.",
      learningOffered: "Powiedz „naucz polecenia”, aby mi pokazać.",
      learningRecording: (steps) => `Nagrywam, co robisz — na razie ${steps} kroków. Na koniec powiedz „koniec nauki”.`,
      learningNaming: "Podaj jedną lub dwie nazwy tego polecenia.",
      learningConfirming: "Powiedz „zapisz”, aby zachować.",
      learningStop: "Anuluj naukę",
    },
    de: {
      title: (n) => `${n} auf diesem Computer`, listening: "Hört zu", paused: "Pausiert",
      thinking: "Denkt nach", hearing: "Ich höre Sie…",
      enable: (n) => `${n} einschalten`, pause: (n) => `${n} pausieren`,
      heard: "Gehört", answered: "Geantwortet",
      hint: (w) => `Sagen Sie „${w}“ und dann Ihren Befehl. Sprache wird laufend erkannt.`,
      micDenied: "Mikrofonzugriff verweigert. Erlauben Sie ihn und schalten Sie erneut ein.",
      unsupported: "Dieser Browser erkennt keine Sprache. Verwenden Sie Edge oder Chrome.",
      connectionError: "Secretary war nicht erreichbar.", completed: "Fertig.",
      failed: "Diese Anfrage konnte nicht abgeschlossen werden.", send: "Senden", typeHere: "…oder Befehl eingeben",
      monitor: "Was zu hören war (nur dieser Computer)", monitorEmpty: "Noch nichts.",
      meter: "Mikrofon", meterLive: "Das Mikrofon nimmt Ton auf.",
      meterSilent: "Stille — am Mikrofon kommt nichts an.",
      meterDenied: "Kein Zugriff auf das Mikrofon.", meterOff: "Die Sprachsteuerung ist aus.",
      recogniser: "Spracherkennung", recogniserRunning: "läuft",
      recogniserStarting: "startet", recogniserStopped: "gestoppt",
      recogniserPhrases: (count) => `${count} erkannte Abschnitte`,
      recogniserErrorPrefix: "Fehler",
      recogniserSessionExpired: "Die Anmeldung ist abgelaufen — bitte erneut anmelden",
      recogniserNetworkHint: "Die Spracherkennung des Browsers sendet Audio an Google. Ein VPN, eine Firewall oder fehlendes Internet stoppt sie vollständig.",
      matched: "erkannt", ignored: "nicht angesprochen — ignoriert", clearLog: "Löschen",
      knownAs: (list) => `Wird auch erkannt als: ${list.join(", ")}.`,
      otherWindow: "Ein anderes Fenster hört zu; dieses bleibt still, damit Sie nicht doppelt gehört werden.",
      learningOffered: "Sagen Sie „Befehl lernen“, um es mir zu zeigen.",
      learningRecording: (steps) => `Ich zeichne auf, was Sie tun — bisher ${steps} Schritte. Sagen Sie am Ende „Lernen beenden“.`,
      learningNaming: "Nennen Sie einen oder zwei Namen für diesen Befehl.",
      learningConfirming: "Sagen Sie „Speichern“, um es zu behalten.",
      learningStop: "Lernen abbrechen",
    },
    fr: {
      title: (n) => `${n} sur cet ordinateur`, listening: "À l’écoute", paused: "En pause",
      thinking: "Réfléchit", hearing: "Je vous entends…",
      enable: (n) => `Activer ${n}`, pause: (n) => `Mettre ${n} en pause`,
      heard: "Entendu", answered: "Répondu",
      hint: (w) => `Dites « ${w} » puis votre commande. La parole est reconnue au fil de l’eau.`,
      micDenied: "Accès au microphone refusé. Autorisez-le et réactivez l’écoute.",
      unsupported: "Ce navigateur ne reconnaît pas la parole. Utilisez Edge ou Chrome.",
      connectionError: "Secretary est injoignable.", completed: "Terminé.",
      failed: "Cette demande n’a pas pu être traitée.", send: "Envoyer", typeHere: "…ou tapez une commande",
      monitor: "Ce qui a été entendu (cet ordinateur uniquement)", monitorEmpty: "Rien pour l’instant.",
      meter: "Microphone", meterLive: "Le microphone capte du son.",
      meterSilent: "Silence — rien n’arrive au microphone.",
      meterDenied: "Pas d’accès au microphone.", meterOff: "La commande vocale est désactivée.",
      recogniser: "Reconnaissance vocale", recogniserRunning: "en marche",
      recogniserStarting: "démarrage", recogniserStopped: "arrêtée",
      recogniserPhrases: (count) => `${count} segments reconnus`,
      recogniserErrorPrefix: "erreur",
      recogniserSessionExpired: "la session a expiré — reconnectez-vous",
      recogniserNetworkHint: "La reconnaissance vocale du navigateur envoie l’audio à Google. Un VPN, un pare-feu ou l’absence de connexion l’arrête complètement.",
      matched: "reconnu", ignored: "sans appel — ignoré", clearLog: "Effacer",
      knownAs: (list) => `Également reconnu comme : ${list.join(", ")}.`,
      otherWindow: "Une autre fenêtre écoute ; celle-ci reste silencieuse pour ne pas vous entendre deux fois.",
      learningOffered: "Dites « apprendre une commande » pour me montrer.",
      learningRecording: (steps) => `J’enregistre ce que vous faites — ${steps} étapes pour l’instant. Dites « fin de l’apprentissage » à la fin.`,
      learningNaming: "Donnez un ou deux noms pour cette commande.",
      learningConfirming: "Dites « enregistrer » pour la garder.",
      learningStop: "Annuler l’apprentissage",
    },
    es: {
      title: (n) => `${n} en este ordenador`, listening: "Escuchando", paused: "En pausa",
      thinking: "Pensando", hearing: "Le oigo…",
      enable: (n) => `Activar ${n}`, pause: (n) => `Pausar ${n}`,
      heard: "Ha oído", answered: "Ha respondido",
      hint: (w) => `Diga «${w}» y luego su orden. El habla se reconoce mientras habla.`,
      micDenied: "Acceso al micrófono denegado. Permítalo y vuelva a activar la escucha.",
      unsupported: "Este navegador no reconoce el habla. Use Edge o Chrome.",
      connectionError: "No se ha podido contactar con Secretary.", completed: "Hecho.",
      failed: "No se ha podido completar la solicitud.", send: "Enviar", typeHere: "…o escriba una orden",
      monitor: "Lo que se ha oído (solo este ordenador)", monitorEmpty: "Todavía nada.",
      meter: "Micrófono", meterLive: "El micrófono capta sonido.",
      meterSilent: "Silencio — no llega nada al micrófono.",
      meterDenied: "Sin acceso al micrófono.", meterOff: "El control por voz está desactivado.",
      recogniser: "Reconocimiento de voz", recogniserRunning: "en marcha",
      recogniserStarting: "iniciando", recogniserStopped: "detenido",
      recogniserPhrases: (count) => `${count} fragmentos reconocidos`,
      recogniserErrorPrefix: "error",
      recogniserSessionExpired: "la sesión ha caducado — vuelve a iniciar sesión",
      recogniserNetworkHint: "El reconocimiento de voz del navegador envía audio a Google. Una VPN, un cortafuegos o la falta de conexión lo detiene por completo.",
      matched: "reconocido", ignored: "sin llamada — ignorado", clearLog: "Borrar",
      knownAs: (list) => `También se reconoce como: ${list.join(", ")}.`,
      otherWindow: "Otra ventana está escuchando; esta permanece en silencio para no oírle dos veces.",
      learningOffered: "Diga «aprender comando» para mostrármelo.",
      learningRecording: (steps) => `Estoy grabando lo que hace — ${steps} pasos hasta ahora. Diga «fin del aprendizaje» al terminar.`,
      learningNaming: "Diga uno o dos nombres para este comando.",
      learningConfirming: "Diga «guardar» para conservarlo.",
      learningStop: "Cancelar aprendizaje",
    },
    it: {
      title: (n) => `${n} su questo computer`, listening: "In ascolto", paused: "In pausa",
      thinking: "Sta pensando", hearing: "Vi sento…",
      enable: (n) => `Attiva ${n}`, pause: (n) => `Metti in pausa ${n}`,
      heard: "Ha sentito", answered: "Ha risposto",
      hint: (w) => `Dite «${w}» e poi il comando. Il parlato viene riconosciuto mentre parlate.`,
      micDenied: "Accesso al microfono negato. Consentitelo e riattivate l’ascolto.",
      unsupported: "Questo browser non riconosce il parlato. Usate Edge o Chrome.",
      connectionError: "Secretary non è raggiungibile.", completed: "Fatto.",
      failed: "Non è stato possibile completare la richiesta.", send: "Invia", typeHere: "…oppure scrivete un comando",
      monitor: "Ciò che è stato sentito (solo questo computer)", monitorEmpty: "Ancora nulla.",
      meter: "Microfono", meterLive: "Il microfono sta captando suono.",
      meterSilent: "Silenzio — al microfono non arriva nulla.",
      meterDenied: "Nessun accesso al microfono.", meterOff: "Il controllo vocale è disattivato.",
      recogniser: "Riconoscimento vocale", recogniserRunning: "in funzione",
      recogniserStarting: "avvio", recogniserStopped: "fermo",
      recogniserPhrases: (count) => `${count} frammenti riconosciuti`,
      recogniserErrorPrefix: "errore",
      recogniserSessionExpired: "la sessione è scaduta — accedi di nuovo",
      recogniserNetworkHint: "Il riconoscimento vocale del browser invia l’audio a Google. Una VPN, un firewall o la mancanza di connessione lo blocca del tutto.",
      matched: "riconosciuto", ignored: "senza richiamo — ignorato", clearLog: "Cancella",
      knownAs: (list) => `Riconosciuto anche come: ${list.join(", ")}.`,
      otherWindow: "Un'altra finestra è in ascolto; questa resta in silenzio per non sentirvi due volte.",
      learningOffered: "Dite «impara comando» per mostrarmelo.",
      learningRecording: (steps) => `Sto registrando ciò che fate — ${steps} passi finora. Alla fine dite «fine apprendimento».`,
      learningNaming: "Dite uno o due nomi per questo comando.",
      learningConfirming: "Dite «salva» per conservarlo.",
      learningStop: "Annulla apprendimento",
    },
  };
  return table[base] ?? table.en;
}

function acknowledgement(language: string): string {
  const base = language.slice(0, 2).toLowerCase();
  return ({
    en: "Yes?", cs: "Ano?", pl: "Tak?", de: "Ja?", fr: "Oui ?", es: "¿Sí?", it: "Sì?",
  } as Record<string, string>)[base] ?? "Yes?";
}

/** Diacritics- and punctuation-insensitive, so "Émo," matches "emo". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where the hotword, or one of its learned spellings, appears in the speech. */
/**
 * The wake word as it will actually be said, not only as it was typed.
 *
 * Czech and Polish decline names when addressing someone: a wake word spoken in
 * the vocative loses its ending, and a plain substring search finds neither. Only
 * the last letter of a word may
 * differ or be absent, and only for words long enough that one letter is not most of
 * them — which is what declension does, and no more. Anything looser would make the
 * alias database pointless, and that is what genuine mishearings are for.
 */
function declinedPattern(candidate: string): RegExp {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = candidate
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length >= 4 ? `${escape(word.slice(0, -1))}\\p{L}?` : escape(word)))
    .join("\\s+");
  return new RegExp(body, "u");
}

function findHotword(spoken: string, hotword: string, aliases: string[]): { at: number; length: number } | null {
  const haystack = fold(spoken);
  // Longest first, so a learned two-word form wins over a shorter one inside it.
  const candidates = [hotword, ...aliases].map(fold).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const at = haystack.indexOf(candidate);
    if (at >= 0) return { at, length: candidate.length };
  }
  // Nothing matched as written; try again allowing for the vocative.
  for (const candidate of candidates) {
    const match = declinedPattern(candidate).exec(haystack);
    if (match) return { at: match.index, length: match[0].length };
  }
  return null;
}

/**
 * Female voices shipped by Windows, macOS and common Linux packages. Speech
 * synthesis exposes no gender field, so the name is what there is to go on.
 */
const FEMALE_VOICE_NAMES = new Set([
  "hazel", "susan", "zira", "eva", "heera", "catherine", "linda", "hedda", "katja",
  "helena", "laura", "hortense", "julie", "elsa", "paulina", "irina", "maria",
  "elena", "sabina", "haruka", "huihui", "yaoyao", "tracy", "heami", "ivy", "zosia",
  "samantha", "victoria", "karen", "moira", "tessa", "fiona", "anna", "alice",
  "amelie", "ellen", "joana", "luciana", "monica", "milena", "zuzana", "iveta",
  "kyoko", "yuna", "lekha", "female",
]);

function isFemaleVoice(voice: SpeechSynthesisVoice): boolean {
  const name = voice.name.toLowerCase();
  if (name.includes("female")) return true;
  return name.split(/[^a-zà-ž]+/i).some((word) => FEMALE_VOICE_NAMES.has(word));
}

/**
 * A voice in the requested language, preferring a female one. Language wins over
 * gender: Czech words spoken by an English voice are far worse than a male
 * Czech voice, and Windows ships no female Czech voice at all.
 */
function pickVoice(language: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const base = language.slice(0, 2).toLowerCase();
  const sameLanguage = voices.filter((voice) => voice.lang.slice(0, 2).toLowerCase() === base);
  if (sameLanguage.length === 0) return null;
  const exact = sameLanguage.filter((voice) => voice.lang.replace("_", "-").toLowerCase() === language.toLowerCase());
  const candidates = exact.length > 0 ? exact : sameLanguage;
  return candidates.find(isFemaleVoice) ?? candidates[0];
}

/**
 * What is currently being said, so a new reply replaces it instead of talking over it.
 *
 * Not an HTMLAudioElement any more. That decodes while it plays, and on a machine also
 * running speech recognition it underran — heard as stuttering and missing words.
 * `canplaythrough` only says the browser expects to manage, which it did not.
 */
interface Playback {
  /** Total length including the lead-in, in seconds. Known before a sample is played. */
  duration: number;
  stop(): void;
  onEnded(listener: () => void): void;
}

let currentPlayback: Playback | null = null;

/**
 * Silence at the front of every reply.
 *
 * Windows powers down an idle output endpoint and waking it drops the first samples —
 * the start of the sentence. An earlier attempt held the device awake with a very quiet
 * tone; that tone was at the Nyquist frequency and made the output crackle, which was a
 * worse problem than the one it solved.
 *
 * Real silence costs a fifth of a second and cannot be heard.
 */
const LEAD_IN_MS = 220;

/**
 * How long to wait before starting recognition again after a failure.
 *
 * With no wait at all, a session that fails on start ends on start and restarts on end,
 * as fast as the browser allows — thousands of attempts, which is both pointless and the
 * surest way to be cut off by the service it is calling.
 */
function backoffDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(30_000, 500 * 2 ** (failures - 1));
}

/**
 * How long after she stops talking her own words are still treated as hers.
 *
 * Recognition lags the audio: the final transcript of her last sentence can arrive well
 * after playback has finished. This window is separate from the "she is speaking" one
 * and is never shortened, because interrupting her used to collapse the guard and let
 * her own sentence through as a command.
 */
const ECHO_TAIL_MS = 2500;

/**
 * Cutting her off, decided by how loud the room is rather than by what was said.
 *
 * Echo cancellation leaves a residue of her own voice in the microphone. That residue is
 * measured during the first moments of each reply — with nobody else talking it is
 * exactly what she leaves behind — and a person has to be clearly above it, for long
 * enough that a noise is not mistaken for speech.
 */
const BARGE_IN_CALIBRATE_MS = 400;
const BARGE_IN_OVER_FLOOR = 2.5;
const BARGE_IN_FLOOR_MIN = 0.12;
const BARGE_IN_SUSTAIN_MS = 250;
const BARGE_IN_TICK_MS = 50;
/** Long enough to drop what was already captured, short enough to answer at once. */
const BARGE_IN_GUARD_MS = 400;

/**
 * How long after the last sample she still counts as speaking.
 *
 * Recognition finalises later than the audio stops, so the fragment at the end of her
 * sentence arrives after playback has finished. 600 ms was shorter than that lag and
 * those fragments were executed as commands.
 */
const SPEAKING_GRACE_MS = 1200;

let outputContext: AudioContext | null = null;

/**
 * The one audio context, opened on a user gesture.
 *
 * Nothing is played through it until there is something to say; an open context carries
 * no signal of its own.
 */
function ensureAudioContext(): AudioContext | null {
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    // "playback" rather than the default "interactive": the default asks for the
    // smallest buffer the device will accept, which underruns and crackles whenever the
    // machine is busy — and this one transcribes speech on the NPU. Measured, it doubles
    // the buffer from 10 ms to 20 ms, and ten milliseconds is not perceptible on a
    // spoken sentence.
    if (!outputContext || outputContext.state === "closed") outputContext = new Ctor({ latencyHint: "playback" });
    if (outputContext.state === "suspended") void outputContext.resume();
    return outputContext;
  } catch {
    return null;
  }
}

/** Release the output once voice control is switched off. */
function releaseOutput() {
  const context = outputContext;
  outputContext = null;
  void context?.close().catch(() => undefined);
}

/** The decoded reply with silence in front of it, as one gapless buffer. */
function withLeadIn(context: AudioContext, decoded: AudioBuffer): AudioBuffer {
  const lead = Math.round((LEAD_IN_MS / 1000) * decoded.sampleRate);
  const buffer = context.createBuffer(decoded.numberOfChannels, lead + decoded.length, decoded.sampleRate);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    // copyToChannel with an offset leaves the lead-in as the zeroes it was created
    // with, so the silence costs no work.
    buffer.copyToChannel(decoded.getChannelData(channel), channel, lead);
  }
  return buffer;
}

/**
 * Send a voice request with the current session, and survive a refused token.
 *
 * The voice path talks to the backend directly rather than through the api
 * client, because it carries raw audio rather than JSON. It must still obey the
 * same rule about identity as the rest of the app: a refused token means the
 * session ended, not that speech recognition is broken. That distinction was
 * missing, so an expired sign-in surfaced as "error: http-401" on the speech
 * recognition line and stayed there — the number named the symptom and nothing
 * recovered from it.
 *
 * A stale token on this machine is recoverable, because the account is already
 * chosen here, so the first 401 is answered by fetching the current session once
 * and repeating the request. A second 401 is a genuine sign-out and is returned
 * to the caller to report in words.
 */
async function authorizedVoiceFetch(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
  const send = (token: string | null) =>
    fetch(url, { ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const response = await send(getToken());
  if (response.status !== 401) return response;
  const refreshed = await refreshLocalSessionToken();
  return refreshed ? send(refreshed) : response;
}

/**
 * Speak through the backend's neural voice.
 *
 * Returns the playback that started, or null when nothing could be played — the signal
 * to fall back to the browser's own synthesis. The whole clip is fetched and decoded
 * before a sample is played, so its real length is known up front and there is no
 * decoding left to fall behind during playback.
 */
async function playNeuralVoice(text: string, language: string): Promise<Playback | null> {
  try {
    const context = ensureAudioContext();
    if (!context) return null;

    const response = await authorizedVoiceFetch(`${API_URL}/command/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language }),
    });
    if (!response.ok) return null;
    const encoded = await response.arrayBuffer();
    if (encoded.byteLength === 0) return null;

    const decoded = await context.decodeAudioData(encoded);
    const buffer = withLeadIn(context, decoded);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const listeners: Array<() => void> = [];
    let finished = false;
    source.onended = () => {
      if (finished) return;
      finished = true;
      for (const listener of listeners) listener();
    };

    const playback: Playback = {
      duration: buffer.duration,
      stop() {
        try { source.stop(); } catch { /* already stopped */ }
      },
      onEnded(listener) {
        if (finished) listener();
        else listeners.push(listener);
      },
    };
    currentPlayback = playback;

    // A context resumed a moment ago may still be settling; scheduling a hair ahead
    // keeps the very first reply as clean as the rest.
    source.start(context.currentTime + 0.02);
    return playback;
  } catch {
    return null;
  }
}

/**
 * Whether voice control was left switched on.
 *
 * Reloading the page used to switch it off, so every reload silently took the
 * microphone away until the button was pressed again.
 */
const VOICE_ENABLED_KEY = "vcubf.voice.enabled";

function voiceWasEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberVoiceEnabled(on: boolean) {
  try {
    localStorage.setItem(VOICE_ENABLED_KEY, on ? "1" : "0");
  } catch { /* Private mode: it simply will not be remembered. */ }
}

/**
 * A live picture of what the microphone is picking up.
 *
 * The Web Speech API hands back words and nothing else — no levels, no audio — so
 * there is no way to tell from it whether the microphone is working. This takes its
 * own stream purely to draw it. Both can hold the microphone at the same time.
 *
 * It answers one question and answers it instantly: is sound arriving. "Nothing
 * happens when I talk to it" has three possible causes, and this rules out the first
 * without anyone having to guess.
 */
/**
 * The waveform, drawn from levels handed to it.
 *
 * It used to open its own microphone stream, which meant two consumers of one device with
 * different processing settings — and changing those settings to suit the picture broke
 * echo cancellation for the recogniser. The audio now has one owner, and the meter is
 * given what it draws.
 */
function VoiceMeter({
  active,
  copy,
  levelRef,
}: {
  active: boolean;
  copy: { meter: string; meterLive: string; meterSilent: string; meterDenied: string; meterOff: string };
  /** Read every frame; a ref rather than a prop so redrawing does not re-render. */
  levelRef: React.MutableRefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The bar is driven straight from the animation loop rather than from state: it changes
  // every frame, and re-rendering React sixty times a second to move a bar is waste.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"off" | "live" | "silent">("off");

  useEffect(() => {
    if (!active) {
      setState("off");
      return;
    }
    let frame = 0;
    const levels: number[] = [];
    let loudestRecently = 0;
    let quietSince = Date.now();

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;

      const level = levelRef.current;
      levels.push(level);
      if (barRef.current) barRef.current.style.width = (level * 100).toFixed(1) + "%";

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
      }
      const columnWidth = 3;
      const columns = Math.max(1, Math.floor(width / columnWidth));
      while (levels.length > columns) levels.shift();

      // Speech comes and goes; a moment of quiet between words is not silence.
      loudestRecently = Math.max(loudestRecently * 0.94, level);
      if (loudestRecently > 0.06) quietSince = Date.now();
      const silent = Date.now() - quietSince > 1200;
      setState((current) => {
        const next = silent ? "silent" : "live";
        return current === next ? current : next;
      });

      const pen = canvas.getContext("2d");
      if (!pen) return;
      pen.setTransform(ratio, 0, 0, ratio, 0, 0);
      pen.clearRect(0, 0, width, height);

      const styles = getComputedStyle(canvas);
      const accent = styles.getPropertyValue("--accent").trim() || "#72ff32";
      const muted = styles.getPropertyValue("--border").trim() || "#303536";
      const middle = height / 2;

      pen.strokeStyle = muted;
      pen.lineWidth = 1;
      pen.beginPath();
      pen.moveTo(0, middle);
      pen.lineTo(width, middle);
      pen.stroke();

      pen.fillStyle = accent;
      for (let index = 0; index < levels.length; index += 1) {
        const bar = Math.max(1, levels[index] * (height - 4));
        const x = width - (levels.length - index) * columnWidth;
        pen.fillRect(x, middle - bar / 2, columnWidth - 1, bar);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active, levelRef]);

  const label = state === "off" ? copy.meterOff
    : state === "live" ? copy.meterLive
    : copy.meterSilent;

  return (
    <div className={`voice-meter is-${state}`}>
      <div className="voice-meter-head">
        <span className="voice-observation-label">{copy.meter}</span>
        <span className="voice-meter-state">{label}</span>
      </div>
      <canvas ref={canvasRef} className="voice-meter-canvas" aria-hidden="true" />
      {/* The shape above, the loudness here. The bar is what answers "is it hearing me"
          without having to interpret a waveform. */}
      <div className="voice-meter-bar" aria-hidden="true"><i ref={barRef} /></div>
    </div>
  );
}

/**
 * Voice activity detection, loaded by a script tag in index.html.
 *
 * Not imported: the ONNX runtime fetches its own WebAssembly, and a bundler cannot serve
 * that from public/ — Vite says so outright. The library's own README loads it this way
 * too, so this follows it rather than fighting it.
 *
 * Only what is called is described. Fuller typings would imply a guarantee that a
 * runtime-loaded script does not give.
 */
interface VoiceDetector {
  start(): void;
  pause(): void;
  destroy(): Promise<void>;
}

interface VoiceDetectorOptions {
  model?: "v5" | "legacy";
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onVADMisfire?: () => void;
  onFrameProcessed?: (probabilities: { isSpeech: number; notSpeech: number }, frame: Float32Array) => void;
}

declare global {
  interface Window {
    vad?: {
      MicVAD: { new: (options: VoiceDetectorOptions) => Promise<VoiceDetector> };
      utils: { encodeWAV: (samples: Float32Array) => ArrayBuffer };
    };
  }
}

// Which window owns the microphone. Two copies of the app both listening means
// every sentence is recognised twice and answered twice.
const LISTEN_LOCK_KEY = "vcubf.listening.owner";
const LOCK_HEARTBEAT_MS = 2000;
const LOCK_STALE_MS = 6000;
const WINDOW_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function readLock(): { id: string; at: number } | null {
  try {
    const raw = localStorage.getItem(LISTEN_LOCK_KEY);
    return raw ? (JSON.parse(raw) as { id: string; at: number }) : null;
  } catch {
    return null;
  }
}

/**
 * Claim the microphone for this window.
 *
 * `force` is how the window you are actually using wins. First-come-first-served left a
 * background copy of the app holding the lock while the window in front of you heard
 * nothing, which is indistinguishable from the feature being broken.
 */
function claimMicrophone(force = false): boolean {
  const held = readLock();
  const mine = force || !held || held.id === WINDOW_ID || Date.now() - held.at > LOCK_STALE_MS;
  if (!mine) return false;
  try {
    localStorage.setItem(LISTEN_LOCK_KEY, JSON.stringify({ id: WINDOW_ID, at: Date.now() }));
  } catch { /* Private mode: one window is the norm, carry on. */ }
  return true;
}

function releaseMicrophone() {
  if (readLock()?.id === WINDOW_ID) {
    try { localStorage.removeItem(LISTEN_LOCK_KEY); } catch { /* nothing to undo */ }
  }
}

interface HeardEntry { at: number; text: string; woke: boolean }
interface TranscriptTurn { role: "user" | "assistant"; content: string }

type Recogniser = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onspeechstart: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onnomatch: (() => void) | null;
};

function createRecogniser(): Recogniser | null {
  const Ctor = (window as unknown as {
    SpeechRecognition?: new () => Recogniser;
    webkitSpeechRecognition?: new () => Recogniser;
  }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recogniser }).webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function BrowserVoiceControl() {
  const { user, updateUser } = useAuth();
  const navigate = useNavigate();
  const language = appLanguage(user?.voiceLanguage);
  const copy = copyFor(language);

  // Neither is hardcoded: the secretary is called whatever the person using her
  // decides, and the word that wakes her need not be her name.
  const hotword = (user?.voiceWakeWord || DEFAULT_ASSISTANT_NAME).trim();
  // At the voice own pace short confirmations sound sleepy, so the default sits
  // above 1.0 and the user can move it.
  const speechRate = user?.voiceSpeechRate ?? 1.15;
  const assistantName = (user?.assistantName || hotword).trim();

  const [enabled, setEnabled] = useState(voiceWasEnabled);
  const [status, setStatus] = useState<"idle" | "hearing" | "thinking">("idle");
  const [heard, setHeard] = useState("");
  const [interim, setInterim] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [hearLog, setHearLog] = useState<HeardEntry[]>([]);
  /**
   * What the recogniser itself is doing.
   *
   * Without this, "nothing happens when I talk to it" has three possible causes that
   * look identical: the microphone is not capturing, recognition is failing, or the
   * wake word is not matching. The meter answers the first, this answers the second.
   */
  const [recogniserState, setRecogniserState] = useState<RecogniserState>({ status: "stopped", errorCount: 0, phrases: 0 });
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [hotwordAliases, setHotwordAliases] = useState<string[]>([]);
  const [hasMicrophone, setHasMicrophone] = useState(true);
  // Where the teaching dialogue is. "offered" means she has just failed to
  // understand something and is willing to be taught it.
  const [learningStage, setLearningStage] = useState<
    "off" | "offered" | "recording" | "naming" | "confirming"
  >("off");
  const [recordedSteps, setRecordedSteps] = useState<MacroStep[]>([]);
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const [supported] = useState(() => createRecogniser() !== null);

  const enabledRef = useRef(enabled);
  const hasMicrophoneRef = useRef(true);
  const aliasesRef = useRef<string[]>([]);
  const transcriptRef = useRef(transcript);
  const activeUntil = useRef(0);
  const conversationStartedAt = useRef(0);
  const speakingUntil = useRef(0);
  // Deliberately separate from speakingUntil: that one ends the moment she is cut off,
  // this one has to outlive it.
  const echoGuardUntil = useRef(0);
  // What she is currently saying, so her own voice can be told from an
  // interruption.
  // The last few replies, not just the newest: echo arrives late, so the tail of one
  // sentence can be recognised after the next has already been queued.
  const spokenText = useRef<string[]>([]);
  // Loudness from the meter, and the residue of her own voice that echo cancellation
  // leaves behind, measured fresh for every reply.
  const micLevel = useRef(0);
  const echoFloor = useRef(0);
  const calibrateUntil = useRef(0);
  /**
   * Which recogniser is running.
   *
   * "local" is the microphone, Silero and Whisper on the NPU — the way an assistant is
   * built. "browser" is Chrome's, kept only for when the model or the microphone cannot
   * be had, because a missing file should cost quality rather than the feature.
   */
  const [engine, setEngine] = useState<"starting" | "local" | "browser">("starting");
  const lastEventAt = useRef(0);
  const recogniser = useRef<Recogniser | null>(null);
  const handleFinal = useRef<(text: string) => Promise<void>>(async () => {});
  const recorder = useRef(new MacroRecorder());
  const stageRef = useRef<typeof learningStage>("off");
  const stepsRef = useRef<MacroStep[]>([]);
  const namesRef = useRef<string[]>([]);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { rememberVoiceEnabled(enabled); }, [enabled]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { stageRef.current = learningStage; }, [learningStage]);
  useEffect(() => { stepsRef.current = recordedSteps; }, [recordedSteps]);
  useEffect(() => { namesRef.current = pendingNames; }, [pendingNames]);

  // The recorder needs to know about route changes, or a replay will not know
  // to go to the right page first.
  useEffect(() => {
    if (learningStage !== "recording") return;
    recorder.current.notePath(window.location.pathname);
  }, [learningStage]);

  const appendTurn = useCallback((turn: TranscriptTurn) => {
    setTranscript((current) => [...current, turn].slice(-24));
  }, []);

  // Keep the conversation open, but never past the cap: replies must not be able
  // to hold the microphone open on their own.
  const extendConversation = useCallback(() => {
    const cap = conversationStartedAt.current + CONVERSATION_CAP_MS;
    activeUntil.current = Math.min(Date.now() + ACTIVE_WINDOW_MS, cap);
  }, []);

  const refreshAliases = useCallback(async () => {
    try {
      const { aliases } = await api.command.aliases.list();
      const active = aliases
        .filter((alias) => alias.category === "wake_word" && alias.status === "active")
        .map((alias) => alias.term);
      aliasesRef.current = active;
      setHotwordAliases(active);
    } catch { /* Aliases are an improvement, never a requirement. */ }
  }, []);

  useEffect(() => { void refreshAliases(); }, [refreshAliases]);

  // Claim the microphone while listening, and keep the claim fresh so other
  // windows can tell a live owner from an abandoned one.
  useEffect(() => {
    if (!enabled) {
      releaseMicrophone();
      hasMicrophoneRef.current = false;
      setHasMicrophone(true);
      return;
    }
    const beat = () => {
      // The window in front of the user takes the microphone; one in the background
      // only keeps it while nobody else wants it.
      const inFront = document.visibilityState === "visible" && document.hasFocus();
      const mine = claimMicrophone(inFront);
      hasMicrophoneRef.current = mine;
      setHasMicrophone(mine);
    };
    beat();
    const handle = window.setInterval(beat, LOCK_HEARTBEAT_MS);
    // Immediately on coming forward, rather than up to a heartbeat later: clicking into
    // the window and then waiting to be heard feels like it is not working.
    window.addEventListener("focus", beat);
    window.addEventListener("visibilitychange", beat);
    window.addEventListener("pagehide", releaseMicrophone);
    return () => {
      window.clearInterval(handle);
      window.removeEventListener("focus", beat);
      window.removeEventListener("visibilitychange", beat);
      window.removeEventListener("pagehide", releaseMicrophone);
      releaseMicrophone();
    };
  }, [enabled]);

  // Held open for as long as voice control is on, so no reply has to wait for the
  // device, and released when it is off.
  useEffect(() => {
    if (!enabled) return;
    ensureAudioContext();
    // A session restored on load has had no user gesture, so the context starts
    // suspended and would stay that way. The first click or key press frees it.
    const wake = () => { ensureAudioContext(); };
    window.addEventListener("pointerdown", wake, { once: true });
    window.addEventListener("keydown", wake, { once: true });
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      releaseOutput();
    };
  }, [enabled]);

  /**
   * Stop her talking now.
   *
   * The guard is shortened rather than cleared: the speaker has gone quiet, but audio
   * captured a moment ago can still carry her voice.
   */
  const silence = useCallback(() => {
    currentPlayback?.stop();
    currentPlayback = null;
    try { window.speechSynthesis?.cancel(); } catch { /* not everywhere */ }
    speakingUntil.current = 0;
    echoGuardUntil.current = Date.now() + BARGE_IN_GUARD_MS;
  }, []);

  // Escape stops her at once. A measured threshold is the hands-free way; a key that
  // always works is the one you reach for when it does not.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && Date.now() < speakingUntil.current) silence();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, silence]);

  // Someone talking over her, judged by loudness. Her own voice after echo cancellation
  // is a floor; a person is well above it.
  useEffect(() => {
    if (!enabled) return;
    let loudFor = 0;
    const handle = window.setInterval(() => {
      if (Date.now() >= speakingUntil.current) { loudFor = 0; return; }
      const level = micLevel.current;
      if (Date.now() < calibrateUntil.current) {
        echoFloor.current = Math.max(echoFloor.current, level);
        return;
      }
      const threshold = Math.max(BARGE_IN_FLOOR_MIN, echoFloor.current * BARGE_IN_OVER_FLOOR);
      loudFor = level > threshold ? loudFor + BARGE_IN_TICK_MS : 0;
      if (loudFor >= BARGE_IN_SUSTAIN_MS) {
        loudFor = 0;
        silence();
      }
    }, BARGE_IN_TICK_MS);
    return () => window.clearInterval(handle);
  }, [enabled, silence]);

  const speak = useCallback((text: string) => {
    if (!text) return;
    currentPlayback?.stop();
    currentPlayback = null;
    try { window.speechSynthesis?.cancel(); } catch { /* not everywhere */ }

    // Hold the recogniser off while the reply plays, or the assistant hears
    // herself and answers her own answer.
    speakingUntil.current = Date.now() + 3000;
    echoGuardUntil.current = Date.now() + 3000 + ECHO_TAIL_MS;
    // Fresh for every reply: the residue depends on volume, distance and the room.
    echoFloor.current = 0;
    calibrateUntil.current = Date.now() + BARGE_IN_CALIBRATE_MS;
    spokenText.current = [text, ...spokenText.current].slice(0, 3);

    void (async () => {
      const audio = await playNeuralVoice(text, language);
      if (audio) {
        // The real length, known before playback starts rather than guessed from
        // metadata that may not have arrived yet.
        const playing = audio.duration * 1000;
        speakingUntil.current = Date.now() + playing + SPEAKING_GRACE_MS;
        echoGuardUntil.current = Date.now() + playing + ECHO_TAIL_MS;
        audio.onEnded(() => {
          speakingUntil.current = Date.now() + SPEAKING_GRACE_MS;
          echoGuardUntil.current = Date.now() + ECHO_TAIL_MS;
        });
        return;
      }
      if (!("speechSynthesis" in window)) return;
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        const voice = pickVoice(language);
        if (voice) utterance.voice = voice;
        utterance.rate = speechRate;
        // Roughly three words a second, so the hold lasts about as long as this
        // will take to say.
        // Three words a second at normal pace, scaled by how fast she is set to
        // talk, so the hold matches how long this actually takes.
        const estimated = (text.split(/\s+/).length / (3 * speechRate)) * 1000;
        speakingUntil.current = Date.now() + estimated + SPEAKING_GRACE_MS;
        echoGuardUntil.current = Date.now() + estimated + ECHO_TAIL_MS;
        utterance.onend = () => {
          speakingUntil.current = Date.now() + SPEAKING_GRACE_MS;
          echoGuardUntil.current = Date.now() + ECHO_TAIL_MS;
        };
        window.speechSynthesis.speak(utterance);
      } catch { /* Speech output is optional. */ }
    })();
  }, [language, speechRate]);


  const phrases = learningPhrases(language);
  const learningVoice = learningSpeech(language);

  /** Runs a command the user taught by performing it. */
  const runLearned = useCallback(async (macro: { id: string; steps: MacroStep[]; matchedName: string }) => {
    const preview = macro.steps.map((step, index) =>
      `${index + 1}. ${step.label ?? step.target}${step.value !== undefined ? `: ${step.value}` : ""}`,
    ).join("\n");
    if (!window.confirm(`${learningVoice.reviewReplay}\n\n${macro.matchedName}\n${preview}`)) return;
    setStatus("thinking");
    setHeard(macro.matchedName);
    speak(learningVoice.running(macro.matchedName));
    const outcome = await replayMacro(macro.steps, navigate);
    if (outcome.ok) {
      void api.command.macros.ran(macro.id).catch(() => {});
      setAnswer(learningVoice.replayed);
    } else {
      // Say which step failed: "it did not work" gives the user nothing to act on.
      const message = learningVoice.runFailed(outcome.failedLabel ?? "");
      setAnswer(message);
      speak(message);
    }
    setStatus("idle");
  }, [learningVoice, navigate, speak]);

  /**
   * One sentence, while a teaching dialogue is in progress.
   *
   * Returns true when the sentence belonged to the dialogue and must not be
   * treated as a command.
   */
  const handleLearningTurn = useCallback(async (spoken: string): Promise<boolean> => {
    const stage = stageRef.current;

    if (matchesAny(spoken, phrases.cancel) && stage !== "off" && stage !== "offered") {
      recorder.current.stop();
      setLearningStage("off");
      setRecordedSteps([]);
      setPendingNames([]);
      speak(learningVoice.cancelled);
      return true;
    }

    if (stage === "offered" && matchesAny(spoken, phrases.start)) {
      recorder.current.start();
      setLearningStage("recording");
      setRecordedSteps([]);
      setPendingNames([]);
      speak(learningVoice.started);
      return true;
    }

    // Teaching can also be started deliberately, without waiting to be offered.
    if (stage === "off" && matchesAny(spoken, phrases.start)) {
      recorder.current.start();
      setLearningStage("recording");
      speak(learningVoice.started);
      return true;
    }

    if (stage === "recording") {
      if (!matchesAny(spoken, phrases.finish)) {
        // Anything else said while recording is talking, not a command: acting on
        // it would put the assistant's own navigation into the recording.
        return true;
      }
      const steps = recorder.current.stop();
      if (steps.length <= 1) {
        setLearningStage("off");
        speak(learningVoice.nothingRecorded);
        return true;
      }
      setRecordedSteps(steps);
      setLearningStage("naming");
      speak(learningVoice.stopped(steps.length));
      return true;
    }

    if (stage === "naming") {
      const names = splitNames(spoken);
      if (names.length === 0) {
        speak(learningVoice.askNames);
        return true;
      }
      setPendingNames(names);
      setLearningStage("confirming");
      // Read them back before saving, so a misheard name is caught now.
      speak(learningVoice.repeatNames(names));
      return true;
    }

    if (stage === "confirming") {
      if (!matchesAny(spoken, phrases.save)) {
        // Not a yes: treat it as a correction of the names.
        const names = splitNames(spoken);
        if (names.length > 0) {
          setPendingNames(names);
          speak(learningVoice.repeatNames(names));
        }
        return true;
      }
      try {
        const outcome = await api.command.macros.save(stepsRef.current, namesRef.current);
        const lines: string[] = [];
        // The specification is explicit: say that it already exists, and save the
        // new names to it anyway.
        if (outcome.alreadyKnown) {
          lines.push(learningVoice.alreadyKnown(outcome.existingNames, outcome.addedNames));
        } else {
          lines.push(learningVoice.saved(outcome.addedNames));
        }
        for (const taken of outcome.takenNames) {
          lines.push(learningVoice.nameTaken(taken.name, taken.usedBy));
        }
        const message = lines.join(" ");
        setAnswer(message);
        speak(message);
      } catch {
        speak(learningVoice.saveFailed);
      }
      setLearningStage("off");
      setRecordedSteps([]);
      setPendingNames([]);
      return true;
    }

    return false;
  }, [learningVoice, phrases, speak]);

  const execute = useCallback(async (text: string) => {
    setStatus("thinking");
    setHeard(text);
    appendTurn({ role: "user", content: text });
    try {
      const history = transcriptRef.current.slice(-6);
      const result: MobileAssistantResponse = await api.command.assistant(text, language, history);
      // Not understood: say so and offer to be taught, rather than repeating a
      // generic failure the user can do nothing with.
      const notUnderstood = result.intent === "unrecognized"
        || result.error === "UNSUPPORTED_ACTION";
      if (notUnderstood) {
        const offer = learningVoice.unknown(text);
        setAnswer(offer);
        appendTurn({ role: "assistant", content: offer });
        setLearningStage("offered");
        speak(offer);
        extendConversation();
        setStatus("idle");
        return;
      }

      const responseText = result.assistantMessage || result.message || (result.ok ? copy.completed : copy.failed);
      setAnswer(responseText);
      appendTurn({ role: "assistant", content: responseText });
      if (result.uiAction?.kind === "navigate") navigate(result.uiAction.path);
      if (result.uiAction?.kind === "set_language") updateUser({ voiceLanguage: result.uiAction.language });
      speak(responseText);
      extendConversation();
    } catch {
      setAnswer(copy.connectionError);
      appendTurn({ role: "assistant", content: copy.connectionError });
      speak(copy.connectionError);
    } finally {
      setStatus("idle");
    }
  }, [appendTurn, copy.completed, copy.connectionError, copy.failed, extendConversation, language, learningVoice, navigate, speak, updateUser]);

  // One finished sentence from the recogniser.
  handleFinal.current = async (spoken: string) => {
    const text = spoken.trim();
    if (!text) return;

    const alreadyActive = Date.now() <= activeUntil.current;
    const hit = findHotword(text, hotword, aliasesRef.current);

    // Log everything, addressed or not: a hotword that is never recognised has
    // to be visible rather than silent.
    setHearLog((current) =>
      // Sixty rather than twelve: this is the record you look back through when
      // something was misheard, and twelve lines is a few sentences.
      [{ at: Date.now(), text, woke: alreadyActive || hit !== null }, ...current].slice(0, 60));

    // A dialogue in progress owns the sentence, and a taught command beats a
    // guess at what the words might have meant.
    if (await handleLearningTurn(text)) return;

    if (alreadyActive) {
      const learned = await api.command.macros.match(text).then((r) => r.macro).catch(() => null);
      if (learned) { await runLearned(learned); return; }
      await execute(text);
      return;
    }
    if (!hit) return;

    // fold() preserves length, so the index addresses the spoken text directly.
    const remainder = text.slice(hit.at + hit.length).replace(/^[\s,.:;!?-]+/, "").trim();
    conversationStartedAt.current = Date.now();
    extendConversation();
    if (!remainder) { speak(acknowledgement(language)); return; }
    await execute(remainder);
  };

  // --- the local pipeline: our microphone, Silero, Whisper on the NPU ---------
  useEffect(() => {
    if (!enabled) { setEngine("starting"); return; }

    let cancelled = false;
    let vad: VoiceDetector | null = null;

    const transcribe = async (audio: Float32Array) => {
      // The library resamples to 16 kHz and writes the RIFF header; nothing here does
      // arithmetic on the samples.
      const wav = window.vad!.utils.encodeWAV(audio);
      const query = new URLSearchParams({ wake_word: hotword, language });
      try {
        const response = await authorizedVoiceFetch(`${API_URL}/command/transcribe?${query}`, {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: wav,
        });
        if (!response.ok) {
          setRecogniserState((current) => ({
            ...current,
            status: "error",
            error: response.status === 401
              ? SESSION_EXPIRED
              : response.status === 503 ? "transcription-unavailable" : `http-${response.status}`,
            errorCount: current.errorCount + 1,
          }));
          return;
        }
        const payload = (await response.json()) as { text?: string };
        const heard = (payload.text ?? "").trim();
        setRecogniserState((current) => ({
          ...current,
          status: "running",
          error: undefined,
          errorCount: 0,
          phrases: current.phrases + 1,
          lastPhraseAt: Date.now(),
        }));
        // Silence and hallucinations come back empty; nothing was said, so nothing runs.
        if (heard) void handleFinal.current(heard);
      } catch {
        setRecogniserState((current) => ({
          ...current, status: "error", error: "transcription-unreachable", errorCount: current.errorCount + 1,
        }));
      }
    };

    void (async () => {
      const library = window.vad;
      if (!library) {
        // The script did not load. Fall back rather than leave a dead microphone.
        setEngine("browser");
        setRecogniserState((current) => ({ ...current, status: "error", error: "vad-script-missing", errorCount: 1 }));
        return;
      }
      try {
        vad = await library.MicVAD.new({
          // The model and worklet are found from the script's own URL in /vad/, and the
          // runtime's WebAssembly path is set in index.html.
          model: "v5",
          onFrameProcessed: (_probabilities, frame) => {
            lastEventAt.current = Date.now();
            let sum = 0;
            for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index];
            micLevel.current = Math.min(1, Math.sqrt(Math.sqrt(sum / frame.length)) * 2.6);
          },
          onSpeechStart: () => { setStatus("hearing"); },
          onVADMisfire: () => { setStatus((current) => (current === "hearing" ? "idle" : current)); },
          onSpeechEnd: (audio) => {
            setStatus((current) => (current === "hearing" ? "idle" : current));
            if (!hasMicrophoneRef.current) return;
            // The echo guard, applied to the audio rather than to a transcript: what was
            // captured while she was speaking is thrown away before anything reads it.
            if (Date.now() < echoGuardUntil.current) return;
            void transcribe(audio);
          },
        });
      } catch {
        // No model, no microphone, no worklet: fall back rather than go silent.
        if (!cancelled) {
          setEngine("browser");
          setRecogniserState((current) => ({ ...current, status: "error", error: "local-unavailable", errorCount: 1 }));
        }
        return;
      }
      if (cancelled) { void vad?.destroy(); return; }
      vad.start();
      setEngine("local");
      setRecogniserState((current) => ({ ...current, status: "running", error: undefined, errorCount: 0 }));
    })();

    return () => {
      cancelled = true;
      void vad?.destroy();
    };
  }, [enabled, hotword, language]);

  // --- Chrome's recogniser, only when the local pipeline could not start -----
  useEffect(() => {
    if (engine !== "browser") return;
    if (!enabled || !supported) { setStatus("idle"); setInterim(""); return; }

    let stopped = false;
    // How many times in a row starting has failed, and the timer waiting to try again.
    let failures = 0;
    let retry = 0;
    const instance = createRecogniser();
    if (!instance) { setError(copy.unsupported); return; }

    recogniser.current = instance;
    instance.lang = language;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    lastEventAt.current = Date.now();

    const startNow = () => {
      if (stopped || !enabledRef.current) return;
      try {
        instance.start();
        lastEventAt.current = Date.now();
        setRecogniserState((current) => (
          current.status === "running" ? current : { ...current, status: "starting" }));
      } catch { /* Already started; the next end event will retry. */ }
    };

    const restart = () => {
      if (stopped || !enabledRef.current) return;
      window.clearTimeout(retry);
      const wait = backoffDelay(failures);
      if (wait === 0) {
        startNow();
        return;
      }
      // The clock is refreshed so the watchdog does not decide the session is wedged
      // and abort it in the middle of a deliberate wait.
      lastEventAt.current = Date.now();
      retry = window.setTimeout(() => {
        lastEventAt.current = Date.now();
        startNow();
      }, wait);
    };

    // Any sign of life counts, so a session that is listening quietly is not
    // mistaken for one that has stopped responding.
    const alive = () => { lastEventAt.current = Date.now(); };
    instance.onstart = () => {
      alive();
      // The error is not cleared here. Starting again proves nothing — the last twelve
      // attempts also started, and then failed.
      setRecogniserState((current) => ({ ...current, status: current.error ? "error" : "running" }));
    };
    instance.onaudiostart = alive;
    instance.onsoundstart = alive;
    instance.onspeechend = alive;
    instance.onnomatch = alive;

    // Sound alone is not an interruption: the loudest thing in the room while she is
    // talking is her. Cutting her off here meant her own voice stopped her and, worse,
    // shortened the echo guard so her sentence was then obeyed as a command. The
    // decision moved to onresult, where there are words to judge.
    instance.onspeechstart = () => {
      lastEventAt.current = Date.now();
      setStatus("hearing");
    };

    instance.onresult = (event) => {
      lastEventAt.current = Date.now();

      if (!hasMicrophoneRef.current) return;

      /**
       * Whether this came out of the speaker rather than out of a person.
       *
       * While the reply is playing, anything built only from her own words is hers,
       * however short — the recogniser breaks her sentence into fragments and a single
       * word matches no phrase. Once she has stopped, the stricter test applies, so a
       * short command said the moment she finishes still gets through.
       */
      // Absolute: while she is speaking, and for the tail afterwards, nothing heard is
      // acted on. Comparing words to tell her voice from a person's failed three times
      // in a row — whole sentences, then fragments, then fragments arriving late — and
      // each hole let her execute her own reply. A rule with no judgement in it has
      // nothing to get wrong.
      const hersNotTheirs = () => Date.now() < echoGuardUntil.current;

      // Someone talking over her, judged by what was said rather than that anything
      // was. Being able to cut her off is the difference between a conversation and a
      // recital — but only a person may do it, not her own speaker.
      const interrupt = (heard: string) => {
        // Unreachable while the guard is closed, which is deliberate: cutting her off
        // required deciding whose voice it was, and that decision is what kept failing.
        if (Date.now() >= speakingUntil.current) return;
        if (!heard.trim() || hersNotTheirs()) return;
        currentPlayback?.stop();
        currentPlayback = null;
        try { window.speechSynthesis?.cancel(); } catch { /* not everywhere */ }
        // She has stopped, so nothing more of hers is coming — but the echo guard is
        // left alone, because what is already in the air is still hers.
        speakingUntil.current = Date.now() + 250;
      };

      // Counted whether or not the words are acted on: a phrase arriving proves
      // recognition works, which is a different question from whether she was
      // addressed.
      // A phrase arriving is the only thing that proves recognition works, so it is the
      // only thing that clears the error.
      // A phrase arriving is the only proof the service is answering, so it is the
      // only thing that resets the backoff.
      failures = 0;
      setRecogniserState((current) => ({
        ...current,
        status: "running",
        error: undefined,
        errorCount: 0,
        phrases: current.phrases + 1,
        lastPhraseAt: Date.now(),
      }));

      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          // Her own reply coming back, rather than something said to her.
          if (hersNotTheirs()) continue;
          interrupt(text);
          void handleFinal.current(text);
        } else {
          pending += text;
        }
      }
      if (pending) interrupt(pending);
      setInterim(pending.trim());
      if (!pending) setStatus((current) => (current === "hearing" ? "idle" : current));
    };

    instance.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError(copy.micDenied);
        setEnabled(false);
        return;
      }
      // "no-speech" and "aborted" really are ordinary in continuous listening. Every
      // other code is not, and swallowing them was what made a dead recogniser
      // indistinguishable from a quiet room.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        failures += 1;
        setRecogniserState((current) => ({
          ...current,
          status: "error",
          error: event.error,
          errorCount: current.error === event.error ? current.errorCount + 1 : 1,
        }));
      }
      lastEventAt.current = Date.now();
    };

    // Browsers end a session after a pause. Restarting at once is the browser's
    // equivalent of switching to the warm second recogniser.
    instance.onend = () => {
      setInterim("");
      restart();
    };

    restart();

    // A session can stop reporting anything without ending. Restart it.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastEventAt.current < STALE_AFTER_MS) return;
      try { instance.abort(); } catch { /* the end handler restarts it */ }
      lastEventAt.current = Date.now();
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearInterval(watchdog);
      instance.onresult = null;
      instance.onend = null;
      instance.onerror = null;
      instance.onspeechstart = null;
      instance.onstart = null;
      instance.onaudiostart = null;
      instance.onsoundstart = null;
      instance.onspeechend = null;
      instance.onnomatch = null;
      try { instance.abort(); } catch { /* already gone */ }
      recogniser.current = null;
      setInterim("");
      setStatus("idle");
      setRecogniserState((current) => ({ ...current, status: "stopped" }));
    };
  }, [engine, enabled, supported, language, copy.micDenied, copy.unsupported]);

  const submitTyped = useCallback(async () => {
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    conversationStartedAt.current = Date.now();
    extendConversation();
    await execute(text);
  }, [execute, extendConversation, typed]);

  const statusLabel = !enabled ? copy.paused
    : status === "hearing" ? copy.hearing
    : status === "thinking" ? copy.thinking
    : copy.listening;

  return (
    <section className="voice-control-centre" aria-label={copy.title(assistantName)}>
      <header className="voice-control-heading">
        <h2>{copy.title(assistantName)}</h2>
        <span className={`voice-state ${enabled ? "is-live" : ""}`}>{statusLabel}</span>
      </header>

      <button
        type="button"
        onClick={() => {
          setError(null);
          // Opened here rather than in the effect: a button press is the one moment a
          // browser is guaranteed to let an AudioContext start.
          if (!enabled) ensureAudioContext();
          setEnabled((on) => !on);
        }}
        disabled={!supported}
      >
        {enabled ? copy.pause(assistantName) : copy.enable(assistantName)}
      </button>

      {learningStage !== "off" ? (
        <div className="learning-banner">
          <strong>
            {learningStage === "recording" ? copy.learningRecording(recordedSteps.length)
              : learningStage === "naming" ? copy.learningNaming
              : learningStage === "confirming" ? copy.learningConfirming
              : copy.learningOffered}
          </strong>
          {/* A spoken phrase is not a way out on its own: if she mishears it, the
              user is stuck with no visible means of escape. */}
          <button
            type="button"
            onClick={() => {
              recorder.current.stop();
              setLearningStage("off");
              setRecordedSteps([]);
              setPendingNames([]);
            }}
          >
            {copy.learningStop}
          </button>
        </div>
      ) : null}

      {/* Two independent stacks. In a grid the rows are shared between columns, so a
          taller left side pushed the bottom of itself out of a fixed height and the
          status vanished. Separate elements cannot do that. */}
      <div className="voice-col voice-col-left">
      <p className="voice-hint">{copy.hint(hotword)}</p>
      {!supported ? <p className="error">{copy.unsupported}</p> : null}
      {enabled && !hasMicrophone ? <p className="voice-hint voice-hint-muted">{copy.otherWindow}</p> : null}
      {hotwordAliases.length > 0 ? <p className="voice-hint">{copy.knownAs(hotwordAliases)}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {interim ? <p className="voice-interim">{interim}</p> : null}
      {heard ? <p className="voice-heard"><strong>{copy.heard}:</strong> {heard}</p> : null}
      {answer ? <p className="voice-answer"><strong>{copy.answered}:</strong> {answer}</p> : null}

      <form
        className="voice-typed"
        onSubmit={(event) => { event.preventDefault(); void submitTyped(); }}
      >
        <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={copy.typeHere} />
        <button type="submit" disabled={!typed.trim()}>{copy.send}</button>
      </form>

      </div>

      <div className="voice-col voice-col-right">
      <VoiceMeter active={enabled && hasMicrophone} copy={copy} levelRef={micLevel} />
      {/* Which of the three things is failing. Silence used to look the same whether the
          microphone was dead, recognition was unreachable, or the wake word simply had
          not matched. */}
      <p className={`voice-recogniser-line is-${recogniserState.status}`}>
        <span className="voice-observation-label">{copy.recogniser}</span>
        <strong>
          {recogniserLabel(recogniserState, copy)}
        </strong>
        <span>{copy.recogniserPhrases(recogniserState.phrases)}</span>
        {recogniserState.error === "network" ? (
          <span className="voice-recogniser-hint">{copy.recogniserNetworkHint}</span>
        ) : null}
      </p>

      {/* Its own panel, always open. Hidden inside a <details> this was the one thing
          that could have explained a silent assistant, and nobody would open it. */}
      <section className="voice-heard-panel">
        <header className="voice-heard-head">
          <span className="voice-observation-label">{copy.monitor}</span>
          <button type="button" onClick={() => setHearLog([])} disabled={hearLog.length === 0}>
            {copy.clearLog}
          </button>
        </header>
        {hearLog.length === 0 ? (
          <p className="hint">{copy.monitorEmpty}</p>
        ) : (
          <ul className="voice-heard-list">
            {hearLog.map((entry) => (
              <li key={entry.at} className={entry.woke ? "is-woke" : "is-ignored"}>
                {/* The time, because a line you just said and one from ten minutes ago
                    look identical without it. */}
                <time className="voice-heard-time" dateTime={new Date(entry.at).toISOString()}>
                  {new Date(entry.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </time>
                <span className="voice-heard-mark">{entry.woke ? "✓" : "✕"}</span>
                <span className="voice-heard-text">{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>
    </section>
  );
}
