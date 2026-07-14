const fallbackFrontendUrl = "http://localhost:5173";

/**
 * FRONTEND_URL is also used as the explicit CORS allow-list. Select the first
 * valid HTTP(S) origin for links sent to a person rather than treating a
 * comma-separated allow-list as one malformed URL.
 */
export function frontendBaseUrl() {
  const candidates = (process.env.FRONTEND_URL ?? fallbackFrontendUrl)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return url;
    } catch {
      // Continue to the next configured allow-listed origin.
    }
  }
  return new URL(fallbackFrontendUrl);
}

export function frontendUrl(path: string) {
  return new URL(path, frontendBaseUrl());
}
