import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SecretaryNavigationCatalogue, type VoiceConversation, type VoiceDeviceState, type VoiceUiAction } from "../api/client";
import { useAuth } from "../context/useAuth";
import { appLanguage, languageLabel } from "../i18n";

const OFFLINE: VoiceDeviceState = {
  status: "offline",
  mode: "wake_word",
  listening: false,
  lastTranscript: null,
  lastResponse: null,
  lastUiAction: null,
  lastHeardAt: null,
  pendingControl: null,
  heartbeatAt: null,
};

const VOICE_COPY = {
  en: {
    status: { offline: "Offline", listening: "Listening for Emma", hearing: "Hearing you", thinking: "Thinking", speaking: "Speaking", paused: "Paused", error: "Needs attention" },
    readError: "Could not read the Windows Emma status.", controlError: "The control command could not be sent to Emma.",
    clearConfirm: "Delete all saved Emma conversation transcripts and end the active conversation? Audio is not stored.", clearError: "Emma's transcript history could not be deleted.",
    label: "Windows Emma control centre", realtime: "Realtime conversation", reviewed: "Reviewed transcript", wake: "Local wake word",
    active: "Active conversations", maximum: "maximum 1", saved: "Saved transcripts shown", resume: "Resume listening", pause: "Pause listening", end: "End active conversation", deleteHistory: "Delete transcript history",
    listener: "Background wake-word listener is active; it is not a conversation.", oneActive: "One Realtime conversation is active.", noneActive: "No Realtime conversation is active.", sayEmma: "Say “Emma” clearly to start one.", reactionsPaused: "Microphone reactions are paused.", noInput: "Emma is not receiving microphone input.", multiple: "More than one Emma conversation is marked active. End the active conversation before starting another.",
    opened: "Emma opened", openedSuffix: "in Secretary.", changed: "Emma changed the Secretary menu language to", heard: "Emma heard after activation", waiting: "Waiting for Emma to be activated.", answered: "Emma answered", noResponse: "No response yet.",
    menu: "Complete Secretary menu Emma can read", sections: "sections", menuHelp: "This is the same backend-certified map Emma uses. It includes detail-screen subtrees and named controls, not only the visible sidebar rows.", controls: "Controls", permission: "This item requires additional permission.", mapError: "Emma’s complete menu map could not be loaded right now.",
    history: "Saved conversation transcripts — history, not active sessions", noHistory: "No saved conversations yet.", you: "You", privacy: "Complete final text turns are saved after Emma is activated. The private What Emma hears monitor opens with the Windows companion; its pre-wake preview stays on this PC and is not saved or uploaded. Background speech and microphone audio are not stored. Pausing disables wake-word reactions; deleting transcript history ends the active conversation and removes all saved text conversations.", pending: "Waiting for Emma to apply",
  },
  pl: {
    status: { offline: "Offline", listening: "Nasłuchuje słowa Emma", hearing: "Słyszę Cię", thinking: "Myślę", speaking: "Mówię", paused: "Wstrzymana", error: "Wymaga uwagi" },
    readError: "Nie udało się odczytać stanu Emmy w Windows.", controlError: "Nie udało się wysłać polecenia sterującego do Emmy.",
    clearConfirm: "Usunąć wszystkie zapisane transkrypcje rozmów Emmy i zakończyć aktywną rozmowę? Dźwięk nie jest przechowywany.", clearError: "Nie udało się usunąć historii transkrypcji Emmy.",
    label: "Centrum sterowania Emmą w Windows", realtime: "Rozmowa w czasie rzeczywistym", reviewed: "Sprawdzona transkrypcja", wake: "Lokalne słowo aktywujące",
    active: "Aktywne rozmowy", maximum: "maksymalnie 1", saved: "Wyświetlone zapisane transkrypcje", resume: "Wznów nasłuchiwanie", pause: "Wstrzymaj nasłuchiwanie", end: "Zakończ aktywną rozmowę", deleteHistory: "Usuń historię transkrypcji",
    listener: "Nasłuchiwanie słowa aktywującego działa w tle; nie jest to rozmowa.", oneActive: "Jedna rozmowa w czasie rzeczywistym jest aktywna.", noneActive: "Żadna rozmowa w czasie rzeczywistym nie jest aktywna.", sayEmma: "Powiedz wyraźnie „Emma”, aby rozpocząć rozmowę.", reactionsPaused: "Reakcje mikrofonu są wstrzymane.", noInput: "Emma nie odbiera dźwięku z mikrofonu.", multiple: "Więcej niż jedna rozmowa Emmy jest oznaczona jako aktywna. Zakończ aktywną rozmowę przed rozpoczęciem kolejnej.",
    opened: "Emma otworzyła", openedSuffix: "w Secretary.", changed: "Emma zmieniła język menu Secretary na", heard: "Emma usłyszała po aktywacji", waiting: "Oczekiwanie na aktywację Emmy.", answered: "Emma odpowiedziała", noResponse: "Brak odpowiedzi.",
    menu: "Pełne menu Secretary dostępne dla Emmy", sections: "sekcji", menuHelp: "To ta sama zatwierdzona przez serwer mapa, z której korzysta Emma. Obejmuje podstrony szczegółów i nazwane elementy sterujące, a nie tylko widoczne pozycje menu.", controls: "Elementy sterujące", permission: "Ta pozycja wymaga dodatkowego uprawnienia.", mapError: "Nie udało się teraz wczytać pełnej mapy menu Emmy.",
    history: "Zapisane transkrypcje rozmów — historia, nie aktywne sesje", noHistory: "Nie ma jeszcze zapisanych rozmów.", you: "Ty", privacy: "Pełne końcowe wypowiedzi tekstowe są zapisywane po aktywacji Emmy. Prywatny monitor Co słyszy Emma otwiera się z aplikacją Windows; podgląd sprzed aktywacji pozostaje na tym komputerze i nie jest zapisywany ani wysyłany. Dźwięk z tła i mikrofonu nie jest przechowywany. Wstrzymanie wyłącza reakcje na słowo aktywujące; usunięcie historii kończy aktywną rozmowę i usuwa wszystkie zapisane transkrypcje.", pending: "Oczekiwanie na wykonanie przez Emmę",
  },
} as const;

export function VoiceControlCenter() {
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();
  const language = appLanguage(user?.voiceLanguage);
  const copy = language === "pl-PL" ? VOICE_COPY.pl : VOICE_COPY.en;
  const [state, setState] = useState<VoiceDeviceState>(OFFLINE);
  const [conversations, setConversations] = useState<VoiceConversation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<VoiceUiAction | null>(null);
  const [navigation, setNavigation] = useState<SecretaryNavigationCatalogue | null>(null);
  const [navigationError, setNavigationError] = useState(false);
  const handledActionId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    api.command.navigation()
      .then((catalogue) => { if (active) { setNavigation(catalogue); setNavigationError(false); } })
      .catch(() => { if (active) setNavigationError(true); });
    return () => { active = false; };
  }, [language]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const [next, history] = await Promise.all([api.command.voiceState(), api.command.voiceConversations(20)]);
        if (active) {
          setState(next); setConversations(history); setError(null);
          const action = next.lastUiAction;
          if (action && action.id !== handledActionId.current) {
            handledActionId.current = action.id;
            const storageKey = "vcubf.emma.last-ui-action";
            let alreadyHandled = false;
            try { alreadyHandled = window.localStorage.getItem(storageKey) === action.id; }
            catch { /* The ref still prevents repeats when storage is unavailable. */ }
            if (!alreadyHandled && action.kind === "navigate" && action.path.startsWith("/") && !action.path.startsWith("//")) {
              try { window.localStorage.setItem(storageKey, action.id); } catch { /* Navigation still works. */ }
              setLastAction(action);
              navigate(action.path);
            } else if (!alreadyHandled && action.kind === "set_language") {
              try { window.localStorage.setItem(storageKey, action.id); } catch { /* The in-memory ref still prevents repeats. */ }
              updateUser({ voiceLanguage: action.language });
              setLastAction(action);
            } else if (!alreadyHandled && action.kind === "external_url" && action.url.startsWith("https://")) {
              try { window.localStorage.setItem(storageKey, action.id); } catch { /* The in-memory ref still prevents repeats. */ }
              setLastAction(action);
              window.location.assign(action.url);
            } else if (!alreadyHandled && action.kind === "download" && /^\/(?:quotes|invoices)\/[a-f0-9-]+\/pdf$/i.test(action.path)) {
              try { window.localStorage.setItem(storageKey, action.id); } catch { /* The in-memory ref still prevents repeats. */ }
              const blob = await api.command.download(action.path);
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url; link.download = action.filename; link.click();
              URL.revokeObjectURL(url);
              setLastAction(action);
            }
          }
        }
      } catch {
        if (active) setError(copy.readError);
      } finally {
        if (active) timer = window.setTimeout(poll, 2000);
      }
    };
    poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [copy.readError, navigate, updateUser]);

  async function control(control: "pause" | "resume" | "end_conversation") {
    setBusy(true); setError(null);
    try { setState(await api.command.controlVoice(control)); }
    catch { setError(copy.controlError); }
    finally { setBusy(false); }
  }

  async function clearHistory() {
    if (!window.confirm(copy.clearConfirm)) return;
    setBusy(true); setError(null);
    try { setState(await api.command.clearVoiceHistory()); setConversations([]); }
    catch { setError(copy.clearError); }
    finally { setBusy(false); }
  }

  const isPaused = state.status === "paused";
  const activeConversationCount = conversations.filter((conversation) => conversation.status === "active").length;
  return (
    <section className="voice-control-center" aria-label={copy.label}>
      <div className="voice-control-header">
        <div>
          <strong>Windows Emma</strong>{" "}
          <span className={`voice-device-status status-${state.status}`} role="status">{copy.status[state.status]}</span>
          <span className="hint"> · {state.mode === "realtime" ? copy.realtime : state.mode === "reviewed_text" ? copy.reviewed : copy.wake}</span>
          <span className="hint"> · {copy.active}: <strong>{activeConversationCount}</strong> ({copy.maximum}) · {copy.saved}: {conversations.length}</span>
        </div>
        <div className="voice-control-actions">
          <button type="button" className="voice-button" disabled={busy || state.status === "offline"} onClick={() => control(isPaused ? "resume" : "pause")}>{isPaused ? copy.resume : copy.pause}</button>
          <button type="button" className="voice-button" disabled={busy || (state.status === "offline" && activeConversationCount === 0)} onClick={() => control("end_conversation")}>{copy.end}</button>
          <button type="button" className="voice-button" disabled={busy || (!state.lastTranscript && !state.lastResponse && conversations.length === 0)} onClick={clearHistory}>{copy.deleteHistory}</button>
        </div>
      </div>
      <div className={`voice-listening-assurance ${state.listening ? "is-active" : ""}`} role="status">
        <span aria-hidden="true" />
        {state.listening
          ? `${copy.listener} ${activeConversationCount === 1 ? copy.oneActive : copy.noneActive} ${copy.sayEmma}`
          : state.status === "paused" ? copy.reactionsPaused : copy.noInput}
      </div>
      {activeConversationCount > 1 && <div className="error-banner" role="alert">{copy.multiple}</div>}
      {lastAction && (
        <div className="voice-ui-action" role="status">
          {lastAction.kind === "navigate"
            ? <>{copy.opened} <strong>{lastAction.label}</strong> {copy.openedSuffix}</>
            : lastAction.kind === "set_language"
              ? <>{copy.changed} <strong>{languageLabel(lastAction.language, true)}</strong>.</>
              : <>{copy.opened} <strong>{lastAction.label}</strong>.</>}
        </div>
      )}
      <div className="voice-observation-grid" aria-live="polite">
        <div><span className="voice-observation-label">{copy.heard}</span><div>{state.lastTranscript || copy.waiting}</div></div>
        <div><span className="voice-observation-label">{copy.answered}</span><div>{state.lastResponse || copy.noResponse}</div></div>
      </div>
      {navigation && (
        <details className="emma-navigation-catalogue">
          <summary>{copy.menu} ({navigation.sections.length} {copy.sections})</summary>
          <p className="hint">{copy.menuHelp}</p>
          {navigation.sections.map((section) => (
            <section className="emma-navigation-section" key={section.id}>
              <h3>{section.label}</h3>
              <p className="hint">{section.description}</p>
              <ul>
                {section.items.map((item) => (
                  <li key={item.id} className={item.available ? undefined : "emma-navigation-restricted"}>
                    <strong>{item.label}</strong> <code>{item.path}</code>
                    <div>{item.description}</div>
                    {item.controls.length > 0 && <div className="hint">{copy.controls}: {item.controls.join(", ")}</div>}
                    {!item.available && <div className="hint">{item.accessNote ?? copy.permission}</div>}
                    {item.children.length > 0 && (
                      <ul className="emma-navigation-children">
                        {item.children.map((child) => (
                          <li key={`${item.id}-${child.label}`}>
                            <strong>{child.label}</strong>{child.path && <> <code>{child.path}</code></>}
                            <div>{child.description}</div>
                            {child.controls.length > 0 && <div className="hint">{copy.controls}: {child.controls.join(", ")}</div>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </details>
      )}
      {navigationError && <p className="hint">{copy.mapError}</p>}
      <details className="voice-transcript-history">
        <summary>{copy.history} ({conversations.length})</summary>
        {conversations.length === 0 ? <p className="hint">{copy.noHistory}</p> : conversations.map((conversation) => (
          <section className="voice-transcript-conversation" key={conversation.id}>
            <div className="voice-transcript-heading">
              <strong>{new Date(conversation.startedAt).toLocaleString(language)}</strong>
              <span className="hint">{conversation.mode.replace("_", " ")} · {conversation.status}</span>
            </div>
            {conversation.messages.map((message) => (
              <div className={`voice-transcript-message role-${message.role}`} key={message.id}>
                <span>{message.role === "user" ? copy.you : "Emma"}</span>
                <div>{message.content}</div>
                <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleTimeString(language)}</time>
              </div>
            ))}
          </section>
        ))}
      </details>
      <p className="hint voice-control-privacy">{copy.privacy}</p>
      {state.pendingControl && <div className="voice-control-pending">{copy.pending}: {state.pendingControl.replace("_", " ")}…</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
  );
}
