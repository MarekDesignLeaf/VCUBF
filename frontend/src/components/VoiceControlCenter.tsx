import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SecretaryNavigationCatalogue, type VoiceConversation, type VoiceDeviceState, type VoiceUiAction } from "../api/client";
import { useAuth } from "../context/useAuth";
import { languageLabel } from "../i18n";

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

const STATUS_LABELS: Record<VoiceDeviceState["status"], string> = {
  offline: "Offline",
  listening: "Listening for Emma",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Paused",
  error: "Needs attention",
};

export function VoiceControlCenter() {
  const navigate = useNavigate();
  const { updateUser } = useAuth();
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
  }, []);

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
            }
          }
        }
      } catch {
        if (active) setError("Could not read the Windows Emma status.");
      } finally {
        if (active) timer = window.setTimeout(poll, 2000);
      }
    };
    poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [navigate, updateUser]);

  async function control(control: "pause" | "resume" | "end_conversation") {
    setBusy(true); setError(null);
    try { setState(await api.command.controlVoice(control)); }
    catch { setError("The control command could not be sent to Emma."); }
    finally { setBusy(false); }
  }

  async function clearHistory() {
    if (!window.confirm("Delete all saved Emma conversation transcripts and end the active conversation? Audio is not stored.")) return;
    setBusy(true); setError(null);
    try { setState(await api.command.clearVoiceHistory()); setConversations([]); }
    catch { setError("Emma's transcript history could not be deleted."); }
    finally { setBusy(false); }
  }

  const isPaused = state.status === "paused";
  const activeConversationCount = conversations.filter((conversation) => conversation.status === "active").length;
  return (
    <section className="voice-control-center" aria-label="Windows Emma control centre">
      <div className="voice-control-header">
        <div>
          <strong>Windows Emma</strong>{" "}
          <span className={`voice-device-status status-${state.status}`} role="status">{STATUS_LABELS[state.status]}</span>
          <span className="hint"> · {state.mode === "realtime" ? "Realtime conversation" : state.mode === "reviewed_text" ? "Reviewed transcript" : "Local wake word"}</span>
          <span className="hint"> · Active conversations: <strong>{activeConversationCount}</strong> (maximum 1) · Saved transcripts shown: {conversations.length}</span>
        </div>
        <div className="voice-control-actions">
          <button type="button" className="voice-button" disabled={busy || state.status === "offline"} onClick={() => control(isPaused ? "resume" : "pause")}>{isPaused ? "Resume listening" : "Pause listening"}</button>
          <button type="button" className="voice-button" disabled={busy || (state.status === "offline" && activeConversationCount === 0)} onClick={() => control("end_conversation")}>End active conversation</button>
          <button type="button" className="voice-button" disabled={busy || (!state.lastTranscript && !state.lastResponse && conversations.length === 0)} onClick={clearHistory}>Delete transcript history</button>
        </div>
      </div>
      <div className={`voice-listening-assurance ${state.listening ? "is-active" : ""}`} role="status">
        <span aria-hidden="true" />
        {state.listening
          ? "Background wake-word listener is active; it is not a conversation. " + (activeConversationCount === 1 ? "One Realtime conversation is active." : "No Realtime conversation is active.") + " Say “Emma” clearly to start one."
          : state.status === "paused" ? "Microphone reactions are paused." : "Emma is not receiving microphone input."}
      </div>
      {activeConversationCount > 1 && <div className="error-banner" role="alert">More than one Emma conversation is marked active. End the active conversation before starting another.</div>}
      {lastAction && (
        <div className="voice-ui-action" role="status">
          {lastAction.kind === "navigate"
            ? <>Emma opened <strong>{lastAction.label}</strong> in Secretary.</>
            : <>Emma changed the Secretary menu language to <strong>{languageLabel(lastAction.language, true)}</strong>.</>}
        </div>
      )}
      <div className="voice-observation-grid" aria-live="polite">
        <div><span className="voice-observation-label">Emma heard after activation</span><div>{state.lastTranscript || "Waiting for Emma to be activated."}</div></div>
        <div><span className="voice-observation-label">Emma answered</span><div>{state.lastResponse || "No response yet."}</div></div>
      </div>
      {navigation && (
        <details className="emma-navigation-catalogue">
          <summary>Complete Secretary menu Emma can read ({navigation.sections.length} sections)</summary>
          <p className="hint">This is the same backend-certified map Emma uses. It includes detail-screen subtrees and named controls, not only the visible sidebar rows.</p>
          {navigation.sections.map((section) => (
            <section className="emma-navigation-section" key={section.id}>
              <h3>{section.label}</h3>
              <p className="hint">{section.description}</p>
              <ul>
                {section.items.map((item) => (
                  <li key={item.id} className={item.available ? undefined : "emma-navigation-restricted"}>
                    <strong>{item.label}</strong> <code>{item.path}</code>
                    <div>{item.description}</div>
                    {item.controls.length > 0 && <div className="hint">Controls: {item.controls.join(", ")}</div>}
                    {!item.available && <div className="hint">{item.accessNote ?? "This item requires additional permission."}</div>}
                    {item.children.length > 0 && (
                      <ul className="emma-navigation-children">
                        {item.children.map((child) => (
                          <li key={`${item.id}-${child.label}`}>
                            <strong>{child.label}</strong>{child.path && <> <code>{child.path}</code></>}
                            <div>{child.description}</div>
                            {child.controls.length > 0 && <div className="hint">Controls: {child.controls.join(", ")}</div>}
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
      {navigationError && <p className="hint">Emma’s complete menu map could not be loaded right now.</p>}
      <details className="voice-transcript-history">
        <summary>Saved conversation transcripts — history, not active sessions ({conversations.length})</summary>
        {conversations.length === 0 ? <p className="hint">No saved conversations yet.</p> : conversations.map((conversation) => (
          <section className="voice-transcript-conversation" key={conversation.id}>
            <div className="voice-transcript-heading">
              <strong>{new Date(conversation.startedAt).toLocaleString()}</strong>
              <span className="hint">{conversation.mode.replace("_", " ")} · {conversation.status}</span>
            </div>
            {conversation.messages.map((message) => (
              <div className={`voice-transcript-message role-${message.role}`} key={message.id}>
                <span>{message.role === "user" ? "You" : "Emma"}</span>
                <div>{message.content}</div>
                <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleTimeString()}</time>
              </div>
            ))}
          </section>
        ))}
      </details>
      <p className="hint voice-control-privacy">Complete final text turns are saved after Emma is activated. The private <strong>What Emma hears</strong> monitor opens with the Windows companion; close it when it is not needed and reopen it from the tray with <strong>Show live hearing</strong>. Its pre-wake preview stays on this PC and is not saved or uploaded. Background speech is not retained, and VCUBF does not store microphone audio. Pause listening disables wake-word reactions; Delete transcript history ends the active conversation and removes all saved text conversations.</p>
      {state.pendingControl && <div className="voice-control-pending">Waiting for Emma to apply: {state.pendingControl.replace("_", " ")}…</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
    </section>
  );
}
