import { useEffect } from "react";

const BUILD_CHECK_INTERVAL_MS = 60_000;

function deployedAssetPath(html: string) {
  const page = new DOMParser().parseFromString(html, "text/html");
  const script = page.querySelector<HTMLScriptElement>('script[type="module"][src]');
  const source = script?.getAttribute("src");
  return source ? new URL(source, window.location.origin).pathname : null;
}

function loadedAssetPath() {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  const source = script?.getAttribute("src");
  return source ? new URL(source, window.location.origin).pathname : null;
}

/**
 * Railway serves the Vite index through an edge cache. A Secretary tab may
 * therefore remain on an older JavaScript bundle after a successful deploy.
 * Compare the loaded bundle with a cache-busted index and replace the current
 * URL once when a newer bundle exists. This keeps Emma's browser action bridge
 * on the same release as the backend without interrupting normal navigation.
 */
export function BuildRefresh() {
  useEffect(() => {
    let active = true;
    let checking = false;

    const check = async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const response = await fetch(`/index.html?vcubf_build_check=${Date.now()}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!response.ok || !active) return;
        const latest = deployedAssetPath(await response.text());
        const loaded = loadedAssetPath();
        if (!latest || !loaded || latest === loaded) return;

        const url = new URL(window.location.href);
        url.searchParams.set("vcubf_reload", Date.now().toString());
        window.location.replace(url.toString());
      } catch {
        // A temporary network failure must not disturb the active workspace.
      } finally {
        checking = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void check();
    };
    const timer = window.setInterval(() => void check(), BUILD_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void check();

    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
