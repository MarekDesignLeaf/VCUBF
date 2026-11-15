"""
terminal_tools.py — run PowerShell / CMD commands with risk assessment.
"""
from __future__ import annotations

import subprocess
import time
from typing import Any

from config import get

# Active child processes (pid → Popen) for read_terminal_output
_PROCS: dict[int, subprocess.Popen] = {}


def run_command(
    command: str,
    shell_type: str = "auto",
    timeout: int | None = None,
    working_dir: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    """
    Execute a shell command.
    shell_type: 'powershell' | 'cmd' | 'auto' (default: config default_shell)
    dry_run overrides the global dry_run setting for single-call testing.
    """
    from config import is_dry_run
    effective_dry_run = dry_run or is_dry_run()

    if effective_dry_run:
        return {
            "success": True,
            "dry_run": True,
            "command": command,
            "note": "Dry-run mode active — command was NOT executed.",
        }

    resolved_shell = shell_type if shell_type != "auto" else get("terminal", "default_shell", "powershell")
    timeout_s = timeout or get("terminal", "timeout_seconds", 60)
    cwd = working_dir or None

    if resolved_shell == "powershell":
        cmd_list = ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    else:
        cmd_list = ["cmd", "/c", command]

    try:
        result = subprocess.run(
            cmd_list,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=cwd,
        )
        return {
            "success": result.returncode == 0,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "shell": resolved_shell,
            "command": command,
            "dry_run": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": f"Command timed out after {timeout_s}s",
            "command": command,
        }
    except Exception as exc:
        return {"success": False, "error": str(exc), "command": command}


def start_process(command: str, shell_type: str = "auto", working_dir: str = "") -> dict[str, Any]:
    """
    Start a long-running process in the background.
    Returns a process handle ID for subsequent read_terminal_output calls.
    """
    resolved_shell = shell_type if shell_type != "auto" else get("terminal", "default_shell", "powershell")
    cwd = working_dir or None

    if resolved_shell == "powershell":
        cmd_list = ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    else:
        cmd_list = ["cmd", "/c", command]

    try:
        proc = subprocess.Popen(
            cmd_list, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, cwd=cwd,
        )
        _PROCS[proc.pid] = proc
        return {"success": True, "pid": proc.pid, "command": command}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def read_terminal_output(pid: int, timeout: float = 1.0) -> dict[str, Any]:
    """Read buffered output from a background process started with start_process."""
    proc = _PROCS.get(pid)
    if proc is None:
        return {"success": False, "error": f"No background process with pid {pid}"}
    lines = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line and proc.poll() is not None:
            break
        if line:
            lines.append(line.rstrip())
    return {
        "success": True,
        "pid": pid,
        "output": "\n".join(lines),
        "returncode": proc.poll(),
    }


def analyse_build_error(output: str) -> dict[str, Any]:
    """
    Parse common build/compiler error patterns from terminal output.
    Returns structured findings: errors, warnings, file locations.
    """
    import re

    error_patterns = [
        # MSBuild / C# / Java style
        r"(?P<file>[^\s:]+)\((?P<line>\d+),(?P<col>\d+)\):\s*(?P<level>error|warning)\s+(?P<code>\w+):\s*(?P<msg>.+)",
        # Generic "file:line: error: msg"
        r"(?P<file>[^\s:]+):(?P<line>\d+):\s*(?P<level>error|warning):\s*(?P<msg>.+)",
        # Python traceback
        r'File "(?P<file>[^"]+)", line (?P<line>\d+)',
        # npm / node
        r"(?P<level>ERROR|WARN)\s+(?P<msg>.+)",
        # Gradle
        r"(?P<level>FAILURE|error):\s*(?P<msg>.+)",
    ]

    findings: list[dict] = []
    for line in output.splitlines():
        for pat in error_patterns:
            m = re.search(pat, line, re.IGNORECASE)
            if m:
                d = {k: v for k, v in m.groupdict().items() if v}
                d["raw_line"] = line.strip()
                findings.append(d)
                break

    errors = [f for f in findings if f.get("level", "").lower() in ("error", "failure", "error")]
    warnings = [f for f in findings if f.get("level", "").lower() in ("warning", "warn")]

    return {
        "success": True,
        "error_count": len(errors),
        "warning_count": len(warnings),
        "errors": errors[:20],
        "warnings": warnings[:20],
        "all_findings": findings[:50],
    }
