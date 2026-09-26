import { Capacitor } from "@capacitor/core";

export function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

/**
 * The Secretary window opened by the Windows desktop launcher.
 *
 * The launcher opens it with `?desktop=1` and runs Alfonzo on the PC, which
 * owns the microphone and the speaker. This window must then neither listen
 * nor speak, otherwise every sentence is heard, executed and answered twice.
 * The flag is read once, as the module loads, because the sign-in redirect
 * drops the query string; sessionStorage keeps it for this window only.
 */
const DESKTOP_COMPANION_KEY = "vcubf.desktopCompanionWindow";

const desktopCompanionWindow: boolean = (() => {
  const fromUrl = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("desktop") === "1";
  try {
    if (fromUrl) window.sessionStorage.setItem(DESKTOP_COMPANION_KEY, "1");
    return fromUrl || window.sessionStorage.getItem(DESKTOP_COMPANION_KEY) === "1";
  } catch {
    return fromUrl;
  }
})();

export function isDesktopCompanionWindow(): boolean {
  return desktopCompanionWindow;
}
