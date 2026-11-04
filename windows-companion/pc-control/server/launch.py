"""
launch.py — entry point of the pc-control MCP server (.mcp.json).

Standard library only. When the server's packages are installed it runs
main.py. When they are missing it does not crash (which an MCP client only
shows as "Connection closed"): it serves a minimal MCP server over stdio
offering one tool, pc_status, which says exactly what is missing and how to
install it. That fallback reads only and changes nothing.
"""
from __future__ import annotations

import importlib.util
import json
import os
import runpy
import sys
import traceback
from pathlib import Path

SERVER_DIR = Path(__file__).parent
sys.path.insert(0, str(SERVER_DIR))

import status  # noqa: E402  (standard library only)

STATUS_TOOL = {
    "name": "pc_status",
    "title": "pc-control health check",
    "description": "Read-only health check of the pc-control plugin: version, Python, operating system, installed packages, "
                   "config, audit log folder, browser and UI Automation availability, and the exact problems with how to fix them. "
                   "Changes nothing.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
}


def _missing_to_start() -> list[str]:
    return [status.PACKAGES[module][0] for module in status.REQUIRED_TO_START if importlib.util.find_spec(module) is None]


def _send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve_fallback(reason: str) -> None:
    """A tiny newline-delimited JSON-RPC MCP server with only pc_status."""
    instructions = (
        f"pc-control {status.VERSION} could not start its tools: {reason} "
        "Only pc_status is available. Call it and tell the user the problems it lists and how to fix them. "
        "Do not try other pc-control tools until the server is restarted after the fix."
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            _send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        if not isinstance(request, dict) or "id" not in request:
            continue  # notifications need no answer
        method, rid, params = request.get("method"), request["id"], request.get("params") or {}
        if method == "initialize":
            result = {
                "protocolVersion": params.get("protocolVersion") or "2025-06-18",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "pc-control", "version": f"{status.VERSION}-fallback"},
                "instructions": instructions,
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [STATUS_TOOL]}
        elif method == "tools/call":
            name = params.get("name")
            if name == "pc_status":
                data = status.collect_status(server_running=False)
                data["startup_error"] = reason
                result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "structuredContent": data, "isError": False}
            else:
                result = {"content": [{"type": "text", "text": f"{name} is unavailable: {reason} Call pc_status."}], "isError": True}
        else:
            _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Method not found: {method}"}})
            continue
        _send({"jsonrpc": "2.0", "id": rid, "result": result})


def main() -> None:
    missing = [] if os.environ.get("PC_CONTROL_FORCE_FALLBACK") is None else ["(forced for a test)"]
    missing = missing or _missing_to_start()
    if missing:
        serve_fallback(f"missing Python packages for {sys.executable}: {', '.join(missing)}.")
        return
    try:
        runpy.run_path(str(SERVER_DIR / "main.py"), run_name="__main__")
    except SystemExit:
        raise
    except Exception as exc:  # an import or start-up error: report it instead of closing the connection
        sys.stderr.write(traceback.format_exc())
        serve_fallback(f"the server failed to start: {type(exc).__name__}: {str(exc).splitlines()[0][:300] if str(exc) else ''}")


if __name__ == "__main__":
    main()
