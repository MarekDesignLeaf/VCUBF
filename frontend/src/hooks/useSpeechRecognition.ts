import { useCallback, useEffect, useRef, useState } from "react";

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionResult;
}

interface BrowserSpeechRecognitionEvent extends Event {
  readonly results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function recognitionConstructor(): BrowserSpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as typeof window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function speechErrorMessage(error: string) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission was denied. Allow microphone access in the browser and try again.";
    case "audio-capture":
      return "No working microphone was available.";
    case "no-speech":
      return "No speech was detected. Try again and speak an English command clearly.";
    case "network":
      return "The browser speech service could not be reached.";
    default:
      return "Voice input stopped because the browser speech service returned an error.";
  }
}

export function useSpeechRecognition(onTranscript: (transcript: string, isFinal: boolean) => void, language = "en-GB") {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const languageRef = useRef(language);
  const keepListeningRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const supported = Boolean(recognitionConstructor());

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => { languageRef.current = language; }, [language]);

  useEffect(() => {
    const Recognition = recognitionConstructor();
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = languageRef.current;
    recognition.onstart = () => {
      setError(null);
      setIsListening(true);
    };
    recognition.onend = () => {
      setIsListening(false);
      if (keepListeningRef.current) {
        restartTimerRef.current = window.setTimeout(() => {
          if (!keepListeningRef.current || !recognitionRef.current) return;
          try { recognition.lang = languageRef.current; recognition.start(); } catch { /* browser is still closing the previous session */ }
        }, 250);
      }
    };
    recognition.onerror = (event) => {
      if (event.error !== "no-speech" || !keepListeningRef.current) setError(speechErrorMessage(event.error));
      if (["not-allowed", "service-not-allowed", "audio-capture"].includes(event.error)) keepListeningRef.current = false;
      setIsListening(false);
    };
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += `${event.results[index][0]?.transcript ?? ""} `;
      }
      const last = event.results[event.results.length - 1];
      onTranscriptRef.current(transcript.trim(), Boolean(last?.isFinal));
    };
    recognitionRef.current = recognition;

    return () => {
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.abort();
      keepListeningRef.current = false;
      if (restartTimerRef.current != null) window.clearTimeout(restartTimerRef.current);
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback((continuous = false) => {
    setError(null);
    const recognition = recognitionRef.current;
    if (!recognition) {
      setError("Voice input is not ready in this browser. Try again or use the text field.");
      return;
    }
    try {
      keepListeningRef.current = continuous;
      recognition.continuous = continuous;
      recognition.lang = languageRef.current;
      recognition.start();
    } catch {
      keepListeningRef.current = false;
      setError("Voice input could not start. Stop any active recording and try again.");
    }
  }, []);

  const stop = useCallback(() => {
    keepListeningRef.current = false;
    if (restartTimerRef.current != null) window.clearTimeout(restartTimerRef.current);
    recognitionRef.current?.stop();
  }, []);

  return { supported, isListening, error, start, stop };
}
