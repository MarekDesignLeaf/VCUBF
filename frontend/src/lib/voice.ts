export function extractWakeCommand(transcript: string, wakeWord: string) {
  const spoken = transcript.trim();
  const lower = spoken.toLocaleLowerCase();
  const wake = wakeWord.trim().toLocaleLowerCase();
  const index = lower.indexOf(wake);
  if (index < 0) return null;
  const before = lower[index - 1];
  const after = lower[index + wake.length];
  if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) return null;
  return spoken.slice(index + wake.length).replace(/^[\s,.:;!-]+/, "").trim();
}
