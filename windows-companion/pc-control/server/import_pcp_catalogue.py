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

Needs a checkout of pc-control-plus and its relay packages
(remote/requirements.txt).

Provenance: the import is pinned to one signed PC Control Plus release
(windows-companion/pc-control/pcp-upstream.json: repository, commit of its
signed-release branch, release id and the release public key, pinned here and
not taken from the checkout). With --pin the checkout must be exactly that
commit, its release manifest must carry a valid Ed25519 signature by the
pinned key for the pinned release id, and every file the manifest names must
have the signed SHA-256; the control-loop modules attested screenshot-free
must be those signed files. The generated catalogue records the release, so
the pin and the catalogue can only change together (CI: relay-catalogue job).

Usage: python import_pcp_catalogue.py --pcp ../pc-control-plus --pin ../pcp-upstream.json            # rewrite
       python import_pcp_catalogue.py --pcp ../pc-control-plus --pin ../pcp-upstream.json --check    # exit 1 if out of date
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
import subprocess
import sys
import tempfile
from pathlib import Path

TARGET = Path(__file__).resolve().parents[3] / "backend" / "src" / "modules" / "mcp" / "pcpRelayCatalogue.generated.ts"
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
            text = (remote / module).read_text(encoding="utf-8")
            modules[module] = hashlib.sha256(text.encode("utf-8")).hexdigest()
            for number, line in enumerate(text.splitlines(), 1):
                code = line.split("#", 1)[0]
                if PIXEL_PATTERNS.search(code):
                    evidence.append(f"{module}:{number}: {line.strip()[:120]}")
        loops[name] = {"jobs": loop["jobs"], "state": loop["state"], "modules": modules,
                       "screenshot_free": not evidence, "evidence": evidence}
    return loops


def load_relay(pcp: Path):
    remote = pcp / "remote"
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


def verified_release(pcp: Path, pin: dict) -> dict:
    """The pinned, signed release this checkout is; raises SystemExit otherwise."""
    try:
        head = subprocess.run(["git", "-C", str(pcp), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"cannot read the checkout's commit: {error}")
    if head != pin["commit"]:
        raise SystemExit(f"the checkout is {head}, the pin is {pin['commit']}")
    manifest_path = pcp / "remote" / "release-manifest.json"
    if not manifest_path.is_file():
        raise SystemExit("the checkout has no signed release manifest (remote/release-manifest.json)")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "pcp.release.v2" or manifest.get("release_id") != pin["release_id"]:
        raise SystemExit(f"the manifest is release {manifest.get('release_id')}, the pin is {pin['release_id']}")
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        raise SystemExit("verifying the release needs the cryptography package (remote/requirements.txt installs it)")
    signature = base64.b64decode(manifest["signature_ed25519"], validate=True)
    payload = {key: value for key, value in manifest.items() if key != "signature_ed25519"}
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(pin["release_public_key_b64"], validate=True)).verify(signature, canonical(payload))
    except InvalidSignature:
        raise SystemExit("the release manifest's signature does not verify with the pinned public key")
    for name, digest in manifest["files"].items():
        actual = hashlib.sha256((pcp / "remote" / name).read_bytes()).hexdigest()
        if actual != digest:
            raise SystemExit(f"remote/{name} is not the signed file ({actual} != {digest})")
    return {
        "repository": pin["repository"], "ref": pin["ref"], "commit": pin["commit"],
        "release_id": manifest["release_id"], "release_sequence": manifest["release_sequence"],
        "release_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "signed_files": manifest["files"],
    }


def catalogue(pcp: Path, pin: dict | None = None) -> dict:
    release = verified_release(pcp, pin) if pin else None
    relay, tools = load_relay(pcp)
    source = (pcp / "remote" / "relay.py").read_text(encoding="utf-8")
    jobs = relay_job_ids(source)
    engine_names = {"pc_" + name for name in relay.pc_engine.TOOLS if name not in relay.ENGINE_EQUIVALENTS}
    entries = []
    for tool in sorted(tools, key=lambda item: item.name):
        if tool.name in RELAY_LOCAL or tool.name in engine_names:
            continue
        job = jobs.get(tool.name)
        if job is None or job not in relay.ALLOWED:
            raise SystemExit(f"{tool.name}: no relay job in relay.ALLOWED found in its body")
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
    loops = control_loops(pcp / "remote")
    if release:
        for name, loop in loops.items():
            for module, digest in loop["modules"].items():
                if release["signed_files"].get(module) != digest:
                    raise SystemExit(f"{name}: {module} is not a file of the signed release")
    return {
        "source": "MarekDesignLeaf/pc-control-plus remote/relay.py",
        # The signed release this was imported from (None: an unpinned local import, never committed).
        "upstream": release,
        "relay_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "engine_version": relay.pc_engine.ENGINE_VERSION,
        "tools": entries,
        # Jobs the relay accepts that no relay MCP tool sends (kept visible, never offered).
        "allowed_without_tool": unlisted,
        # Whether each control loop works from text state only (read from its source).
        "control_loops": loops,
    }


def render(pcp: Path, pin: dict | None = None) -> str:
    body = json.dumps(catalogue(pcp, pin), indent=2, ensure_ascii=False, sort_keys=True)
    return (
        "// GENERATED by windows-companion/pc-control/server/import_pcp_catalogue.py from the PC Control Plus relay.\n"
        "// Do not edit: run the script against a pc-control-plus checkout. Secretary's trust decisions are in pcRelayPolicy.ts.\n"
        "/* eslint-disable */\n"
        "export const PCP_RELAY_CATALOGUE = " + body + " as const;\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pcp", required=True, type=Path, help="path to a pc-control-plus checkout")
    parser.add_argument("--pin", type=Path, help="pcp-upstream.json: the signed release to import from (required to write)")
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    pin = json.loads(options.pin.read_text(encoding="utf-8")) if options.pin else None
    if not pin and not options.check:
        parser.error("--pin is required: the committed catalogue is always imported from the pinned signed release")
    text = render(options.pcp.resolve(), pin)
    if options.check:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != text:
            print(f"{TARGET} is out of date: run import_pcp_catalogue.py --pcp <pc-control-plus>", file=sys.stderr)
            return 1
        return 0
    TARGET.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
