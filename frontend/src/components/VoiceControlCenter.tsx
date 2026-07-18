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
    listener: "Background wake-word listener is active; it is not a conversation.", oneActive: "One Realtime conversation is active.", noneActive: "No Realtime conversation is active.", sayEmma: "Say “Emma” clearly to start one.", speakNow: "Speak now; during the active conversation you do not need to repeat “Emma”.", reactionsPaused: "Microphone reactions are paused.", noInput: "Emma is not receiving microphone input.", multiple: "More than one Emma conversation is marked active. End the active conversation before starting another.",
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
    listener: "Nasłuchiwanie słowa aktywującego działa w tle; nie jest to rozmowa.", oneActive: "Jedna rozmowa w czasie rzeczywistym jest aktywna.", noneActive: "Żadna rozmowa w czasie rzeczywistym nie jest aktywna.", sayEmma: "Powiedz wyraźnie „Emma”, aby rozpocząć rozmowę.", speakNow: "Mów teraz; podczas aktywnej rozmowy nie musisz ponownie mówić „Emma”.", reactionsPaused: "Reakcje mikrofonu są wstrzymane.", noInput: "Emma nie odbiera dźwięku z mikrofonu.", multiple: "Więcej niż jedna rozmowa Emmy jest oznaczona jako aktywna. Zakończ aktywną rozmowę przed rozpoczęciem kolejnej.",
    opened: "Emma otworzyła", openedSuffix: "w Secretary.", changed: "Emma zmieniła język menu Secretary na", heard: "Emma usłyszała po aktywacji", waiting: "Oczekiwanie na aktywację Emmy.", answered: "Emma odpowiedziała", noResponse: "Brak odpowiedzi.",
    menu: "Pełne menu Secretary dostępne dla Emmy", sections: "sekcji", menuHelp: "To ta sama zatwierdzona przez serwer mapa, z której korzysta Emma. Obejmuje podstrony szczegółów i nazwane elementy sterujące, a nie tylko widoczne pozycje menu.", controls: "Elementy sterujące", permission: "Ta pozycja wymaga dodatkowego uprawnienia.", mapError: "Nie udało się teraz wczytać pełnej mapy menu Emmy.",
    history: "Zapisane transkrypcje rozmów — historia, nie aktywne sesje", noHistory: "Nie ma jeszcze zapisanych rozmów.", you: "Ty", privacy: "Pełne końcowe wypowiedzi tekstowe są zapisywane po aktywacji Emmy. Prywatny monitor Co słyszy Emma otwiera się z aplikacją Windows; podgląd sprzed aktywacji pozostaje na tym komputerze i nie jest zapisywany ani wysyłany. Dźwięk z tła i mikrofonu nie jest przechowywany. Wstrzymanie wyłącza reakcje na słowo aktywujące; usunięcie historii kończy aktywną rozmowę i usuwa wszystkie zapisane transkrypcje.", pending: "Oczekiwanie na wykonanie przez Emmę",
  },
  cs: {
    status: { offline: "Offline", listening: "Naslouchá oslovení Emma", hearing: "Slyším vás", thinking: "Přemýšlím", speaking: "Mluvím", paused: "Pozastaveno", error: "Vyžaduje pozornost" },
    readError: "Nepodařilo se načíst stav Windows Emmy.", controlError: "Řídicí příkaz se nepodařilo Emmě odeslat.",
    clearConfirm: "Smazat všechny uložené přepisy rozhovorů s Emmou a ukončit aktivní rozhovor? Zvuk se neukládá.", clearError: "Historii přepisů Emmy se nepodařilo smazat.",
    label: "Ovládací centrum Windows Emmy", realtime: "Konverzace v reálném čase", reviewed: "Zkontrolovaný přepis", wake: "Lokální aktivační slovo",
    active: "Aktivní rozhovory", maximum: "maximálně 1", saved: "Zobrazené uložené přepisy", resume: "Obnovit naslouchání", pause: "Pozastavit naslouchání", end: "Ukončit aktivní rozhovor", deleteHistory: "Smazat historii přepisů",
    listener: "Naslouchání aktivačnímu slovu běží na pozadí; nejde o rozhovor.", oneActive: "Je aktivní jeden rozhovor v reálném čase.", noneActive: "Není aktivní žádný rozhovor v reálném čase.", sayEmma: "Řekněte zřetelně „Emma“ pro zahájení rozhovoru.", speakNow: "Nyní mluvte; během aktivního rozhovoru už nemusíte opakovat „Emma“.", reactionsPaused: "Reakce mikrofonu jsou pozastavené.", noInput: "Emma nepřijímá zvuk z mikrofonu.", multiple: "Více než jeden rozhovor Emmy je označen jako aktivní. Před zahájením dalšího ukončete aktivní rozhovor.",
    opened: "Emma otevřela", openedSuffix: "v Secretary.", changed: "Emma změnila jazyk menu Secretary na", heard: "Emma slyšela po aktivaci", waiting: "Čeká se na aktivaci Emmy.", answered: "Emma odpověděla", noResponse: "Zatím žádná odpověď.",
    menu: "Úplné menu Secretary, které Emma umí číst", sections: "sekcí", menuHelp: "Jde o stejnou serverem ověřenou mapu, kterou používá Emma. Obsahuje podstromy detailních obrazovek a pojmenované ovládací prvky, nejen viditelné položky postranního menu.", controls: "Ovládací prvky", permission: "Tato položka vyžaduje další oprávnění.", mapError: "Úplnou mapu menu Emmy se nyní nepodařilo načíst.",
    history: "Uložené přepisy rozhovorů — historie, nikoli aktivní relace", noHistory: "Zatím nejsou uložené žádné rozhovory.", you: "Vy", privacy: "Úplné finální textové repliky se ukládají po aktivaci Emmy. Soukromý monitor Co Emma slyší se otevírá s aplikací Windows; náhled před aktivací zůstává v tomto počítači a neukládá se ani neodesílá. Zvuk na pozadí ani zvuk z mikrofonu se neukládá. Pozastavení vypne reakce na aktivační slovo; smazání historie ukončí aktivní rozhovor a odstraní všechny uložené textové konverzace.", pending: "Čeká se, až Emma provede",
  },
  fr: {
    status: { offline: "Hors ligne", listening: "À l’écoute du mot Emma", hearing: "Je vous entends", thinking: "Réflexion", speaking: "Parle", paused: "En pause", error: "Attention requise" },
    readError: "Impossible de lire l’état d’Emma sous Windows.", controlError: "La commande de contrôle n’a pas pu être envoyée à Emma.", clearConfirm: "Supprimer toutes les transcriptions enregistrées et terminer la conversation active ? Le son n’est pas conservé.", clearError: "Impossible de supprimer l’historique des transcriptions d’Emma.",
    label: "Centre de contrôle d’Emma sous Windows", realtime: "Conversation en temps réel", reviewed: "Transcription vérifiée", wake: "Mot d’activation local", active: "Conversations actives", maximum: "maximum 1", saved: "Transcriptions affichées", resume: "Reprendre l’écoute", pause: "Mettre l’écoute en pause", end: "Terminer la conversation active", deleteHistory: "Supprimer l’historique",
    listener: "L’écoute du mot d’activation fonctionne en arrière-plan ; ce n’est pas une conversation.", oneActive: "Une conversation en temps réel est active.", noneActive: "Aucune conversation en temps réel n’est active.", sayEmma: "Dites clairement « Emma » pour en commencer une.", speakNow: "Parlez maintenant ; pendant la conversation active, inutile de répéter « Emma ».", reactionsPaused: "Les réactions du microphone sont en pause.", noInput: "Emma ne reçoit aucun son du microphone.", multiple: "Plusieurs conversations d’Emma sont marquées actives. Terminez la conversation active avant d’en commencer une autre.",
    opened: "Emma a ouvert", openedSuffix: "dans Secretary.", changed: "Emma a changé la langue du menu Secretary en", heard: "Emma a entendu après l’activation", waiting: "En attente de l’activation d’Emma.", answered: "Emma a répondu", noResponse: "Aucune réponse pour le moment.", menu: "Menu complet de Secretary lisible par Emma", sections: "sections", menuHelp: "Il s’agit de la même carte certifiée par le serveur qu’utilise Emma. Elle comprend les sous-écrans de détail et les contrôles nommés, pas seulement les lignes visibles du menu.", controls: "Contrôles", permission: "Cet élément exige une autorisation supplémentaire.", mapError: "Impossible de charger la carte complète du menu d’Emma.",
    history: "Transcriptions enregistrées — historique, pas sessions actives", noHistory: "Aucune conversation enregistrée.", you: "Vous", privacy: "Les tours de texte finaux sont enregistrés après l’activation d’Emma. Le moniteur privé Ce qu’Emma entend s’ouvre avec l’application Windows ; l’aperçu avant activation reste sur ce PC et n’est ni enregistré ni envoyé. Le son ambiant et le son du microphone ne sont pas conservés. La pause désactive les réactions au mot d’activation ; la suppression de l’historique termine la conversation active et efface toutes les conversations textuelles enregistrées.", pending: "En attente de l’exécution par Emma",
  },
  de: {
    status: { offline: "Offline", listening: "Wartet auf Emma", hearing: "Ich höre Sie", thinking: "Denkt nach", speaking: "Spricht", paused: "Pausiert", error: "Aufmerksamkeit erforderlich" },
    readError: "Der Status von Windows Emma konnte nicht gelesen werden.", controlError: "Der Steuerbefehl konnte nicht an Emma gesendet werden.", clearConfirm: "Alle gespeicherten Gesprächsprotokolle löschen und das aktive Gespräch beenden? Audio wird nicht gespeichert.", clearError: "Emmas Protokollverlauf konnte nicht gelöscht werden.",
    label: "Steuerzentrale für Windows Emma", realtime: "Echtzeitgespräch", reviewed: "Geprüftes Protokoll", wake: "Lokales Aktivierungswort", active: "Aktive Gespräche", maximum: "höchstens 1", saved: "Angezeigte gespeicherte Protokolle", resume: "Zuhören fortsetzen", pause: "Zuhören pausieren", end: "Aktives Gespräch beenden", deleteHistory: "Protokollverlauf löschen",
    listener: "Das Aktivierungswort wird im Hintergrund überwacht; dies ist kein Gespräch.", oneActive: "Ein Echtzeitgespräch ist aktiv.", noneActive: "Kein Echtzeitgespräch ist aktiv.", sayEmma: "Sagen Sie deutlich „Emma“, um eines zu starten.", speakNow: "Sprechen Sie jetzt; im aktiven Gespräch müssen Sie „Emma“ nicht wiederholen.", reactionsPaused: "Mikrofonreaktionen sind pausiert.", noInput: "Emma empfängt keinen Mikrofonton.", multiple: "Mehr als ein Emma-Gespräch ist als aktiv markiert. Beenden Sie das aktive Gespräch, bevor Sie ein weiteres starten.",
    opened: "Emma öffnete", openedSuffix: "in Secretary.", changed: "Emma änderte die Sprache des Secretary-Menüs zu", heard: "Emma hörte nach der Aktivierung", waiting: "Warte auf Emmas Aktivierung.", answered: "Emma antwortete", noResponse: "Noch keine Antwort.", menu: "Vollständiges Secretary-Menü, das Emma lesen kann", sections: "Bereiche", menuHelp: "Dies ist dieselbe servergeprüfte Karte, die Emma verwendet. Sie enthält Unterseiten und benannte Steuerelemente, nicht nur die sichtbaren Menüzeilen.", controls: "Steuerelemente", permission: "Dieses Element erfordert eine zusätzliche Berechtigung.", mapError: "Emmas vollständige Menükarte konnte nicht geladen werden.",
    history: "Gespeicherte Gesprächsprotokolle — Verlauf, keine aktiven Sitzungen", noHistory: "Noch keine gespeicherten Gespräche.", you: "Sie", privacy: "Vollständige finale Textbeiträge werden nach Emmas Aktivierung gespeichert. Der private Monitor Was Emma hört wird mit der Windows-App geöffnet; die Vorschau vor der Aktivierung bleibt auf diesem PC und wird weder gespeichert noch hochgeladen. Hintergrundsprache und Mikrofonton werden nicht gespeichert. Eine Pause deaktiviert Reaktionen auf das Aktivierungswort; das Löschen des Verlaufs beendet das aktive Gespräch und entfernt alle gespeicherten Textgespräche.", pending: "Warte auf Emmas Ausführung",
  },
  es: {
    status: { offline: "Sin conexión", listening: "Escuchando la palabra Emma", hearing: "Le escucho", thinking: "Pensando", speaking: "Hablando", paused: "En pausa", error: "Requiere atención" },
    readError: "No se pudo leer el estado de Emma en Windows.", controlError: "No se pudo enviar la orden de control a Emma.", clearConfirm: "¿Borrar todas las transcripciones guardadas y terminar la conversación activa? El audio no se almacena.", clearError: "No se pudo borrar el historial de transcripciones de Emma.",
    label: "Centro de control de Emma para Windows", realtime: "Conversación en tiempo real", reviewed: "Transcripción revisada", wake: "Palabra de activación local", active: "Conversaciones activas", maximum: "máximo 1", saved: "Transcripciones guardadas mostradas", resume: "Reanudar escucha", pause: "Pausar escucha", end: "Terminar conversación activa", deleteHistory: "Borrar historial",
    listener: "La escucha de la palabra de activación está activa en segundo plano; no es una conversación.", oneActive: "Hay una conversación en tiempo real activa.", noneActive: "No hay ninguna conversación en tiempo real activa.", sayEmma: "Diga «Emma» claramente para iniciar una.", speakNow: "Hable ahora; durante la conversación activa no necesita repetir «Emma».", reactionsPaused: "Las reacciones del micrófono están en pausa.", noInput: "Emma no recibe audio del micrófono.", multiple: "Hay más de una conversación de Emma marcada como activa. Termine la conversación activa antes de iniciar otra.",
    opened: "Emma abrió", openedSuffix: "en Secretary.", changed: "Emma cambió el idioma del menú de Secretary a", heard: "Emma oyó después de la activación", waiting: "Esperando la activación de Emma.", answered: "Emma respondió", noResponse: "Todavía no hay respuesta.", menu: "Menú completo de Secretary que Emma puede leer", sections: "secciones", menuHelp: "Es el mismo mapa certificado por el servidor que usa Emma. Incluye subpantallas de detalle y controles con nombre, no solo las filas visibles del menú.", controls: "Controles", permission: "Este elemento requiere un permiso adicional.", mapError: "No se pudo cargar el mapa completo del menú de Emma.",
    history: "Transcripciones guardadas — historial, no sesiones activas", noHistory: "Aún no hay conversaciones guardadas.", you: "Usted", privacy: "Los turnos de texto finales se guardan después de activar a Emma. El monitor privado Lo que oye Emma se abre con la aplicación de Windows; la vista previa anterior a la activación permanece en este PC y no se guarda ni se envía. El sonido de fondo y el audio del micrófono no se almacenan. La pausa desactiva las reacciones a la palabra de activación; borrar el historial termina la conversación activa y elimina todas las conversaciones de texto guardadas.", pending: "Esperando a que Emma ejecute",
  },
  it: {
    status: { offline: "Non in linea", listening: "In ascolto della parola Emma", hearing: "La ascolto", thinking: "Sta pensando", speaking: "Sta parlando", paused: "In pausa", error: "Richiede attenzione" },
    readError: "Impossibile leggere lo stato di Emma in Windows.", controlError: "Impossibile inviare il comando di controllo a Emma.", clearConfirm: "Eliminare tutte le trascrizioni salvate e terminare la conversazione attiva? L’audio non viene conservato.", clearError: "Impossibile eliminare la cronologia delle trascrizioni di Emma.",
    label: "Centro di controllo di Emma per Windows", realtime: "Conversazione in tempo reale", reviewed: "Trascrizione verificata", wake: "Parola di attivazione locale", active: "Conversazioni attive", maximum: "massimo 1", saved: "Trascrizioni salvate mostrate", resume: "Riprendi ascolto", pause: "Metti in pausa l’ascolto", end: "Termina conversazione attiva", deleteHistory: "Elimina cronologia",
    listener: "L’ascolto della parola di attivazione è attivo in background; non è una conversazione.", oneActive: "È attiva una conversazione in tempo reale.", noneActive: "Non è attiva alcuna conversazione in tempo reale.", sayEmma: "Dica chiaramente “Emma” per avviarne una.", speakNow: "Parli ora; durante la conversazione attiva non deve ripetere “Emma”.", reactionsPaused: "Le reazioni del microfono sono in pausa.", noInput: "Emma non riceve audio dal microfono.", multiple: "Più di una conversazione di Emma risulta attiva. Termini quella attiva prima di iniziarne un’altra.",
    opened: "Emma ha aperto", openedSuffix: "in Secretary.", changed: "Emma ha cambiato la lingua del menu Secretary in", heard: "Emma ha sentito dopo l’attivazione", waiting: "In attesa dell’attivazione di Emma.", answered: "Emma ha risposto", noResponse: "Nessuna risposta.", menu: "Menu completo di Secretary leggibile da Emma", sections: "sezioni", menuHelp: "È la stessa mappa certificata dal server usata da Emma. Include le sottopagine di dettaglio e i controlli nominati, non solo le righe visibili del menu.", controls: "Controlli", permission: "Questo elemento richiede un’autorizzazione aggiuntiva.", mapError: "Impossibile caricare la mappa completa del menu di Emma.",
    history: "Trascrizioni salvate — cronologia, non sessioni attive", noHistory: "Non ci sono ancora conversazioni salvate.", you: "Lei", privacy: "I turni testuali finali vengono salvati dopo l’attivazione di Emma. Il monitor privato Cosa sente Emma si apre con l’app Windows; l’anteprima precedente all’attivazione resta su questo PC e non viene salvata né inviata. Il suono di fondo e l’audio del microfono non vengono conservati. La pausa disattiva le reazioni alla parola di attivazione; l’eliminazione della cronologia termina la conversazione attiva e rimuove tutte le conversazioni testuali salvate.", pending: "In attesa dell’esecuzione di Emma",
  },
} as const;

export function VoiceControlCenter() {
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();
  const language = appLanguage(user?.voiceLanguage);
  const copy = language === "cs-CZ" ? VOICE_COPY.cs
    : language === "pl-PL" ? VOICE_COPY.pl
      : language === "fr-FR" ? VOICE_COPY.fr
        : language === "de-DE" ? VOICE_COPY.de
          : language === "es-ES" ? VOICE_COPY.es
            : language === "it-IT" ? VOICE_COPY.it
              : VOICE_COPY.en;
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
  const realtimeConversationActive = state.mode === "realtime" || activeConversationCount === 1;
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
          ? realtimeConversationActive
            ? `${copy.oneActive} ${copy.speakNow}`
            : `${copy.listener} ${copy.noneActive} ${copy.sayEmma}`
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
