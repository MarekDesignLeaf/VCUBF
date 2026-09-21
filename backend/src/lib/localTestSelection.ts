import fs from "node:fs";
import path from "node:path";

/**
 * Which account the passwordless local screen has chosen on this machine.
 *
 * The choice used to live in a module variable, so it lasted exactly as long as
 * the backend process. Every restart — a crash, a code change, a migration —
 * left the browser holding a token for an account the server no longer admitted
 * to having chosen, and the Windows companion repeating
 * LOCAL_TEST_SESSION_REQUIRED once a second until somebody clicked a tile.
 *
 * The choice describes this computer, not the business, so it is kept in a file
 * beside the backend rather than in the tenant database. Nothing here is
 * authoritative business state: at worst the file is lost and one tile has to be
 * clicked again, which is why every failure below is swallowed rather than
 * raised. The file is read on each request instead of being cached, so a second
 * process — the companion asking while the browser chooses — sees the choice as
 * soon as it is made.
 */
function selectionFile() {
  return path.resolve(process.env.VCUBF_LOCAL_TEST_STATE ?? "data/local-test-user.json");
}

export function readLocalTestSelection(): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(selectionFile(), "utf8"));
    const userId = (parsed as { userId?: unknown })?.userId;
    return typeof userId === "string" && userId.length > 0 ? userId : null;
  } catch {
    // No choice has been made on this machine yet, or the note is unreadable.
    return null;
  }
}

export function writeLocalTestSelection(userId: string | null) {
  try {
    const file = selectionFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (userId) fs.writeFileSync(file, `${JSON.stringify({ userId }, null, 2)}\n`);
    else fs.rmSync(file, { force: true });
  } catch {
    // Losing the note costs one tile click; it must never fail a sign-in.
  }
}
