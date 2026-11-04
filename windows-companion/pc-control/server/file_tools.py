"""
file_tools.py — safe file system operations with auto-backup.
"""
from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from config import get, get_blocked_paths


# ─── Guards ──────────────────────────────────────────────────────────────────

def _check_blocked(path: str) -> str | None:
    p = Path(path).resolve()
    for blocked in get_blocked_paths():
        if str(p).lower().startswith(blocked.lower()):
            return f"Path '{p}' is in a blocked location: {blocked}"
    return None


# ─── Backup ──────────────────────────────────────────────────────────────────

def _make_backup(path: Path) -> str | None:
    if not get("files", "auto_backup", True):
        return None
    if not path.exists():
        return None
    suffix = get("files", "backup_suffix", ".bak")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = path.with_suffix(f"{path.suffix}{suffix}.{ts}")
    shutil.copy2(path, backup)
    return str(backup)


# ─── Tools ───────────────────────────────────────────────────────────────────

def list_files(directory: str, pattern: str = "*", recursive: bool = False) -> dict[str, Any]:
    """List files and directories matching a glob pattern."""
    err = _check_blocked(directory)
    if err:
        return {"success": False, "error": err}
    p = Path(directory)
    if not p.exists():
        return {"success": False, "error": f"Directory not found: {directory}"}
    try:
        glob_fn = p.rglob if recursive else p.glob
        entries = []
        for item in sorted(glob_fn(pattern)):
            stat = item.stat()
            entries.append({
                "name": item.name,
                "path": str(item),
                "type": "dir" if item.is_dir() else "file",
                "size_bytes": stat.st_size if item.is_file() else None,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
        return {"success": True, "directory": str(p.resolve()), "entries": entries}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def read_file(path: str, encoding: str = "utf-8") -> dict[str, Any]:
    """Read a text file and return its contents."""
    err = _check_blocked(path)
    if err:
        return {"success": False, "error": err}
    p = Path(path)
    if not p.exists():
        return {"success": False, "error": f"File not found: {path}"}
    max_mb = get("files", "max_inline_read_mb", 5)
    size_mb = p.stat().st_size / 1e6
    if size_mb > max_mb:
        return {
            "success": False,
            "error": f"File too large ({size_mb:.1f} MB > {max_mb} MB limit). "
                     "Use a more targeted approach or increase max_inline_read_mb.",
        }
    try:
        content = p.read_text(encoding=encoding, errors="replace")
        return {"success": True, "path": str(p.resolve()),
                "size_bytes": p.stat().st_size, "content": content}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def write_file(path: str, content: str, encoding: str = "utf-8") -> dict[str, Any]:
    """Write text content to a file, auto-backing up any existing file first."""
    err = _check_blocked(path)
    if err:
        return {"success": False, "error": err}
    p = Path(path)
    backup = _make_backup(p)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding=encoding)
        return {"success": True, "path": str(p.resolve()),
                "bytes_written": len(content.encode(encoding)),
                "backup": backup}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def copy_file(source: str, destination: str) -> dict[str, Any]:
    """Copy a file or directory tree to destination."""
    for loc in (source, destination):
        err = _check_blocked(loc)
        if err:
            return {"success": False, "error": err}
    src, dst = Path(source), Path(destination)
    if not src.exists():
        return {"success": False, "error": f"Source not found: {source}"}
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
        return {"success": True, "source": str(src.resolve()),
                "destination": str(dst.resolve())}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def move_file(source: str, destination: str) -> dict[str, Any]:
    """Move / rename a file or directory."""
    for loc in (source, destination):
        err = _check_blocked(loc)
        if err:
            return {"success": False, "error": err}
    src, dst = Path(source), Path(destination)
    if not src.exists():
        return {"success": False, "error": f"Source not found: {source}"}
    backup = _make_backup(src) if src.is_file() else None
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        return {"success": True, "source": str(src),
                "destination": str(dst.resolve()), "backup": backup}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def delete_file(path: str, permanent: bool = False) -> dict[str, Any]:
    """
    Delete a file.  By default moves it to the Recycle Bin (Windows).
    Set permanent=True only with explicit user consent.
    """
    err = _check_blocked(path)
    if err:
        return {"success": False, "error": err}
    p = Path(path)
    if not p.exists():
        return {"success": False, "error": f"Path not found: {path}"}
    backup = _make_backup(p) if p.is_file() else None
    try:
        if permanent:
            if p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
            return {"success": True, "path": str(p), "permanent": True, "backup": backup}
        else:
            # Soft-delete: move to a _deleted_ folder in parent
            deleted_dir = p.parent / "_deleted_"
            deleted_dir.mkdir(exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            dest = deleted_dir / f"{p.name}.{ts}"
            shutil.move(str(p), str(dest))
            return {"success": True, "path": str(p),
                    "permanent": False, "moved_to": str(dest)}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def create_directory(path: str) -> dict[str, Any]:
    """Create a directory (and all parents)."""
    err = _check_blocked(path)
    if err:
        return {"success": False, "error": err}
    p = Path(path)
    try:
        p.mkdir(parents=True, exist_ok=True)
        return {"success": True, "path": str(p.resolve())}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def search_files(root: str, pattern: str, content_search: str = "") -> dict[str, Any]:
    """
    Recursively search for files matching a glob pattern.
    Optionally filter to those containing a text string.
    """
    err = _check_blocked(root)
    if err:
        return {"success": False, "error": err}
    p = Path(root)
    if not p.exists():
        return {"success": False, "error": f"Root not found: {root}"}
    try:
        matches = []
        for item in p.rglob(pattern):
            if item.is_file():
                if content_search:
                    try:
                        text = item.read_text(encoding="utf-8", errors="ignore")
                        if content_search.lower() not in text.lower():
                            continue
                    except Exception:
                        continue
                matches.append(str(item))
        return {"success": True, "root": str(p.resolve()),
                "pattern": pattern, "matches": matches[:500]}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def create_backup(path: str) -> dict[str, Any]:
    """Explicitly create a timestamped backup of a file."""
    err = _check_blocked(path)
    if err:
        return {"success": False, "error": err}
    p = Path(path)
    if not p.exists():
        return {"success": False, "error": f"File not found: {path}"}
    backup = _make_backup(p)
    return {"success": True, "original": str(p.resolve()), "backup": backup}


def restore_backup(backup_path: str, target_path: str) -> dict[str, Any]:
    """Restore a previously created backup to the target path."""
    for loc in (backup_path, target_path):
        err = _check_blocked(loc)
        if err:
            return {"success": False, "error": err}
    src = Path(backup_path)
    if not src.exists():
        return {"success": False, "error": f"Backup not found: {backup_path}"}
    # Backup the current target before overwriting
    dst = Path(target_path)
    pre_backup = _make_backup(dst)
    try:
        shutil.copy2(src, dst)
        return {"success": True, "restored_from": str(src.resolve()),
                "restored_to": str(dst.resolve()), "pre_restore_backup": pre_backup}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
