/**
 * Copy the browser voice-activity detector's runtime files into public/.
 *
 * BrowserVoiceControl loads the detector as plain <script> tags from the site
 * root rather than through the bundler, because the ONNX runtime fetches its
 * own WebAssembly at runtime and bundling that fails. The files are therefore
 * served from public/ — but they are byte-for-byte what npm already installs,
 * so they are copied here on install instead of being committed. Nothing is
 * fetched from the internet at runtime.
 *
 * Run automatically by the postinstall script, or by hand:
 *   node scripts/copy-vad-assets.mjs [destination]
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(process.argv[2] ?? path.join(here, "..", "public"));

/** Each file, and the package that owns it. */
const ASSETS = [
  { pkg: "@ricky0123/vad-web", file: "bundle.min.js" },
  { pkg: "@ricky0123/vad-web", file: "vad.worklet.bundle.min.js" },
  { pkg: "@ricky0123/vad-web", file: "silero_vad_v5.onnx" },
  { pkg: "onnxruntime-web", file: "ort.wasm.min.js" },
  { pkg: "onnxruntime-web", file: "ort-wasm-simd-threaded.mjs" },
  { pkg: "onnxruntime-web", file: "ort-wasm-simd-threaded.wasm" },
];

/**
 * Resolve a package's dist directory by walking node_modules upward.
 *
 * require.resolve is not usable here: onnxruntime-web restricts its subpath
 * exports, so asking it for package.json throws even though the files are
 * installed. Walking the tree also copes with npm hoisting the package.
 */
function distDir(pkg) {
  let dir = here;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...pkg.split("/"), "dist");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function digest(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

const missing = [...new Set(ASSETS.map((a) => a.pkg))].filter((pkg) => distDir(pkg) === null);
if (missing.length > 0) {
  // A production install without dev dependencies has no detector to copy.
  // That is not an error: the rest of the app does not depend on these files.
  console.log(`copy-vad-assets: skipped, not installed: ${missing.join(", ")}`);
  process.exit(0);
}

await mkdir(destination, { recursive: true });
let copied = 0;
let unchanged = 0;
for (const { pkg, file } of ASSETS) {
  const from = path.join(distDir(pkg), file);
  const to = path.join(destination, file);
  const [sourceHash, targetHash] = await Promise.all([digest(from), digest(to)]);
  if (sourceHash === null) {
    console.error(`copy-vad-assets: ${pkg} does not contain ${file}`);
    process.exit(1);
  }
  if (sourceHash === targetHash) {
    unchanged += 1;
    continue;
  }
  await copyFile(from, to);
  copied += 1;
}
console.log(`copy-vad-assets: ${copied} copied, ${unchanged} already current, into ${destination}`);
