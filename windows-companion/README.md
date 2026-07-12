# VCUBF Emma for Windows 11

Native Windows tray companion for VCUBF. It uses the locally installed Windows Speech Recognizer, listens for the configured wake word (`Emma` by default), pauses for an editable review dialog, and sends only the approved transcript to the existing audited `/command/text` endpoint.

## Install

Open Windows PowerShell in this directory and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -StartNow
```

The companion opens the normal VCUBF login in your default browser, so browser password autofill works. After login, approve the matching eight-character code on the Account page. The browser hands back a short-lived one-time token; no password is entered into or saved by the companion. The resulting API token is encrypted with Windows DPAPI for the current Windows user. Right-click the tray icon to pause/resume listening, change the wake word, reconnect in the browser, open VCUBF or exit.

## Voice flow

1. Say `Emma` followed by a supported English command, or say `Emma`, wait for `Yes?`, then speak within eight seconds.
2. Review or correct the transcript in the native dialog.
3. Select **Run**. Cancellation sends nothing.
4. Emma shows and speaks the deterministic backend result.

The recognizer is local and continues while browsers are minimized or closed, but Windows must be running and the user must be signed in. Microphone privacy settings must allow desktop applications. The current command parser supports English command forms.

## Diagnostics

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\VCUBF-Emma.ps1 -Diagnostic
```

## Uninstall

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall.ps1
```
