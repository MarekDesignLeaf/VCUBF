import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech, QueueStrategy } from "@capacitor-community/text-to-speech";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type MobileAssistantResponse } from "../api/client";
import { appLanguage, languageLabel } from "../i18n";
import { useAuth } from "../context/useAuth";

type TranscriptTurn = { role: "user" | "assistant"; content: string };

type MobileVoiceCopy = {
  title: string;
  thinking: string;
  listening: (wakeWord: string) => string;
  paused: string;
  pause: string;
  enable: string;
  deleteTranscript: string;
  microphoneActive: (wakeWord: string) => string;
  microphonePaused: string;
  heard: string;
  answered: string;
  waiting: string;
  noResponse: string;
  savedTranscript: (count: number) => string;
  transcriptPrivacy: string;
  you: string;
  privacy: (language: string) => string;
  unavailable: string;
  startError: string;
  initialiseError: string;
  permissionRequired: string;
  permissionDenied: string;
  completed: string;
  failed: string;
  connectionError: string;
};

const MOBILE_COPY: Record<string, MobileVoiceCopy> = {
  en: { title: "{assistant} on this phone", thinking: "Thinking", listening: (wakeWord) => `Listening for ${wakeWord}`, paused: "Paused", pause: "Pause {assistant}", enable: "Enable {assistant}", deleteTranscript: "Delete phone transcript", microphoneActive: (wakeWord) => `Microphone active. Say “${wakeWord}”, then tell {assistant} what to do.`, microphonePaused: "{assistant} is paused. Enable her to resume automatic listening.", heard: "{assistant} heard", answered: "{assistant} answered", waiting: "Waiting for speech.", noResponse: "No response yet.", savedTranscript: (count) => `Saved phone transcript (${count})`, transcriptPrivacy: "Only text is kept on this phone; microphone audio is never recorded.", you: "You", privacy: (language) => `Recognition and speech use Android services in the foreground. {assistant} sends only recognised text to Secretary and preserves the same permissions and confirmation rules as the desktop app. Current language: ${language}.`, unavailable: "Speech recognition is unavailable on this phone. Install or enable Google speech services, then try again.", startError: "{assistant} could not start the phone microphone. Check the microphone permission in Android settings.", initialiseError: "{assistant} could not initialise mobile speech recognition.", permissionRequired: "Microphone permission is required for {assistant} to listen.", permissionDenied: "Android did not grant microphone permission to {assistant}.", completed: "Done.", failed: "I could not complete that request.", connectionError: "I could not contact Secretary. Check your internet connection and try again." },
  cs: { title: "{assistant} v tomto telefonu", thinking: "Přemýšlí", listening: (wakeWord) => `Naslouchá slovu ${wakeWord}`, paused: "Pozastavena", pause: "Pozastavit asistenta", enable: "Zapnout asistenta", deleteTranscript: "Smazat přepis v telefonu", microphoneActive: (wakeWord) => `Mikrofon je aktivní. Řekněte „${wakeWord}“ a potom asistentovi sdělte, co má udělat.`, microphonePaused: "{assistant} je pozastavena. Zapnutím obnovíte automatické naslouchání.", heard: "{assistant} slyšela", answered: "{assistant} odpověděla", waiting: "Čekám na řeč.", noResponse: "Zatím žádná odpověď.", savedTranscript: (count) => `Uložený přepis v telefonu (${count})`, transcriptPrivacy: "V telefonu se ukládá pouze text; zvuk z mikrofonu se nikdy nenahrává.", you: "Vy", privacy: (language) => `Rozpoznávání a řeč používají služby Androidu v popředí. {assistant} odesílá Secretary pouze rozpoznaný text a zachovává stejná oprávnění a potvrzovací pravidla jako aplikace pro Windows. Aktuální jazyk: ${language}.`, unavailable: "Rozpoznávání řeči není v telefonu dostupné. Nainstalujte nebo zapněte služby Google pro řeč a zkuste to znovu.", startError: "{assistant} nemohla spustit mikrofon telefonu. Zkontrolujte oprávnění mikrofonu v nastavení Androidu.", initialiseError: "{assistant} nemohla inicializovat mobilní rozpoznávání řeči.", permissionRequired: "Aby {assistant} mohla naslouchat, potřebuje oprávnění k mikrofonu.", permissionDenied: "Android asistentovi neudělil oprávnění k mikrofonu.", completed: "Hotovo.", failed: "Tento požadavek se nepodařilo dokončit.", connectionError: "Nemohu se spojit se Secretary. Zkontrolujte připojení k internetu a zkuste to znovu." },
  pl: { title: "{assistant} na tym telefonie", thinking: "Myśli", listening: (wakeWord) => `Nasłuchuje słowa ${wakeWord}`, paused: "Wstrzymana", pause: "Wstrzymaj asystenta", enable: "Włącz asystenta", deleteTranscript: "Usuń transkrypcję z telefonu", microphoneActive: (wakeWord) => `Mikrofon jest aktywny. Powiedz „${wakeWord}”, a następnie powiedz asystentowi, co ma zrobić.`, microphonePaused: "{assistant} jest wstrzymana. Włącz ją, aby wznowić automatyczne nasłuchiwanie.", heard: "{assistant} usłyszała", answered: "{assistant} odpowiedziała", waiting: "Czekam na wypowiedź.", noResponse: "Brak odpowiedzi.", savedTranscript: (count) => `Zapisana transkrypcja telefonu (${count})`, transcriptPrivacy: "W telefonie przechowywany jest tylko tekst; dźwięk z mikrofonu nigdy nie jest nagrywany.", you: "Ty", privacy: (language) => `Rozpoznawanie i mowa korzystają z usług Androida na pierwszym planie. {assistant} wysyła do Secretary tylko rozpoznany tekst i zachowuje te same uprawnienia oraz zasady potwierdzania co aplikacja Windows. Bieżący język: ${language}.`, unavailable: "Rozpoznawanie mowy jest niedostępne na tym telefonie. Zainstaluj lub włącz usługi mowy Google i spróbuj ponownie.", startError: "{assistant} nie mogła uruchomić mikrofonu telefonu. Sprawdź uprawnienia mikrofonu w ustawieniach Androida.", initialiseError: "{assistant} nie mogła zainicjować mobilnego rozpoznawania mowy.", permissionRequired: "{assistant} potrzebuje dostępu do mikrofonu, aby nasłuchiwać.", permissionDenied: "Android nie przyznał asystentowi dostępu do mikrofonu.", completed: "Gotowe.", failed: "Nie udało się wykonać tego polecenia.", connectionError: "Nie mogę połączyć się z Secretary. Sprawdź połączenie z internetem i spróbuj ponownie." },
  fr: { title: "{assistant} sur ce téléphone", thinking: "Réflexion", listening: (wakeWord) => `À l’écoute de ${wakeWord}`, paused: "En pause", pause: "Mettre {assistant} en pause", enable: "Activer {assistant}", deleteTranscript: "Supprimer la transcription du téléphone", microphoneActive: (wakeWord) => `Le microphone est actif. Dites « ${wakeWord} », puis indiquez à {assistant} quoi faire.`, microphonePaused: "{assistant} est en pause. Activez-la pour reprendre l’écoute automatique.", heard: "{assistant} a entendu", answered: "{assistant} a répondu", waiting: "En attente de parole.", noResponse: "Aucune réponse pour le moment.", savedTranscript: (count) => `Transcription enregistrée sur le téléphone (${count})`, transcriptPrivacy: "Seul le texte est conservé sur ce téléphone ; le son du microphone n’est jamais enregistré.", you: "Vous", privacy: (language) => `La reconnaissance et la synthèse vocale utilisent les services Android au premier plan. {assistant} envoie uniquement le texte reconnu à Secretary et conserve les mêmes autorisations et confirmations que l’application Windows. Langue actuelle : ${language}.`, unavailable: "La reconnaissance vocale n’est pas disponible sur ce téléphone. Installez ou activez les services vocaux Google, puis réessayez.", startError: "{assistant} n’a pas pu démarrer le microphone. Vérifiez son autorisation dans les paramètres Android.", initialiseError: "{assistant} n’a pas pu initialiser la reconnaissance vocale mobile.", permissionRequired: "L’autorisation du microphone est nécessaire pour qu’{assistant} puisse écouter.", permissionDenied: "Android n’a pas accordé l’autorisation du microphone à {assistant}.", completed: "Terminé.", failed: "Je n’ai pas pu effectuer cette demande.", connectionError: "Je n’ai pas pu contacter Secretary. Vérifiez votre connexion Internet et réessayez." },
  de: { title: "{assistant} auf diesem Telefon", thinking: "Denkt nach", listening: (wakeWord) => `Wartet auf ${wakeWord}`, paused: "Pausiert", pause: "{assistant} pausieren", enable: "{assistant} aktivieren", deleteTranscript: "Telefontranskript löschen", microphoneActive: (wakeWord) => `Das Mikrofon ist aktiv. Sagen Sie „${wakeWord}“ und teilen Sie {assistant} dann Ihre Aufgabe mit.`, microphonePaused: "{assistant} ist pausiert. Aktivieren Sie sie, um das automatische Zuhören fortzusetzen.", heard: "{assistant} hörte", answered: "{assistant} antwortete", waiting: "Warte auf Sprache.", noResponse: "Noch keine Antwort.", savedTranscript: (count) => `Gespeichertes Telefontranskript (${count})`, transcriptPrivacy: "Auf diesem Telefon wird nur Text gespeichert; Mikrofonton wird niemals aufgezeichnet.", you: "Sie", privacy: (language) => `Erkennung und Sprachausgabe verwenden Android-Dienste im Vordergrund. {assistant} sendet nur erkannten Text an Secretary und behält dieselben Berechtigungen und Bestätigungsregeln wie die Windows-App bei. Aktuelle Sprache: ${language}.`, unavailable: "Die Spracherkennung ist auf diesem Telefon nicht verfügbar. Installieren oder aktivieren Sie die Google-Sprachdienste und versuchen Sie es erneut.", startError: "{assistant} konnte das Telefonmikrofon nicht starten. Prüfen Sie die Mikrofonberechtigung in den Android-Einstellungen.", initialiseError: "{assistant} konnte die mobile Spracherkennung nicht initialisieren.", permissionRequired: "{assistant} benötigt die Mikrofonberechtigung, um zuzuhören.", permissionDenied: "Android hat {assistant} keine Mikrofonberechtigung erteilt.", completed: "Erledigt.", failed: "Ich konnte diese Anfrage nicht ausführen.", connectionError: "Secretary ist nicht erreichbar. Prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut." },
  es: { title: "{assistant} en este teléfono", thinking: "Pensando", listening: (wakeWord) => `Escuchando ${wakeWord}`, paused: "En pausa", pause: "Pausar a {assistant}", enable: "Activar a {assistant}", deleteTranscript: "Borrar transcripción del teléfono", microphoneActive: (wakeWord) => `El micrófono está activo. Diga «${wakeWord}» y después indique a {assistant} qué debe hacer.`, microphonePaused: "{assistant} está en pausa. Actívela para reanudar la escucha automática.", heard: "{assistant} oyó", answered: "{assistant} respondió", waiting: "Esperando voz.", noResponse: "Todavía no hay respuesta.", savedTranscript: (count) => `Transcripción guardada en el teléfono (${count})`, transcriptPrivacy: "En este teléfono solo se guarda texto; el audio del micrófono nunca se graba.", you: "Usted", privacy: (language) => `El reconocimiento y la voz usan los servicios de Android en primer plano. {assistant} solo envía el texto reconocido a Secretary y mantiene los mismos permisos y reglas de confirmación que la aplicación de Windows. Idioma actual: ${language}.`, unavailable: "El reconocimiento de voz no está disponible en este teléfono. Instale o active los servicios de voz de Google e inténtelo de nuevo.", startError: "{assistant} no pudo iniciar el micrófono del teléfono. Compruebe el permiso del micrófono en los ajustes de Android.", initialiseError: "{assistant} no pudo inicializar el reconocimiento de voz móvil.", permissionRequired: "{assistant} necesita permiso para usar el micrófono y escuchar.", permissionDenied: "Android no concedió a {assistant} permiso para usar el micrófono.", completed: "Hecho.", failed: "No pude completar esa solicitud.", connectionError: "No pude contactar con Secretary. Compruebe su conexión a Internet e inténtelo de nuevo." },
  it: { title: "{assistant} su questo telefono", thinking: "Sta pensando", listening: (wakeWord) => `In ascolto di ${wakeWord}`, paused: "In pausa", pause: "Metti {assistant} in pausa", enable: "Attiva {assistant}", deleteTranscript: "Elimina trascrizione dal telefono", microphoneActive: (wakeWord) => `Il microfono è attivo. Dica “${wakeWord}” e poi comunichi a {assistant} cosa fare.`, microphonePaused: "{assistant} è in pausa. La attivi per riprendere l’ascolto automatico.", heard: "{assistant} ha sentito", answered: "{assistant} ha risposto", waiting: "In attesa della voce.", noResponse: "Nessuna risposta.", savedTranscript: (count) => `Trascrizione salvata sul telefono (${count})`, transcriptPrivacy: "Su questo telefono viene conservato solo il testo; l’audio del microfono non viene mai registrato.", you: "Lei", privacy: (language) => `Il riconoscimento e la voce usano i servizi Android in primo piano. {assistant} invia a Secretary solo il testo riconosciuto e mantiene le stesse autorizzazioni e regole di conferma dell’app Windows. Lingua attuale: ${language}.`, unavailable: "Il riconoscimento vocale non è disponibile su questo telefono. Installi o attivi i servizi vocali Google e riprovi.", startError: "{assistant} non ha potuto avviare il microfono del telefono. Controlli l’autorizzazione del microfono nelle impostazioni Android.", initialiseError: "{assistant} non ha potuto inizializzare il riconoscimento vocale mobile.", permissionRequired: "{assistant} necessita dell’autorizzazione al microfono per ascoltare.", permissionDenied: "Android non ha concesso a {assistant} l’autorizzazione al microfono.", completed: "Fatto.", failed: "Non ho potuto completare la richiesta.", connectionError: "Non ho potuto contattare Secretary. Controlli la connessione Internet e riprovi." },
};

function mobileVoiceCopy(language: string) {
  return MOBILE_COPY[language.split("-")[0]?.toLowerCase()] ?? MOBILE_COPY.en;
}

function normaliseForWakeWord(value: string) {
  return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function transcriptStorageKey(userId: string) {
  return `vcubf.mobile-emma.transcript.${userId}`;
}

function wakeAcknowledgement(language: string) {
  const base = language.split("-")[0]?.toLowerCase();
  return ({
    en: "Yes, I am listening.",
    cs: "Ano, poslouchám.",
    pl: "Tak, słucham.",
    fr: "Oui, je vous écoute.",
    de: "Ja, ich höre zu.",
    es: "Sí, le escucho.",
    it: "Sì, la ascolto.",
  } as Record<string, string>)[base] ?? "Yes, I am listening.";
}

export function MobileVoiceControl() {
  const { user, updateUser } = useAuth();
  const navigate = useNavigate();
  const language = appLanguage(user?.voiceLanguage);
  const copy = mobileVoiceCopy(language);
  const wakeWord = (user?.voiceWakeWord || "Hej {assistant}").trim();
  const [enabled, setEnabled] = useState(() => localStorage.getItem("vcubf.mobile-emma.enabled") !== "false");
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [heard, setHeard] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>(() => {
    if (!user) return [];
    try {
      const stored = JSON.parse(localStorage.getItem(transcriptStorageKey(user.id)) ?? "[]") as TranscriptTurn[];
      return Array.isArray(stored) ? stored.slice(-24) : [];
    } catch { return []; }
  });
  const latestPartial = useRef("");
  const enabledRef = useRef(enabled);
  const activeUntil = useRef(0);
  const processing = useRef(false);
  const restartTimer = useRef<number | null>(null);
  const startRef = useRef<() => Promise<void>>(async () => {});
  const processRef = useRef<(text: string) => Promise<void>>(async () => {});
  const transcriptRef = useRef(transcript);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => {
    if (!user) return;
    try { localStorage.setItem(transcriptStorageKey(user.id), JSON.stringify(transcript.slice(-24))); } catch { /* Storage is optional. */ }
  }, [transcript, user]);

  const appendTurn = useCallback((turn: TranscriptTurn) => {
    setTranscript((current) => [...current, turn].slice(-24));
  }, []);

  const speak = useCallback(async (text: string) => {
    setAnswer(text);
    try {
      await TextToSpeech.speak({ text, lang: language, rate: 1, pitch: 1, volume: 1, queueStrategy: QueueStrategy.Flush });
    } catch {
      // Voice output must not prevent the action itself. Android can be missing
      // an installed voice for a selected language.
    }
  }, [language]);

  const startListening = useCallback(async () => {
    if (!enabledRef.current || processing.current) return;
    try {
      const availability = await SpeechRecognition.available();
      if (!availability.available) {
        setError(copy.unavailable);
        setEnabled(false);
        localStorage.setItem("vcubf.mobile-emma.enabled", "false");
        return;
      }
      const state = await SpeechRecognition.isListening();
      if (state.listening) return;
      latestPartial.current = "";
      await SpeechRecognition.start({ language, maxResults: 1, partialResults: true, popup: false });
      setListening(true);
      setError(null);
    } catch {
      setListening(false);
      setError(copy.startError);
    }
  }, [copy.startError, copy.unavailable, language]);

  startRef.current = startListening;

  const scheduleRestart = useCallback(() => {
    if (restartTimer.current) window.clearTimeout(restartTimer.current);
    restartTimer.current = window.setTimeout(() => { void startRef.current(); }, 350);
  }, []);

  const execute = useCallback(async (text: string) => {
    processing.current = true;
    setThinking(true);
    setHeard(text);
    appendTurn({ role: "user", content: text });
    try {
      const history = transcriptRef.current.slice(-6);
      const result: MobileAssistantResponse = await api.command.assistant(text, language, history);
      const responseText = result.assistantMessage || result.message || (result.ok ? copy.completed : copy.failed);
      appendTurn({ role: "assistant", content: responseText });
      if (result.uiAction?.kind === "navigate") navigate(result.uiAction.path);
      if (result.uiAction?.kind === "set_language") updateUser({ voiceLanguage: result.uiAction.language });
      if (result.uiAction?.kind === "external_url" && result.uiAction.url.startsWith("https://")) window.location.assign(result.uiAction.url);
      if (result.uiAction?.kind === "download" && /^\/(?:quotes|invoices)\/[a-f0-9-]+\/pdf$/i.test(result.uiAction.path)) {
        const blob = await api.command.download(result.uiAction.path);
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = result.uiAction.filename; link.click();
        URL.revokeObjectURL(url);
      }
      await speak(responseText);
      activeUntil.current = Date.now() + 20_000;
    } catch {
      const responseText = copy.connectionError;
      appendTurn({ role: "assistant", content: responseText });
      await speak(responseText);
    } finally {
      setThinking(false);
      processing.current = false;
      scheduleRestart();
    }
  }, [appendTurn, copy.completed, copy.connectionError, copy.failed, language, navigate, scheduleRestart, speak, updateUser]);

  processRef.current = async (rawText: string) => {
    const text = rawText.trim();
    if (!text || processing.current) return;
    const normalisedText = normaliseForWakeWord(text);
    const normalisedWakeWord = normaliseForWakeWord(wakeWord);
    if (Date.now() > activeUntil.current) {
      const index = normalisedText.indexOf(normalisedWakeWord);
      if (index < 0) { scheduleRestart(); return; }
      const remainder = text.slice(index + wakeWord.length).replace(/^[\s,.:;!?-]+/, "").trim();
      activeUntil.current = Date.now() + 20_000;
      if (!remainder) {
        await speak(wakeAcknowledgement(language));
        scheduleRestart();
        return;
      }
      await execute(remainder);
      return;
    }
    await execute(text);
  };

  useEffect(() => {
    let partialHandle: Awaited<ReturnType<typeof SpeechRecognition.addListener>> | undefined;
    let stateHandle: Awaited<ReturnType<typeof SpeechRecognition.addListener>> | undefined;
    void (async () => {
      partialHandle = await SpeechRecognition.addListener("partialResults", ({ matches }) => {
        const text = matches[0]?.trim() ?? "";
        latestPartial.current = text;
        if (text) setHeard(text);
      });
      stateHandle = await SpeechRecognition.addListener("listeningState", ({ status }) => {
        if (status !== "stopped") return;
        setListening(false);
        const finalText = latestPartial.current;
        latestPartial.current = "";
        if (finalText) void processRef.current(finalText);
        else scheduleRestart();
      });
      if (enabledRef.current) {
        let permission = await SpeechRecognition.checkPermissions();
        if (permission.speechRecognition !== "granted") permission = await SpeechRecognition.requestPermissions();
        if (permission.speechRecognition !== "granted") {
          setEnabled(false);
          enabledRef.current = false;
          localStorage.setItem("vcubf.mobile-emma.enabled", "false");
          setError(copy.permissionRequired);
          return;
        }
        await startRef.current();
      }
    })().catch(() => setError(copy.initialiseError));
    return () => {
      if (restartTimer.current) window.clearTimeout(restartTimer.current);
      void partialHandle?.remove();
      void stateHandle?.remove();
      void SpeechRecognition.stop();
    };
  }, [copy.initialiseError, copy.permissionRequired, language, scheduleRestart]);

  async function enableEmma() {
    try {
      const permission = await SpeechRecognition.requestPermissions();
      if (permission.speechRecognition !== "granted") {
        setError(copy.permissionRequired);
        return;
      }
      localStorage.setItem("vcubf.mobile-emma.enabled", "true");
      setEnabled(true);
      enabledRef.current = true;
      await startListening();
    } catch {
      setError(copy.permissionDenied);
    }
  }

  async function pauseEmma() {
    localStorage.setItem("vcubf.mobile-emma.enabled", "false");
    setEnabled(false);
    enabledRef.current = false;
    activeUntil.current = 0;
    await SpeechRecognition.stop().catch(() => undefined);
    setListening(false);
  }

  function clearTranscript() {
    if (!user) return;
    localStorage.removeItem(transcriptStorageKey(user.id));
    setTranscript([]);
    setHeard("");
    setAnswer("");
  }

  return (
    <section className="voice-control-center mobile-voice-control" aria-label={copy.title}>
      <div className="voice-control-header">
        <div>
          <strong>{copy.title}</strong>{" "}
          <span className={`voice-device-status ${thinking ? "status-thinking" : listening ? "status-listening" : "status-paused"}`}>
            {thinking ? copy.thinking : listening ? copy.listening(wakeWord) : copy.paused}
          </span>
        </div>
        <div className="voice-control-actions">
          {enabled ? <button type="button" className="voice-button" onClick={() => void pauseEmma()}>{copy.pause}</button> : <button type="button" onClick={() => void enableEmma()}>{copy.enable}</button>}
          <button type="button" className="voice-button" onClick={clearTranscript} disabled={transcript.length === 0}>{copy.deleteTranscript}</button>
        </div>
      </div>
      <div className={`voice-listening-assurance ${listening ? "is-active" : ""}`} role="status">
        <span aria-hidden="true" />
        {listening ? copy.microphoneActive(wakeWord) : copy.microphonePaused}
      </div>
      <div className="voice-observation-grid" aria-live="polite">
        <div><span className="voice-observation-label">{copy.heard}</span><div>{heard || copy.waiting}</div></div>
        <div><span className="voice-observation-label">{copy.answered}</span><div>{answer || copy.noResponse}</div></div>
      </div>
      <details className="voice-transcript-history">
        <summary>{copy.savedTranscript(transcript.length)}</summary>
        <p className="hint">{copy.transcriptPrivacy}</p>
        {transcript.map((turn, index) => <div className={`voice-transcript-message role-${turn.role}`} key={`${index}-${turn.content}`}><span>{turn.role === "user" ? copy.you : "{assistant}"}</span><div>{turn.content}</div></div>)}
      </details>
      <p className="hint voice-control-privacy">{copy.privacy(languageLabel(language, true))}</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
  );
}
