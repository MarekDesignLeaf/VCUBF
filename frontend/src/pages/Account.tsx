import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/useAuth";
import { APP_LANGUAGES, appLanguage, languageLabel, type AppLanguage } from "../i18n";

type AccountCopy = {
  title: string; signedIn: string; connect: string; connectDescription: string; codeHint: string; connected: string; retry: string; connecting: string;
  temporary: string; changePassword: string; passwordHint: string; currentPassword: string; newPassword: string; confirmPassword: string;
  mismatch: string; currentInvalid: string; unchanged: string; changeError: string; changing: string; change: string;
  voice: string; voiceHelp: string; wakeWord: string; language: string; languageHint: string; continuous: string;
  saved: string; saveError: string; saving: string; save: string; pairError: string; approveError: string;
};

const ACCOUNT_COPY: Record<AppLanguage, AccountCopy> = {
  "en-GB": { title: "Account", signedIn: "Signed in as", connect: "Connect Windows Emma", connectDescription: "The Windows companion launched from this PC is being connected to your signed-in VCUBF account.", codeHint: "This one-time code came from the desktop launcher and expires after ten minutes.", connected: "Emma is connected, active and listening. You may close this page.", retry: "Try again", connecting: "Connecting Emma…", temporary: "You are using a temporary password. Change it before continuing to Secretary.", changePassword: "Change password", passwordHint: "Use at least 12 characters with uppercase, lowercase and a number.", currentPassword: "Current password", newPassword: "New password", confirmPassword: "Confirm new password", mismatch: "New password confirmation does not match.", currentInvalid: "Current password is incorrect.", unchanged: "The new password must differ from the current password.", changeError: "Could not change password.", changing: "Changing…", change: "Change password", voice: "Voice control", voiceHelp: "The Windows companion listens locally for the wake word whenever it is running. Say Emma, then speak naturally. The private live-hearing monitor opens automatically; pre-wake recognition is not uploaded or saved.", wakeWord: "Wake word", language: "Emma and Secretary menu language", languageHint: "Changing this setting changes Emma’s spoken language and the entire Secretary interface together. Emma applies it after her current answer.", continuous: "Enable wake-word listening controls", saved: "Voice and interface language saved. Secretary updates immediately; Emma applies it after her current answer.", saveError: "Could not save voice preferences.", saving: "Saving…", save: "Save voice preferences", pairError: "Could not connect the Windows companion.", approveError: "Could not approve the Windows companion." },
  "en-US": { title: "Account", signedIn: "Signed in as", connect: "Connect Windows Emma", connectDescription: "The Windows companion launched from this PC is being connected to your signed-in VCUBF account.", codeHint: "This one-time code came from the desktop launcher and expires after ten minutes.", connected: "Emma is connected, active and listening. You may close this page.", retry: "Try again", connecting: "Connecting Emma…", temporary: "You are using a temporary password. Change it before continuing to Secretary.", changePassword: "Change password", passwordHint: "Use at least 12 characters with uppercase, lowercase and a number.", currentPassword: "Current password", newPassword: "New password", confirmPassword: "Confirm new password", mismatch: "New password confirmation does not match.", currentInvalid: "Current password is incorrect.", unchanged: "The new password must differ from the current password.", changeError: "Could not change password.", changing: "Changing…", change: "Change password", voice: "Voice control", voiceHelp: "The Windows companion listens locally for the wake word whenever it is running. Say Emma, then speak naturally. The private live-hearing monitor opens automatically; pre-wake recognition is not uploaded or saved.", wakeWord: "Wake word", language: "Emma and Secretary menu language", languageHint: "Changing this setting changes Emma’s spoken language and the entire Secretary interface together. Emma applies it after her current answer.", continuous: "Enable wake-word listening controls", saved: "Voice and interface language saved. Secretary updates immediately; Emma applies it after her current answer.", saveError: "Could not save voice preferences.", saving: "Saving…", save: "Save voice preferences", pairError: "Could not connect the Windows companion.", approveError: "Could not approve the Windows companion." },
  "cs-CZ": { title: "Účet", signedIn: "Přihlášený uživatel", connect: "Připojit Windows Emmu", connectDescription: "Doprovodná aplikace Windows spuštěná na tomto počítači se připojuje k vašemu přihlášenému účtu VCUBF.", codeHint: "Tento jednorázový kód vytvořil spouštěč na ploše a jeho platnost skončí za deset minut.", connected: "Emma je připojená, aktivní a naslouchá. Tuto stránku můžete zavřít.", retry: "Zkusit znovu", connecting: "Připojování Emmy…", temporary: "Používáte dočasné heslo. Před pokračováním do Secretary ho změňte.", changePassword: "Změna hesla", passwordHint: "Použijte nejméně 12 znaků, velké i malé písmeno a číslici.", currentPassword: "Současné heslo", newPassword: "Nové heslo", confirmPassword: "Potvrzení nového hesla", mismatch: "Potvrzení nového hesla se neshoduje.", currentInvalid: "Současné heslo není správné.", unchanged: "Nové heslo se musí lišit od současného hesla.", changeError: "Heslo se nepodařilo změnit.", changing: "Změna…", change: "Změnit heslo", voice: "Hlasové ovládání", voiceHelp: "Doprovodná aplikace Windows při svém běhu místně naslouchá aktivačnímu slovu. Řekněte Emma a potom mluvte přirozeně. Soukromý monitor slyšeného textu se otevře automaticky; rozpoznání před aktivací se neodesílá ani neukládá.", wakeWord: "Aktivační slovo", language: "Jazyk Emmy a celého rozhraní Secretary", languageHint: "Toto nastavení změní současně mluvený jazyk Emmy i celé rozhraní Secretary. Emma ho použije po dokončení právě probíhající odpovědi.", continuous: "Zapnout ovládání naslouchání aktivačnímu slovu", saved: "Jazyk hlasu i rozhraní byl uložen. Secretary se změní okamžitě; Emma po dokončení současné odpovědi.", saveError: "Nastavení hlasu se nepodařilo uložit.", saving: "Ukládání…", save: "Uložit nastavení hlasu", pairError: "Doprovodnou aplikaci Windows se nepodařilo připojit.", approveError: "Připojení doprovodné aplikace Windows se nepodařilo schválit." },
  "pl-PL": { title: "Konto", signedIn: "Zalogowany użytkownik", connect: "Połącz Emmę w Windows", connectDescription: "Aplikacja Windows uruchomiona na tym komputerze jest łączona z zalogowanym kontem VCUBF.", codeHint: "Ten jednorazowy kod pochodzi z programu uruchamiającego i wygasa po dziesięciu minutach.", connected: "Emma jest połączona, aktywna i nasłuchuje. Możesz zamknąć tę stronę.", retry: "Spróbuj ponownie", connecting: "Łączenie Emmy…", temporary: "Używasz hasła tymczasowego. Zmień je przed dalszą pracą w Secretary.", changePassword: "Zmiana hasła", passwordHint: "Użyj co najmniej 12 znaków, wielkiej i małej litery oraz cyfry.", currentPassword: "Obecne hasło", newPassword: "Nowe hasło", confirmPassword: "Potwierdź nowe hasło", mismatch: "Potwierdzenie nowego hasła jest inne.", currentInvalid: "Obecne hasło jest nieprawidłowe.", unchanged: "Nowe hasło musi różnić się od obecnego.", changeError: "Nie udało się zmienić hasła.", changing: "Zmienianie…", change: "Zmień hasło", voice: "Sterowanie głosowe", voiceHelp: "Aplikacja Windows lokalnie nasłuchuje słowa aktywującego, gdy jest uruchomiona. Powiedz Emma, a następnie mów naturalnie. Prywatny monitor słyszanego tekstu otwiera się automatycznie; rozpoznanie przed aktywacją nie jest wysyłane ani zapisywane.", wakeWord: "Słowo aktywujące", language: "Język Emmy i całego interfejsu Secretary", languageHint: "To ustawienie jednocześnie zmienia język mówiony Emmy i cały interfejs Secretary. Emma zastosuje je po zakończeniu bieżącej odpowiedzi.", continuous: "Włącz sterowanie nasłuchiwaniem słowa aktywującego", saved: "Język głosu i interfejsu został zapisany. Secretary zmienia się od razu; Emma po bieżącej odpowiedzi.", saveError: "Nie udało się zapisać ustawień głosu.", saving: "Zapisywanie…", save: "Zapisz ustawienia głosu", pairError: "Nie udało się połączyć aplikacji Windows.", approveError: "Nie udało się zatwierdzić aplikacji Windows." },
  "fr-FR": { title: "Compte", signedIn: "Connecté en tant que", connect: "Connecter Emma sous Windows", connectDescription: "L’application Windows lancée sur ce PC se connecte à votre compte VCUBF actif.", codeHint: "Ce code à usage unique provient du lanceur et expire après dix minutes.", connected: "Emma est connectée, active et à l’écoute. Vous pouvez fermer cette page.", retry: "Réessayer", connecting: "Connexion d’Emma…", temporary: "Vous utilisez un mot de passe temporaire. Modifiez-le avant de continuer.", changePassword: "Modifier le mot de passe", passwordHint: "Utilisez au moins 12 caractères avec majuscule, minuscule et chiffre.", currentPassword: "Mot de passe actuel", newPassword: "Nouveau mot de passe", confirmPassword: "Confirmer le nouveau mot de passe", mismatch: "La confirmation du nouveau mot de passe ne correspond pas.", currentInvalid: "Le mot de passe actuel est incorrect.", unchanged: "Le nouveau mot de passe doit être différent de l’actuel.", changeError: "Impossible de modifier le mot de passe.", changing: "Modification…", change: "Modifier le mot de passe", voice: "Commande vocale", voiceHelp: "L’application Windows écoute localement le mot d’activation lorsqu’elle fonctionne. Dites Emma, puis parlez naturellement. Le moniteur privé s’ouvre automatiquement ; la reconnaissance avant activation n’est ni envoyée ni enregistrée.", wakeWord: "Mot d’activation", language: "Langue d’Emma et de toute l’interface Secretary", languageHint: "Ce réglage modifie ensemble la langue parlée d’Emma et toute l’interface Secretary. Emma l’applique après sa réponse en cours.", continuous: "Activer les contrôles d’écoute du mot d’activation", saved: "Langue de la voix et de l’interface enregistrée. Secretary est actualisé immédiatement ; Emma après sa réponse en cours.", saveError: "Impossible d’enregistrer les préférences vocales.", saving: "Enregistrement…", save: "Enregistrer les préférences vocales", pairError: "Impossible de connecter l’application Windows.", approveError: "Impossible d’approuver l’application Windows." },
  "de-DE": { title: "Konto", signedIn: "Angemeldet als", connect: "Windows Emma verbinden", connectDescription: "Die auf diesem PC gestartete Windows-App wird mit Ihrem angemeldeten VCUBF-Konto verbunden.", codeHint: "Dieser einmalige Code stammt vom Desktop-Starter und läuft nach zehn Minuten ab.", connected: "Emma ist verbunden, aktiv und hört zu. Sie können diese Seite schließen.", retry: "Erneut versuchen", connecting: "Emma wird verbunden…", temporary: "Sie verwenden ein vorläufiges Passwort. Ändern Sie es, bevor Sie fortfahren.", changePassword: "Passwort ändern", passwordHint: "Verwenden Sie mindestens 12 Zeichen mit Groß- und Kleinbuchstaben sowie einer Zahl.", currentPassword: "Aktuelles Passwort", newPassword: "Neues Passwort", confirmPassword: "Neues Passwort bestätigen", mismatch: "Die Bestätigung des neuen Passworts stimmt nicht überein.", currentInvalid: "Das aktuelle Passwort ist falsch.", unchanged: "Das neue Passwort muss sich vom aktuellen unterscheiden.", changeError: "Das Passwort konnte nicht geändert werden.", changing: "Wird geändert…", change: "Passwort ändern", voice: "Sprachsteuerung", voiceHelp: "Die Windows-App hört lokal auf das Aktivierungswort, solange sie läuft. Sagen Sie Emma und sprechen Sie dann natürlich. Der private Monitor öffnet sich automatisch; Erkennung vor der Aktivierung wird weder gesendet noch gespeichert.", wakeWord: "Aktivierungswort", language: "Sprache von Emma und der gesamten Secretary-Oberfläche", languageHint: "Diese Einstellung ändert Emmas gesprochene Sprache und die gesamte Secretary-Oberfläche gemeinsam. Emma übernimmt sie nach ihrer aktuellen Antwort.", continuous: "Steuerung des Aktivierungsworts einschalten", saved: "Sprach- und Oberflächensprache gespeichert. Secretary wird sofort aktualisiert; Emma nach ihrer aktuellen Antwort.", saveError: "Die Spracheinstellungen konnten nicht gespeichert werden.", saving: "Wird gespeichert…", save: "Spracheinstellungen speichern", pairError: "Die Windows-App konnte nicht verbunden werden.", approveError: "Die Windows-App konnte nicht bestätigt werden." },
  "es-ES": { title: "Cuenta", signedIn: "Sesión iniciada como", connect: "Conectar Emma para Windows", connectDescription: "La aplicación de Windows iniciada en este PC se está conectando a su cuenta activa de VCUBF.", codeHint: "Este código de un solo uso procede del iniciador y caduca en diez minutos.", connected: "Emma está conectada, activa y escuchando. Puede cerrar esta página.", retry: "Intentar de nuevo", connecting: "Conectando a Emma…", temporary: "Está usando una contraseña temporal. Cámbiela antes de continuar.", changePassword: "Cambiar contraseña", passwordHint: "Use al menos 12 caracteres con mayúscula, minúscula y número.", currentPassword: "Contraseña actual", newPassword: "Nueva contraseña", confirmPassword: "Confirmar nueva contraseña", mismatch: "La confirmación de la nueva contraseña no coincide.", currentInvalid: "La contraseña actual es incorrecta.", unchanged: "La nueva contraseña debe ser distinta de la actual.", changeError: "No se pudo cambiar la contraseña.", changing: "Cambiando…", change: "Cambiar contraseña", voice: "Control por voz", voiceHelp: "La aplicación de Windows escucha localmente la palabra de activación mientras está en ejecución. Diga Emma y después hable con naturalidad. El monitor privado se abre automáticamente; el reconocimiento previo no se envía ni se guarda.", wakeWord: "Palabra de activación", language: "Idioma de Emma y de toda la interfaz de Secretary", languageHint: "Este ajuste cambia conjuntamente el idioma hablado de Emma y toda la interfaz de Secretary. Emma lo aplica después de su respuesta actual.", continuous: "Activar controles de escucha de la palabra de activación", saved: "Idioma de voz e interfaz guardado. Secretary se actualiza inmediatamente; Emma después de su respuesta actual.", saveError: "No se pudieron guardar las preferencias de voz.", saving: "Guardando…", save: "Guardar preferencias de voz", pairError: "No se pudo conectar la aplicación de Windows.", approveError: "No se pudo aprobar la aplicación de Windows." },
  "it-IT": { title: "Account", signedIn: "Accesso effettuato come", connect: "Collega Emma per Windows", connectDescription: "L’app Windows avviata su questo PC si sta collegando al suo account VCUBF attivo.", codeHint: "Questo codice monouso proviene dal programma di avvio e scade dopo dieci minuti.", connected: "Emma è collegata, attiva e in ascolto. Può chiudere questa pagina.", retry: "Riprova", connecting: "Collegamento di Emma…", temporary: "Sta usando una password temporanea. La cambi prima di continuare.", changePassword: "Cambia password", passwordHint: "Usi almeno 12 caratteri con maiuscola, minuscola e numero.", currentPassword: "Password attuale", newPassword: "Nuova password", confirmPassword: "Conferma nuova password", mismatch: "La conferma della nuova password non corrisponde.", currentInvalid: "La password attuale non è corretta.", unchanged: "La nuova password deve essere diversa da quella attuale.", changeError: "Impossibile cambiare la password.", changing: "Modifica…", change: "Cambia password", voice: "Controllo vocale", voiceHelp: "L’app Windows ascolta localmente la parola di attivazione mentre è in esecuzione. Dica Emma e poi parli naturalmente. Il monitor privato si apre automaticamente; il riconoscimento precedente all’attivazione non viene inviato né salvato.", wakeWord: "Parola di attivazione", language: "Lingua di Emma e dell’intera interfaccia Secretary", languageHint: "Questa impostazione cambia insieme la lingua parlata di Emma e l’intera interfaccia Secretary. Emma la applica dopo la risposta in corso.", continuous: "Attiva i controlli di ascolto della parola di attivazione", saved: "Lingua della voce e dell’interfaccia salvata. Secretary si aggiorna subito; Emma dopo la risposta in corso.", saveError: "Impossibile salvare le preferenze vocali.", saving: "Salvataggio…", save: "Salva preferenze vocali", pairError: "Impossibile collegare l’app Windows.", approveError: "Impossibile approvare l’app Windows." },
};

export function Account() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [wakeWord, setWakeWord] = useState(user?.voiceWakeWord ?? "Emma");
  const [continuous, setContinuous] = useState(user?.voiceContinuous ?? false);
  const [voiceLanguage, setVoiceLanguage] = useState<AppLanguage>(appLanguage(user?.voiceLanguage));
  const copy = ACCOUNT_COPY[appLanguage(user?.voiceLanguage)];
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [savingVoice, setSavingVoice] = useState(false);
  const pairingCode = (searchParams.get("pair") ?? "").toUpperCase();
  const [pairingState, setPairingState] = useState<"idle"|"approving"|"approved"|"error">(pairingCode ? "idle" : "idle");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const pairingAttempted = useRef(false);

  useEffect(() => {
    if (!pairingCode || pairingAttempted.current) return;
    pairingAttempted.current = true;
    setPairingState("approving");
    setPairingError(null);
    api.approveDevicePairing(pairingCode)
      .then(() => setPairingState("approved"))
      .catch((caught) => {
        setPairingState("error");
        setPairingError(caught instanceof ApiError ? caught.message : copy.pairError);
      });
  }, [copy.pairError, pairingCode]);

  useEffect(() => {
    setVoiceLanguage(appLanguage(user?.voiceLanguage));
  }, [user?.voiceLanguage]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (newPassword !== confirmation) { setError(copy.mismatch); return; }
    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      logout();
      navigate("/login", { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "CURRENT_PASSWORD_INVALID") setError(copy.currentInvalid);
      else if (caught instanceof ApiError && caught.code === "PASSWORD_UNCHANGED") setError(copy.unchanged);
      else setError(caught instanceof ApiError ? caught.message : copy.changeError);
    } finally { setSubmitting(false); }
  }

  async function saveVoice(event: React.FormEvent) {
    event.preventDefault(); setVoiceMessage(null); setVoiceError(null); setSavingVoice(true);
    try {
      const preferences = await api.updateVoicePreferences(wakeWord, continuous, voiceLanguage);
      updateUser(preferences); setWakeWord(preferences.voiceWakeWord);
      setVoiceMessage(copy.saved);
    } catch (caught) {
      setVoiceError(caught instanceof ApiError ? caught.message : copy.saveError);
    } finally { setSavingVoice(false); }
  }

  async function approvePairing() {
    setPairingState("approving");setPairingError(null);
    try { await api.approveDevicePairing(pairingCode);setPairingState("approved"); }
    catch(caught){setPairingState("error");setPairingError(caught instanceof ApiError?caught.message:copy.approveError);}
  }

  return <div>
    <h1>{copy.title}</h1>
    <p>{copy.signedIn} <strong>{user?.displayName}</strong> ({user?.email}).</p>
    {pairingCode && <section className="pairing-card">
      <h2>{copy.connect}</h2>
      <p>{copy.connectDescription}</p>
      <div className="pairing-code">{pairingCode}</div>
      <p className="hint">{copy.codeHint}</p>
      {pairingError && <div className="error-banner">{pairingError}</div>}
      {pairingState==="approved" ? <div className="success-banner">{copy.connected}</div> : pairingState==="error" ? <button type="button" onClick={approvePairing}>{copy.retry}</button> : <div className="hint">{copy.connecting}</div>}
    </section>}
    {user?.mustChangePassword && <div className="warning-banner">{copy.temporary}</div>}
    <form className="inline-form" onSubmit={submit} style={{ display: "grid", maxWidth: 520 }}>
      <h2>{copy.changePassword}</h2>
      <p className="hint">{copy.passwordHint}</p>
      <label>{copy.currentPassword}<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
      <label>{copy.newPassword}<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
      <label>{copy.confirmPassword}<input type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      <button type="submit" disabled={submitting}>{submitting ? copy.changing : copy.change}</button>
    </form>
    <form className="inline-form voice-settings" onSubmit={saveVoice} style={{ display: "grid", maxWidth: 520 }}>
      <h2>{copy.voice}</h2>
      <p className="hint">{copy.voiceHelp}</p>
      <label>{copy.wakeWord}<input value={wakeWord} minLength={2} maxLength={30} onChange={(event) => setWakeWord(event.target.value)} required /></label>
      <label>{copy.language}<select value={voiceLanguage} onChange={(event) => setVoiceLanguage(event.target.value as AppLanguage)}>{APP_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{languageLabel(language.code, true)}</option>)}</select></label>
      <p className="hint">{copy.languageHint}</p>
      <label className="checkbox-label"><input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} /> {copy.continuous}</label>
      {voiceError && <div className="error-banner">{voiceError}</div>}
      {voiceMessage && <div className="success-banner">{voiceMessage}</div>}
      <button type="submit" disabled={savingVoice}>{savingVoice ? copy.saving : copy.save}</button>
    </form>
  </div>;
}
