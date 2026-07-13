import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/useAuth";

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
  const [voiceLanguage, setVoiceLanguage] = useState<"en-GB" | "en-US">(user?.voiceLanguage ?? "en-GB");
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
        setPairingError(caught instanceof ApiError ? caught.message : "Could not connect the Windows companion.");
      });
  }, [pairingCode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (newPassword !== confirmation) { setError("New password confirmation does not match."); return; }
    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      logout();
      navigate("/login", { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "CURRENT_PASSWORD_INVALID") setError("Current password is incorrect.");
      else if (caught instanceof ApiError && caught.code === "PASSWORD_UNCHANGED") setError("The new password must differ from the current password.");
      else setError(caught instanceof ApiError ? caught.message : "Could not change password.");
    } finally { setSubmitting(false); }
  }

  async function saveVoice(event: React.FormEvent) {
    event.preventDefault(); setVoiceMessage(null); setVoiceError(null); setSavingVoice(true);
    try {
      const preferences = await api.updateVoicePreferences(wakeWord, continuous, voiceLanguage);
      updateUser(preferences); setWakeWord(preferences.voiceWakeWord);
      setVoiceMessage("Voice preferences saved. The new wake word is active immediately.");
    } catch (caught) {
      setVoiceError(caught instanceof ApiError ? caught.message : "Could not save voice preferences.");
    } finally { setSavingVoice(false); }
  }

  async function approvePairing() {
    setPairingState("approving");setPairingError(null);
    try { await api.approveDevicePairing(pairingCode);setPairingState("approved"); }
    catch(caught){setPairingState("error");setPairingError(caught instanceof ApiError?caught.message:"Could not approve the Windows companion.");}
  }

  return <div>
    <h1>Account</h1>
    <p>Signed in as <strong>{user?.displayName}</strong> ({user?.email}).</p>
    {pairingCode && <section className="pairing-card">
      <h2>Connect Windows Emma</h2>
      <p>The Windows companion launched from this PC is being connected to your signed-in VCUBF account.</p>
      <div className="pairing-code">{pairingCode}</div>
      <p className="hint">This one-time code came from the desktop launcher and expires after ten minutes.</p>
      {pairingError && <div className="error-banner">{pairingError}</div>}
      {pairingState==="approved" ? <div className="success-banner">Emma is connected, active and listening. You may close this page.</div> : pairingState==="error" ? <button type="button" onClick={approvePairing}>Try again</button> : <div className="hint">Connecting Emma…</div>}
    </section>}
    {user?.mustChangePassword && <div className="warning-banner">You are using a temporary password. Change it before continuing to Secretary.</div>}
    <form className="inline-form" onSubmit={submit} style={{ display: "grid", maxWidth: 520 }}>
      <h2>Change password</h2>
      <p className="hint">Use at least 12 characters with uppercase, lowercase and a number.</p>
      <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
      <label>New password<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      <button type="submit" disabled={submitting}>{submitting ? "Changing…" : "Change password"}</button>
    </form>
    <form className="inline-form voice-settings" onSubmit={saveVoice} style={{ display: "grid", maxWidth: 520 }}>
      <h2>Voice control</h2>
      <p className="hint">The Windows companion listens locally for the wake word whenever it is running. Say Emma alone to start Realtime listening, then speak naturally. The <strong>What Emma hears</strong> monitor opens automatically and can be reopened from the tray with <strong>Show live hearing</strong>; its pre-wake recognition is not uploaded or saved.</p>
      <label>Wake word<input value={wakeWord} minLength={2} maxLength={30} onChange={(event) => setWakeWord(event.target.value)} required /></label>
      <label>Recognition language<select value={voiceLanguage} onChange={(event) => setVoiceLanguage(event.target.value as "en-GB" | "en-US")}><option value="en-GB">English (United Kingdom)</option><option value="en-US">English (United States)</option></select></label>
      <label className="checkbox-label"><input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} /> Enable wake-word listening controls</label>
      {voiceError && <div className="error-banner">{voiceError}</div>}
      {voiceMessage && <div className="success-banner">{voiceMessage}</div>}
      <button type="submit" disabled={savingVoice}>{savingVoice ? "Saving…" : "Save voice preferences"}</button>
    </form>
  </div>;
}
