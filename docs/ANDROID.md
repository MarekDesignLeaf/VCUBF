# VCUBF Secretary for Android

The Android application is the same Secretary workspace connected to the production API. It uses the phone's native speech recognition and text to speech for Emma; it does not use the Windows companion, pairing code or any Windows-only microphone process.

## What works on the phone

- Sign in with the same Secretary account and work with the same CRM data, permissions, connectors, confirmations and audit trail.
- Use all responsive Secretary pages, forms, lists, documents, quotes, invoices and connector workflows.
- Enable Emma once to approve Android microphone permission. On subsequent sign-ins on that phone, Emma resumes listening automatically.
- Say the configured wake word (default: `Emma`) followed by an instruction. The recognised text is sent through the same Assistant and command API as desktop Emma. Emma speaks her response through Android text-to-speech and stores the visible text transcript locally on the phone. Audio is never stored.
- Change language and wake word in Secretary Account; the next listening turn uses the saved preference.

Android restricts continuous microphone access to the foreground app. Emma therefore listens while VCUBF Secretary is open and visible. Pausing Emma or leaving the app stops microphone use. A system-wide always-on hotword service would require a separate Android foreground-service permission and battery policy review; it is intentionally not claimed by this build.

## Build a debug APK

On this Windows development PC Android Studio and the SDK are already available. Build from `frontend`:

```powershell
npm run android:apk
```

The result is `frontend/android/app/build/outputs/apk/debug/app-debug.apk`. It is a debug build for direct testing, not a Play Store signed release.

## Test on a phone

1. Copy the APK to the Android phone and allow the file manager/browser to install apps from that source.
2. Install the APK, open **VCUBF Secretary**, and sign in.
3. Choose **Enable Emma** once and grant microphone access.
4. Say `Emma`, wait for her acknowledgement, then say the command. The screen shows exactly what she heard and what she answered.
5. Use **Pause Emma** before handing the phone to somebody else. **Delete phone transcript** removes saved local text turns; it does not delete company records or persistent Emma memories.

## Release signing

Before distribution through Google Play, create a dedicated release keystore, set the release signing configuration outside Git, build an Android App Bundle (`bundleRelease`) and complete Play Console privacy declarations for microphone and speech recognition. Never commit a keystore or its passwords.
