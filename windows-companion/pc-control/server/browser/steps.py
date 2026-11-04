"""
browser/steps.py — the action language of browser_act, without any browser.

An AI sends one list of steps per call; every step is checked here first, so a
malformed plan is refused whole before anything on the page happens. The same
module formats snapshots as compact text and redacts typed values for the
audit log.

Step forms (one operation key per step):

    {"click": TARGET}                     {"dblclick": TARGET}
    {"fill": TARGET, "value": "text"}     {"type": TARGET, "value": "text"}
    {"clear": TARGET}                     {"hover": TARGET}
    {"select": TARGET, "value": "x"}      {"select": TARGET, "label": "X"}
    {"check": TARGET}                     {"uncheck": TARGET}
    {"press": "Enter"}                    {"press": "Control+A", "target": TARGET}
    {"upload": TARGET, "files": ["C:/path/file.pdf"]}
    {"goto": "https://..."}               {"back": true} / {"forward": true} / {"reload": true}
    {"wait_for": WAIT}                    {"scroll": TARGET | "top" | "bottom"}

TARGET is a snapshot ref ("e12", "f1:e3") or a locator object:
    {"role": "button", "name": "Send"}   {"text": "Sign in"}   {"label": "E-mail"}
    {"placeholder": "Search"}            {"css": "form#login button[type=submit]"}
    {"test_id": "submit"}
    optional "exact": true and "nth": 0 (default first match).

WAIT is one of:
    {"text": "Order confirmed"}   {"gone": "Loading"}   {"url": "**/checkout"}
    {"target": TARGET}            {"state": "load" | "domcontentloaded" | "networkidle"}
    {"ms": 500}  (at most 10000; prefer a condition)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

REF_PATTERN = re.compile(r"^(?:f\d+:)?e\d+$")
LOCATOR_KEYS = ("role", "text", "label", "placeholder", "css", "test_id")
TARGET_OPS = ("click", "dblclick", "fill", "type", "clear", "hover", "select", "check", "uncheck", "upload")
NAVIGATION_OPS = ("goto", "back", "forward", "reload")
ALL_OPS = TARGET_OPS + NAVIGATION_OPS + ("press", "wait_for", "scroll")
VALUE_OPS = ("fill", "type")
MAX_STEPS = 40
MAX_WAIT_MS = 10_000
WAIT_STATES = ("load", "domcontentloaded", "networkidle")


class StepError(ValueError):
    """A step that cannot run; the message says which and why."""


@dataclass
class Target:
    ref: str | None = None
    locator: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        if self.ref:
            return self.ref
        return ", ".join(f"{key}={value!r}" for key, value in self.locator.items())


@dataclass
class Step:
    op: str
    target: Target | None = None
    value: Any = None
    extra: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        parts = [self.op]
        if self.target:
            parts.append(self.target.describe())
        return " ".join(parts)


def parse_target(raw: Any, where: str) -> Target:
    if isinstance(raw, str):
        text = raw.strip()
        if REF_PATTERN.match(text):
            return Target(ref=text)
        raise StepError(f"{where}: '{raw}' is not a snapshot ref (e12, f1:e3); use a locator object such as {{\"text\": \"...\"}}")
    if isinstance(raw, dict):
        keys = [key for key in LOCATOR_KEYS if key in raw]
        if len(keys) != 1:
            raise StepError(f"{where}: a locator needs exactly one of {', '.join(LOCATOR_KEYS)}")
        unknown = set(raw) - set(LOCATOR_KEYS) - {"name", "exact", "nth"}
        if unknown:
            raise StepError(f"{where}: unknown locator keys {sorted(unknown)}")
        if "name" in raw and keys[0] != "role":
            raise StepError(f"{where}: name is only used with role")
        value = raw[keys[0]]
        if not isinstance(value, str) or not value.strip():
            raise StepError(f"{where}: {keys[0]} must be non-empty text")
        if "nth" in raw and (not isinstance(raw["nth"], int) or raw["nth"] < 0):
            raise StepError(f"{where}: nth must be a whole number from 0")
        return Target(locator=dict(raw))
    raise StepError(f"{where}: a target is a ref like \"e12\" or a locator object")


def parse_steps(raw_steps: Any) -> list[Step]:
    if not isinstance(raw_steps, list) or not raw_steps:
        raise StepError("steps must be a non-empty list")
    if len(raw_steps) > MAX_STEPS:
        raise StepError(f"at most {MAX_STEPS} steps per call")
    steps: list[Step] = []
    for index, raw in enumerate(raw_steps):
        where = f"step {index + 1}"
        if not isinstance(raw, dict):
            raise StepError(f"{where}: each step is an object such as {{\"click\": \"e12\"}}")
        ops = [key for key in ALL_OPS if key in raw]
        if len(ops) != 1:
            raise StepError(f"{where}: exactly one operation of {', '.join(ALL_OPS)}")
        op = ops[0]
        steps.append(_parse_one(op, raw, where))
    return steps


def _parse_one(op: str, raw: dict[str, Any], where: str) -> Step:
    allowed = {op, "value", "label", "target", "files", "timeout_ms"}
    unknown = set(raw) - allowed
    if unknown:
        raise StepError(f"{where}: unknown keys {sorted(unknown)}")
    extra: dict[str, Any] = {}
    if "timeout_ms" in raw:
        timeout = raw["timeout_ms"]
        if not isinstance(timeout, int) or not 100 <= timeout <= 60_000:
            raise StepError(f"{where}: timeout_ms must be 100–60000")
        extra["timeout_ms"] = timeout

    if op in TARGET_OPS:
        target = parse_target(raw[op], where)
        if op in VALUE_OPS:
            if not isinstance(raw.get("value"), str):
                raise StepError(f"{where}: {op} needs value (text)")
            return Step(op, target, raw["value"], extra)
        if op == "select":
            if isinstance(raw.get("value"), str):
                return Step(op, target, raw["value"], {**extra, "by": "value"})
            if isinstance(raw.get("label"), str):
                return Step(op, target, raw["label"], {**extra, "by": "label"})
            raise StepError(f"{where}: select needs value or label")
        if op == "upload":
            files = raw.get("files")
            if not isinstance(files, list) or not files or not all(isinstance(path, str) and path for path in files):
                raise StepError(f"{where}: upload needs files, a list of local paths")
            return Step(op, target, files, extra)
        return Step(op, target, None, extra)

    if op == "goto":
        url = raw["goto"]
        if not isinstance(url, str) or not re.match(r"^(https?://|about:blank$|file:///)", url.strip()):
            raise StepError(f"{where}: goto needs an http(s) URL")
        return Step(op, None, url.strip(), extra)
    if op in ("back", "forward", "reload"):
        return Step(op, None, None, extra)
    if op == "press":
        key = raw["press"]
        if not isinstance(key, str) or not key.strip():
            raise StepError(f"{where}: press needs a key such as Enter or Control+A")
        target = parse_target(raw["target"], where) if "target" in raw else None
        return Step(op, target, key.strip(), extra)
    if op == "scroll":
        value = raw["scroll"]
        if value in ("top", "bottom"):
            return Step(op, None, value, extra)
        return Step(op, parse_target(value, where), None, extra)
    # wait_for
    wait = raw["wait_for"]
    if not isinstance(wait, dict) or len(wait) != 1:
        raise StepError(f"{where}: wait_for takes one condition: text, gone, url, target, state or ms")
    kind, value = next(iter(wait.items()))
    if kind in ("text", "gone", "url"):
        if not isinstance(value, str) or not value.strip():
            raise StepError(f"{where}: wait_for {kind} needs text")
        return Step(op, None, value, {**extra, "kind": kind})
    if kind == "target":
        return Step(op, parse_target(value, where), None, {**extra, "kind": kind})
    if kind == "state":
        if value not in WAIT_STATES:
            raise StepError(f"{where}: wait_for state is one of {', '.join(WAIT_STATES)}")
        return Step(op, None, value, {**extra, "kind": kind})
    if kind == "ms":
        if not isinstance(value, int) or not 0 < value <= MAX_WAIT_MS:
            raise StepError(f"{where}: wait_for ms must be 1–{MAX_WAIT_MS}; prefer waiting for text or a target")
        return Step(op, None, value, {**extra, "kind": kind})
    raise StepError(f"{where}: unknown wait_for condition '{kind}'")


def redact_steps(raw_steps: Any) -> Any:
    """The steps as the audit log keeps them: typed text replaced by its length."""
    if not isinstance(raw_steps, list):
        return raw_steps
    redacted = []
    for raw in raw_steps:
        if isinstance(raw, dict) and any(op in raw for op in VALUE_OPS) and isinstance(raw.get("value"), str):
            raw = {**raw, "value": f"<{len(raw['value'])} chars>"}
        redacted.append(raw)
    return redacted


# ─── Snapshot formatting ─────────────────────────────────────────────────────

def format_element(item: dict[str, Any]) -> str:
    line = f"[{item['ref']}] {item.get('role', 'generic')}"
    if item.get("name"):
        line += f' "{item["name"]}"'
    if item.get("type"):
        line += f" type={item['type']}"
    if "value" in item and item["value"] is not None:
        line += f' value="{item["value"]}"'
    if item.get("href"):
        line += f" → {item['href']}"
    if item.get("options"):
        more = f" +{item['moreOptions']}" if item.get("moreOptions") else ""
        line += " options=[" + " | ".join(item["options"]) + more + "]"
    for flag in ("checked", "expanded", "selected"):
        if flag in item:
            line += f" {flag}" if item[flag] else f" not-{flag}"
    for flag in ("disabled", "required", "invalid"):
        if item.get(flag):
            line += f" {flag}"
    return line


def format_snapshot(frames: list[dict[str, Any]], query: str = "") -> str:
    """One text block for the AI: page, headings, then one line per control."""
    main = frames[0] if frames else {"url": "", "title": "", "elements": [], "headings": []}
    lines = [f"Page: {main.get('title') or '(no title)'}", f"URL: {main.get('url')}"]
    if main.get("headings"):
        lines.append("Headings: " + " / ".join(main["headings"][:12]))
    total = sum(frame.get("total", 0) for frame in frames)
    shown = sum(len(frame.get("elements", [])) for frame in frames)
    lines.append(
        f"Controls{' matching ' + repr(query) if query else ''}: {shown} shown of {total}"
        + (" (narrow with query=...)" if shown < total else "")
    )
    for frame in frames:
        if frame is not main and frame.get("elements"):
            lines.append(f"-- frame {frame.get('url')}")
        lines.extend(format_element(item) for item in frame.get("elements", []))
    text = "\n".join(lines)
    texts = [frame.get("text") for frame in frames if frame.get("text")]
    if texts:
        text += "\n\nText:\n" + "\n".join(texts)
    return text
