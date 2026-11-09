"""Import the PC Control Plus relay's own tools into the Secretary backend.

PC Control Plus (MarekDesignLeaf/pc-control-plus) serves ChatGPT with its
relay tools (files, desktop input, web_*, ui_*, goals, camera, permissions)
next to the shared engine tools. Secretary offers the owner's PC through the
same relay, so it takes those tools' names, descriptions, parameters and
relay job ids from the relay itself, never from a hand-written list. Which of
them Secretary offers, and with which trust boundary, is Secretary's own
decision (backend/src/modules/mcp/pcRelayPolicy.ts); a backend test fails when
a relay tool has no decision or a decision names no relay tool.

The engine tools are not imported here: they come from pc_engine.TOOLS
(export_catalogue.py). Relay-local tools that never reach the PC
(pc_status, pc_capabilities) are left out; pc_browser_connection_status is
already Secretary's pc_connection_status.

Provenance. pc-control-plus is private, so VCUBF keeps a minimal snapshot of
exactly the pinned signed release (windows-companion/pc-control/pcp-upstream/):
the nine files the import reads (relay.py and what it imports, the control-loop
modules, requirements.txt, the signed release manifest) and three git objects
(the commit, its root tree and the remote/ tree), nothing else and no history.
The pin (windows-companion/pc-control/pcp-upstream.json) names the commit, its
tree, the release id and the release public key, pinned here and never taken
from upstream. --check, with no credentials and no network, proves:

- the commit object hashes to the pinned commit and names the pinned tree;
- the root tree hashes to that tree, its remote/ entry to the remote tree, and
  every vendored file to its blob in that tree (relay.py included, which the
  release manifest does not sign), and nothing else is in the snapshot;
- the release manifest (a blob of that tree) carries a valid Ed25519
  signature by the pinned key for the pinned release id, and every vendored
  file the manifest names has its signed SHA-256;
- the control-loop modules attested screenshot-free are those signed files;
- the committed catalogue records this release and snapshot, and is exactly
  what the relay in the snapshot produces now.

--refresh rewrites the snapshot, the pin and the catalogue together from an
authenticated local pc-control-plus checkout (its HEAD, read from git objects,
not the working tree), and only after the new snapshot passes every check.

Usage:
  python import_pcp_catalogue.py --check
  python import_pcp_catalogue.py --refresh --pcp ../../../../pc-control-plus [--public-key-b64 KEY]
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
TARGET = PLUGIN.parents[1] / "backend" / "src" / "modules" / "mcp" / "pcpRelayCatalogue.generated.ts"
PIN = PLUGIN / "pcp-upstream.json"
SNAPSHOT = PLUGIN / "pcp-upstream"
# Exactly what the import reads: the relay and what it imports, the control-loop
# modules, the relay's requirements and the signed release manifest.
SNAPSHOT_FILES = ("relay.py", "oauth.py", "pc_engine.py", "requirements.txt", "release-manifest.json",
                  "web_goal.py", "browser_dom.py", "desktop_goal.py", "windows_uia.py")
GIT_OBJECTS = {"commit": "commit", "tree-root": "tree", "tree-remote": "tree"}


class ProvenanceError(Exception):
    """The snapshot, the pin or the catalogue is not the pinned signed release."""
RELAY_LOCAL = {"pc_status", "pc_capabilities", "pc_browser_connection_status"}

# The relay jobs that run a control loop on the PC (an AI deciding step after
# step), and the agent modules that loop runs in. Secretary offers such a job
# only when its whole loop works from text state (DOM, UI Automation) and
# never from screenshots: the check below reads those modules' source.
CONTROL_LOOPS = {
    "web_goal": {"jobs": ["web_goal_start", "web_goal_status", "web_goal_cancel"], "state": "dom",
                 "modules": ["web_goal.py", "browser_dom.py"]},
    "ui_goal": {"jobs": ["ui_goal_start", "ui_goal_status", "ui_goal_cancel"], "state": "uia",
                "modules": ["desktop_goal.py", "windows_uia.py"]},
}
# Anything that captures or sends pixels: a screenshot API, an image library,
# an image input to a model, or a camera.
PIXEL_PATTERNS = re.compile(
    r"\.screenshot\s*\(|ImageGrab|\bmss\b|pyautogui|\bPIL\b|from\s+PIL|input_image|image_url|\bcv2\b|VideoCapture|"
    r"capture_screen|grab_screen|\bBitBlt\b|PrintWindow"
)


def control_loops(remote: Path) -> dict:
    loops = {}
    for name, loop in CONTROL_LOOPS.items():
        modules = {}
        evidence = []
        for module in loop["modules"]:
            data = (remote / module).read_bytes()
            modules[module] = hashlib.sha256(data).hexdigest()
            text = data.decode("utf-8")
            for number, line in enumerate(text.splitlines(), 1):
                code = line.split("#", 1)[0]
                if PIXEL_PATTERNS.search(code):
                    evidence.append(f"{module}:{number}: {line.strip()[:120]}")
        loops[name] = {"jobs": loop["jobs"], "state": loop["state"], "modules": modules,
                       "screenshot_free": not evidence, "evidence": evidence}
    return loops


def load_relay(pcp: Path):
    remote = pcp / "remote"
    # The relay imports its siblings by name: never reuse ones loaded from another folder.
    for name in ("oauth", "pc_engine"):
        sys.modules.pop(name, None)
    # Nothing is written into the snapshot (no __pycache__).
    dont_write, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    sys.path.insert(0, str(remote))
    scratch = tempfile.TemporaryDirectory()
    settings = {
        # Placeholders only: the relay refuses to start without them. Nothing is served.
        "PCP_CLIENT_TOKEN": "c-import-placeholder" * 3, "PCP_AGENT_TOKEN": "a-import-placeholder" * 3, "PCP_LOGIN_PASSWORD": "import-only",
        "PCP_OAUTH_DB": str(Path(scratch.name) / "oauth.sqlite3"),
    }
    saved = {key: os.environ.get(key) for key in settings}
    os.environ.update(settings)
    try:
        spec = importlib.util.spec_from_file_location("pcp_relay_import", remote / "relay.py")
        relay = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(relay)
        tools = asyncio.run(relay.mcp.list_tools())
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        sys.path.remove(str(remote))
        sys.dont_write_bytecode = dont_write
    relay.oauth_provider.close()
    scratch.cleanup()
    return relay, tools


def relay_job_ids(source: str) -> dict[str, str]:
    """pc_<name> -> the job tool its body sends with remote_call('<job>', ...)."""
    ids: dict[str, str] = {}
    blocks = re.split(r"\n(?=@mcp\.tool)", source)
    for block in blocks:
        name = re.search(r"async def (pc_\w+)\(", block)
        job = re.search(r"remote_call\('([a-z_]+)'", block)
        if name and job:
            ids[name.group(1)] = job.group(1)
    return ids


def canonical(data) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def git_sha(kind: str, data: bytes) -> str:
    return hashlib.sha1(f"{kind} {len(data)}".encode() + b"\0" + data).hexdigest()


def tree_entries(data: bytes) -> dict[str, tuple[str, str]]:
    """A git tree object: name -> (mode, object id)."""
    entries, at = {}, 0
    while at < len(data):
        space = data.index(b" ", at)
        nul = data.index(b"\0", space)
        mode, name = data[at:space].decode(), data[space + 1:nul].decode("utf-8")
        entries[name] = (mode, data[nul + 1:nul + 21].hex())
        at = nul + 21
    return entries


def read_objects(snapshot: Path) -> dict[str, bytes]:
    folder = snapshot / "git"
    present = sorted(path.name for path in folder.iterdir()) if folder.is_dir() else []
    if present != sorted(f"{name}.b64" for name in GIT_OBJECTS):
        raise ProvenanceError(f"the snapshot's git objects are {present}, expected {sorted(GIT_OBJECTS)}")
    return {name: base64.b64decode((folder / f"{name}.b64").read_text(encoding="ascii").strip(), validate=True) for name in GIT_OBJECTS}


def verify_signature(manifest: dict, public_key_b64: str) -> None:
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        raise ProvenanceError("verifying the release needs the cryptography package (remote/requirements.txt installs it)")
    signature = base64.b64decode(manifest["signature_ed25519"], validate=True)
    payload = {key: value for key, value in manifest.items() if key != "signature_ed25519"}
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64, validate=True)).verify(signature, canonical(payload))
    except InvalidSignature:
        raise ProvenanceError("the release manifest's signature does not verify with the pinned public key")


def verify_snapshot(snapshot: Path, pin: dict) -> dict:
    """The pinned signed release the snapshot is, proved from its git objects and signature."""
    objects = read_objects(snapshot)
    if git_sha("commit", objects["commit"]) != pin["commit"]:
        raise ProvenanceError(f"the snapshot's commit object is {git_sha('commit', objects['commit'])}, the pin is {pin['commit']}")
    headers = objects["commit"].split(b"\n\n", 1)[0].decode("utf-8").splitlines()
    tree = next((line.split(" ", 1)[1] for line in headers if line.startswith("tree ")), None)
    if tree != pin["tree"] or git_sha("tree", objects["tree-root"]) != tree:
        raise ProvenanceError(f"the commit names tree {tree}; the pin is {pin['tree']} and the root tree hashes to {git_sha('tree', objects['tree-root'])}")
    remote = tree_entries(objects["tree-root"]).get("remote")
    if not remote or remote[0] != "40000" or remote[1] != git_sha("tree", objects["tree-remote"]):
        raise ProvenanceError("the root tree's remote/ entry is not the snapshot's remote tree")
    blobs = tree_entries(objects["tree-remote"])
    folder = snapshot / "remote"
    # __pycache__ is never committed (.gitignore); anything else not vendored is refused.
    present = sorted(path.name for path in folder.iterdir() if path.name != "__pycache__") if folder.is_dir() else []
    if present != sorted(SNAPSHOT_FILES):
        raise ProvenanceError(f"the snapshot holds {present}, expected exactly {sorted(SNAPSHOT_FILES)}")
    extra = sorted(path.name for path in snapshot.iterdir() if path.name not in ("remote", "git"))
    if extra:
        raise ProvenanceError(f"the snapshot holds files outside remote/ and git/: {extra}")
    for name in SNAPSHOT_FILES:
        data = (folder / name).read_bytes()
        entry = blobs.get(name)
        if not entry or entry[1] != git_sha("blob", data):
            raise ProvenanceError(f"remote/{name} is not the blob of the pinned commit ({git_sha('blob', data)} != {entry[1] if entry else 'missing'})")
    manifest_bytes = (folder / "release-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("schema") != "pcp.release.v2" or manifest.get("release_id") != pin["release_id"]:
        raise ProvenanceError(f"the manifest is release {manifest.get('release_id')}, the pin is {pin['release_id']}")
    verify_signature(manifest, pin["release_public_key_b64"])
    for name, digest in manifest["files"].items():
        if name in SNAPSHOT_FILES and hashlib.sha256((folder / name).read_bytes()).hexdigest() != digest:
            raise ProvenanceError(f"remote/{name} is not the signed file")
    snapshot_digest = hashlib.sha256(canonical({
        "objects": {name: git_sha(kind, objects[name]) for name, kind in GIT_OBJECTS.items()},
        "files": {name: blobs[name][1] for name in SNAPSHOT_FILES},
    })).hexdigest()
    return {
        "repository": pin["repository"], "ref": pin["ref"], "commit": pin["commit"], "tree": pin["tree"],
        "release_id": manifest["release_id"], "release_sequence": manifest["release_sequence"],
        "release_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "signed_files": manifest["files"],
        "snapshot_sha256": snapshot_digest,
    }


def catalogue(snapshot: Path, release: dict) -> dict:
    relay, tools = load_relay(snapshot)
    source = (snapshot / "remote" / "relay.py").read_text(encoding="utf-8")
    jobs = relay_job_ids(source)
    engine_names = {"pc_" + name for name in relay.pc_engine.TOOLS if name not in relay.ENGINE_EQUIVALENTS}
    entries = []
    for tool in sorted(tools, key=lambda item: item.name):
        if tool.name in RELAY_LOCAL or tool.name in engine_names:
            continue
        job = jobs.get(tool.name)
        if job is None or job not in relay.ALLOWED:
            raise ProvenanceError(f"{tool.name}: no relay job in relay.ALLOWED found in its body")
        annotations = tool.annotations.model_dump(exclude_none=True) if tool.annotations else {}
        entries.append({
            "name": tool.name,
            "relay_tool": job,
            "description": (tool.description or "").strip(),
            "input_schema": tool.inputSchema,
            "annotations": annotations,
        })
    unlisted = sorted(job for job in relay.ALLOWED if not job.startswith("engine_") and job != "browser_connection_status"
                      and job not in {entry["relay_tool"] for entry in entries})
    loops = control_loops(snapshot / "remote")
    for name, loop in loops.items():
        for module, digest in loop["modules"].items():
            if release["signed_files"].get(module) != digest:
                raise ProvenanceError(f"{name}: {module} is not a file of the signed release")
    return {
        "source": "MarekDesignLeaf/pc-control-plus remote/relay.py",
        # The signed release and the vendored snapshot this was imported from.
        "upstream": release,
        "relay_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "engine_version": relay.pc_engine.ENGINE_VERSION,
        "tools": entries,
        # Jobs the relay accepts that no relay MCP tool sends (kept visible, never offered).
        "allowed_without_tool": unlisted,
        # Whether each control loop works from text state only (read from its source).
        "control_loops": loops,
    }


def render(snapshot: Path, release: dict) -> str:
    body = json.dumps(catalogue(snapshot, release), indent=2, ensure_ascii=False, sort_keys=True)
    return (
        "// GENERATED by windows-companion/pc-control/server/import_pcp_catalogue.py from the PC Control Plus relay\n"
        "// in the vendored snapshot of the pinned signed release (pcp-upstream/, pcp-upstream.json).\n"
        "// Do not edit: run import_pcp_catalogue.py --refresh. Secretary's trust decisions are in pcRelayPolicy.ts.\n"
        "/* eslint-disable */\n"
        "export const PCP_RELAY_CATALOGUE = " + body + " as const;\n"
    )


def recorded_upstream(text: str) -> dict | None:
    """The release the committed catalogue says it was imported from."""
    try:
        return json.loads(text[text.index("= ") + 2:text.rindex(" as const")]).get("upstream")
    except (ValueError, AttributeError):
        return None


def check(pin_path: Path = PIN, snapshot: Path = SNAPSHOT, target: Path = TARGET, regenerate: bool = True) -> dict:
    """Every proof listed in the module docstring; raises ProvenanceError on the first that fails."""
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    release = verify_snapshot(snapshot, pin)
    current = target.read_text(encoding="utf-8") if target.exists() else ""
    recorded = recorded_upstream(current)
    if recorded != release:
        raise ProvenanceError("the committed catalogue was not imported from this snapshot and pin (stale): run import_pcp_catalogue.py --refresh")
    if regenerate and current != render(snapshot, release):
        raise ProvenanceError("the committed catalogue is not what the relay in the snapshot produces (stale): run import_pcp_catalogue.py --refresh")
    return release


def git(checkout: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(checkout), *args], capture_output=True, check=True).stdout


def refresh(checkout: Path, pin_path: Path = PIN, snapshot: Path = SNAPSHOT, target: Path = TARGET, public_key_b64: str | None = None) -> dict:
    """Snapshot, pin and catalogue from the checkout's HEAD, written only after every check passed."""
    old = json.loads(pin_path.read_text(encoding="utf-8")) if pin_path.exists() else {}
    commit = git(checkout, "rev-parse", "HEAD").decode().strip()
    tree = git(checkout, "rev-parse", "HEAD^{tree}").decode().strip()
    manifest = json.loads(git(checkout, "show", "HEAD:remote/release-manifest.json"))
    pin = {
        "comment": "The signed PC Control Plus release Secretary's relay catalogue is imported from, vendored in pcp-upstream/. Change it only with import_pcp_catalogue.py --refresh, which rewrites the snapshot, this pin and the catalogue together; CI checks all three.",
        "repository": old.get("repository", "MarekDesignLeaf/pc-control-plus"), "ref": old.get("ref", "signed-release"),
        "commit": commit, "tree": tree, "release_id": manifest.get("release_id"),
        "release_public_key_b64": public_key_b64 or old.get("release_public_key_b64"),
    }
    if not pin["release_public_key_b64"]:
        raise ProvenanceError("no release public key: pass --public-key-b64 with the key pinned on the PC")
    with tempfile.TemporaryDirectory(dir=snapshot.parent) as staging_root:
        staged = Path(staging_root) / "pcp-upstream"
        (staged / "remote").mkdir(parents=True)
        (staged / "git").mkdir()
        for name in SNAPSHOT_FILES:
            (staged / "remote" / name).write_bytes(git(checkout, "show", f"HEAD:remote/{name}"))
        raw = {"commit": git(checkout, "cat-file", "commit", "HEAD"), "tree-root": git(checkout, "cat-file", "tree", "HEAD^{tree}"),
               "tree-remote": git(checkout, "cat-file", "tree", "HEAD:remote")}
        for name, data in raw.items():
            (staged / "git" / f"{name}.b64").write_text(base64.b64encode(data).decode("ascii") + "\n", encoding="ascii", newline="\n")
        release = verify_snapshot(staged, pin)
        text = render(staged, release)
        # Everything verified: replace the three together.
        pin_tmp = pin_path.with_suffix(".json.new")
        target_tmp = target.with_suffix(".ts.new")
        pin_tmp.write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8", newline="\n")
        target_tmp.write_text(text, encoding="utf-8", newline="\n")
        retired = Path(staging_root) / "previous"
        if snapshot.exists():
            os.replace(snapshot, retired)
        os.replace(staged, snapshot)
        os.replace(pin_tmp, pin_path)
        os.replace(target_tmp, target)
    return release


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="prove the snapshot, the pin and the catalogue (no network, no credentials)")
    mode.add_argument("--refresh", action="store_true", help="rewrite snapshot, pin and catalogue from --pcp's HEAD")
    parser.add_argument("--pcp", type=Path, help="an authenticated local pc-control-plus checkout at the signed release to pin")
    parser.add_argument("--public-key-b64", help="the release public key pinned on the PC (default: the current pin's)")
    options = parser.parse_args()
    try:
        if options.check:
            release = check()
            print(f"ok: relay catalogue = signed release {release['release_id']} at {release['commit']}")
            return 0
        if not options.pcp:
            parser.error("--refresh needs --pcp")
        release = refresh(options.pcp.resolve(), public_key_b64=options.public_key_b64)
        print(f"refreshed snapshot, pin and catalogue: signed release {release['release_id']} at {release['commit']}")
        return 0
    except ProvenanceError as error:
        print(f"relay catalogue provenance: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
