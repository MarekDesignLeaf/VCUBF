import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech, QueueStrategy } from "@capacitor-community/text-to-speech";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type MobileAssistantResponse } from "../api/client";
import { appLanguage, languageLabel } from "../i18n";
import { useAuth } from "../context/useAuth";

type TranscriptTurn = { role: "user" | "assistant"; content: string };

export function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

function normaliseForWakeWord(value: string) {
  return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function transcriptStorageKey(userId: string) {
  return `vcubf.mobile-emma.transcript.${userId}`;
}

export function MobileVoiceControl() {
  const { user, updateUser } = useAuth();
  const navigate = useNavigate();
  const language = appLanguage(user?.voiceLanguage);
  const wakeWord = (user?.voiceWakeWord || "Emma").trim();
  const [enabled, setEnabled] = useState(() => localStorage.getItem("vcubf.mobile-emma.enabled") === "true");
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
        setError("Speech recognition is unavailable on this phone. Install or enable Google speech services, then try again.");
        setEnabled(false);
        localStorage.removeItem("vcubf.mobile-emma.enabled");
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
      setError("Emma could not start the phone microphone. Check the microphone permission in Android settings.");
    }
  }, [language]);

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
      const responseText = result.assistantMessage || result.message || (result.ok ? "Done." : "I could not complete that request.");
      appendTurn({ role: "assistant", content: responseText });
      if (result.uiAction?.kind === "navigate") navigate(result.uiAction.path);
      if (result.uiAction?.kind === "set_language") updateUser({ voiceLanguage: result.uiAction.language });
      await speak(responseText);
      activeUntil.current = Date.now() + 20_000;
    } catch {
      const responseText = "I could not contact Secretary. Check your internet connection and try again.";
      appendTurn({ role: "assistant", content: responseText });
      await speak(responseText);
    } finally {
      setThinking(false);
      processing.current = false;
      scheduleRestart();
    }
  }, [appendTurn, language, navigate, scheduleRestart, speak, updateUser]);

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
        await speak(language.startsWith("cs") ? "Ano, poslouchám." : "Yes, I am listening.");
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
      if (enabledRef.current) await startRef.current();
    })().catch(() => setError("Emma could not initialise mobile speech recognition."));
    return () => {
      if (restartTimer.current) window.clearTimeout(restartTimer.current);
      void partialHandle?.remove();
      void stateHandle?.remove();
      void SpeechRecognition.stop();
    };
  }, [scheduleRestart]);

  async function enableEmma() {
    try {
      const permission = await SpeechRecognition.requestPermissions();
      if (permission.speechRecognition !== "granted") {
        setError("Microphone permission is required for Emma to listen.");
        return;
      }
      localStorage.setItem("vcubf.mobile-emma.enabled", "true");
      setEnabled(true);
      enabledRef.current = true;
      await startListening();
    } catch {
      setError("Android did not grant microphone permission to Emma.");
    }
  }

  async function pauseEmma() {
    localStorage.removeItem("vcubf.mobile-emma.enabled");
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
    <section className="voice-control-center mobile-voice-control" aria-label="Emma mobile voice control">
      <div className="voice-control-header">
        <div>
          <strong>Emma on this phone</strong>{" "}
          <span className={`voice-device-status ${thinking ? "status-thinking" : listening ? "status-listening" : "status-paused"}`}>
            {thinking ? "Thinking" : listening ? `Listening for ${wakeWord}` : "Paused"}
          </span>
        </div>
        <div className="voice-control-actions">
          {enabled ? <button type="button" className="voice-button" onClick={() => void pauseEmma()}>Pause Emma</button> : <button type="button" onClick={() => void enableEmma()}>Enable Emma</button>}
          <button type="button" className="voice-button" onClick={clearTranscript} disabled={transcript.length === 0}>Delete phone transcript</button>
        </div>
      </div>
      <div className={`voice-listening-assurance ${listening ? "is-active" : ""}`} role="status">
        <span aria-hidden="true" />
        {listening ? `Microphone active. Say “${wakeWord}”, then tell Emma what to do.` : "Enable Emma once to grant microphone permission. Afterwards she starts automatically when you sign in on this phone."}
      </div>
      <div className="voice-observation-grid" aria-live="polite">
        <div><span className="voice-observation-label">Emma heard</span><div>{heard || "Waiting for speech."}</div></div>
        <div><span className="voice-observation-label">Emma answered</span><div>{answer || "No response yet."}</div></div>
      </div>
      <details className="voice-transcript-history">
        <summary>Saved phone transcript ({transcript.length})</summary>
        <p className="hint">Only text is kept on this phone; microphone audio is never recorded.</p>
        {transcript.map((turn, index) => <div className={`voice-transcript-message role-${turn.role}`} key={`${index}-${turn.content}`}><span>{turn.role === "user" ? "You" : "Emma"}</span><div>{turn.content}</div></div>)}
      </details>
      <p className="hint voice-control-privacy">Recognition and speech use Android services in the foreground. Emma sends only the recognised text to Secretary; she preserves the same permissions and confirmation rules as the desktop app. Current language: {languageLabel(language, true)}.</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
  );
}
