"""
browser/engine.py — one persistent, fast browser session for the AI.

How it stays fast:
- One browser and one page stay open between tool calls; nothing is started
  per call.
- The page is read by one JavaScript pass (page_snapshot.js) that returns text
  with element refs, never a screenshot. Off-screen elements are included and
  Playwright scrolls to them by itself, so the AI never scrolls to look.
- browser_act runs a whole list of steps in one call and returns one fresh
  snapshot at the end, instead of one round trip per click.
- Playwright waits for each element to be actionable; there are no fixed
  sleeps. Heavy resources (images, fonts, media) can be blocked in config.

Which browser:
- mode "cdp": attach to a running Edge/Chrome started with
  --remote-debugging-port (Launch-PcControlBrowser.ps1), so the user's logged-in
  sessions in that profile are used. Only disconnects on close, never quits it.
- mode "launch": start Edge/Chrome with a dedicated persistent profile
  (%LOCALAPPDATA%\\VCUBF\\Alfonzo\\pc-control\\browser-profile); logins made
  there once are kept.
- mode "auto" (default): cdp if the debugging port answers, otherwise launch.
"""
from __future__ import annotations

import asyncio
import fnmatch
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from config import get
from browser.steps import Step, StepError, Target, format_snapshot, parse_steps

_HERE = Path(__file__).parent
SNAPSHOT_JS = (_HERE / "page_snapshot.js").read_text(encoding="utf-8")
EXTRACT_JS = (_HERE / "page_extract.js").read_text(encoding="utf-8")


class BrowserError(RuntimeError):
    pass


def default_profile_dir() -> Path:
    override = os.environ.get("PC_CONTROL_BROWSER_PROFILE") or get("browser", "profile_dir", "")
    if override:
        return Path(override)
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "VCUBF" / "Alfonzo" / "pc-control" / "browser-profile"
    return Path.home() / ".cache" / "vcubf-alfonzo" / "pc-control" / "browser-profile"


def _setting(key: str, default: Any) -> Any:
    env = os.environ.get(f"PC_CONTROL_BROWSER_{key.upper()}")
    if env is not None:
        if isinstance(default, bool):
            return env.lower() in ("1", "true", "yes")
        if isinstance(default, int):
            return int(env)
        return env
    return get("browser", key, default)


def domain_blocked(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    for pattern in get("browser", "blocked_domains", []) or []:
        pattern = str(pattern).lower()
        if host == pattern or host.endswith("." + pattern) or fnmatch.fnmatch(host, pattern):
            return True
    return False


class BrowserSession:
    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self.context = None
        self.page = None
        self.mode: str | None = None
        self._frame_ids: dict[Any, int] = {}
        self._lock = asyncio.Lock()

    # ─── lifecycle ───────────────────────────────────────────────────────────

    async def ensure(self):
        if self.page is not None and not self.page.is_closed():
            return self.page
        if self.context is not None:
            pages = [page for page in self.context.pages if not page.is_closed()]
            self.page = pages[-1] if pages else await self.context.new_page()
            return self.page
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise BrowserError("Playwright is not installed. Run Install-PcControl.ps1 (pip install playwright).") from exc
        self._pw = await async_playwright().start()
        mode = _setting("mode", "auto")
        cdp_url = _setting("cdp_url", "http://127.0.0.1:9222")
        if mode in ("auto", "cdp"):
            try:
                self._browser = await self._pw.chromium.connect_over_cdp(cdp_url, timeout=2500 if mode == "auto" else 10000)
                self.context = self._browser.contexts[0] if self._browser.contexts else await self._browser.new_context()
                self.mode = "cdp"
            except Exception as exc:
                if mode == "cdp":
                    await self._stop_pw()
                    raise BrowserError(f"No browser answers at {cdp_url}. Start it with Launch-PcControlBrowser.ps1.") from exc
        if self.context is None:
            profile = default_profile_dir()
            profile.mkdir(parents=True, exist_ok=True)
            launch: dict[str, Any] = {
                "user_data_dir": str(profile),
                "headless": bool(_setting("headless", False)),
                "no_viewport": not bool(_setting("headless", False)),
                "args": ["--disable-blink-features=AutomationControlled"],
            }
            executable = _setting("executable_path", "")
            channel = _setting("channel", "msedge")
            if executable:
                launch["executable_path"] = executable
            elif channel and channel != "chromium":
                launch["channel"] = channel
            self.context = await self._pw.chromium.launch_persistent_context(**launch)
            self.mode = "launch"
        self.context.set_default_timeout(int(_setting("default_timeout_ms", 5000)))
        self.context.set_default_navigation_timeout(int(_setting("navigation_timeout_ms", 20000)))
        blocked = set(get("browser", "block_resources", []) or [])
        if blocked:
            async def route(route):
                if route.request.resource_type in blocked:
                    await route.abort()
                else:
                    await route.continue_()
            await self.context.route("**/*", route)
        self.context.on("page", self._on_page)
        pages = [page for page in self.context.pages if not page.is_closed()]
        self.page = pages[-1] if pages else await self.context.new_page()
        return self.page

    def _on_page(self, page) -> None:
        # A popup opened from the page the AI works on (window.open) becomes the
        # current page; a tab the user opens by hand in their own browser does not.
        asyncio.ensure_future(self._adopt_popup(page))

    async def _adopt_popup(self, page) -> None:
        try:
            opener = await page.opener()
        except Exception:
            return
        if opener is not None and opener is self.page:
            self.page = page

    async def _stop_pw(self) -> None:
        if self._pw is not None:
            await self._pw.stop()
        self._pw = None

    async def close(self) -> dict[str, Any]:
        mode = self.mode
        try:
            if self.mode == "launch" and self.context is not None:
                await self.context.close()
            elif self._browser is not None:
                # Attached to the user's own browser: disconnect only.
                await self._browser.close()
        finally:
            self.context = self.page = self._browser = None
            self.mode = None
            await self._stop_pw()
        return {"success": True, "closed": mode == "launch", "disconnected": mode == "cdp"}

    # ─── reading ─────────────────────────────────────────────────────────────

    def _frame_prefix(self, frame) -> str:
        if frame == self.page.main_frame:
            return ""
        if frame not in self._frame_ids:
            self._frame_ids[frame] = len(self._frame_ids) + 1
        return f"f{self._frame_ids[frame]}:"

    async def snapshot_data(self, query: str = "", mode: str = "interactive", limit: int | None = None, max_text: int = 6000) -> list[dict[str, Any]]:
        page = await self.ensure()
        limit = limit or int(get("browser", "max_snapshot_elements", 120))
        frames = []
        for frame in page.frames:
            if frame != page.main_frame and (frame.is_detached() or frame.url in ("", "about:blank")):
                continue
            options = {"mode": mode, "query": query, "limit": limit, "maxText": max_text, "prefix": self._frame_prefix(frame)}
            try:
                data = await frame.evaluate(SNAPSHOT_JS, options)
            except Exception:
                if frame == page.main_frame:
                    raise
                continue
            frames.append(data)
            if frame == page.main_frame:
                limit = max(0, limit - len(data.get("elements", [])))
        return frames

    async def snapshot(self, query: str = "", mode: str = "interactive", limit: int | None = None, max_text: int = 6000) -> str:
        return format_snapshot(await self.snapshot_data(query, mode, limit, max_text), query)

    async def extract(self, options: dict[str, Any]) -> dict[str, Any]:
        page = await self.ensure()
        return await page.evaluate(EXTRACT_JS, options)

    async def evaluate(self, expression: str) -> Any:
        if not get("browser", "allow_eval", False):
            raise BrowserError("browser_eval is switched off (browser.allow_eval: false in config.yaml).")
        page = await self.ensure()
        return await page.evaluate(expression)

    # ─── navigation and tabs ─────────────────────────────────────────────────

    async def goto(self, url: str, new_tab: bool = False) -> None:
        if domain_blocked(url):
            raise BrowserError(f"{urlparse(url).hostname} is on the blocked domain list.")
        page = await self.ensure()
        if new_tab:
            page = await self.context.new_page()
            self.page = page
        await page.goto(url, wait_until="domcontentloaded")

    async def tabs(self, action: str = "list", index: int | None = None, url: str = "") -> dict[str, Any]:
        await self.ensure()
        pages = [page for page in self.context.pages if not page.is_closed()]
        if action == "new":
            self.page = await self.context.new_page()
            if url:
                await self.goto(url)
        elif action in ("switch", "close"):
            if index is None or not 0 <= index < len(pages):
                raise BrowserError(f"tab index must be 0–{len(pages) - 1}")
            if action == "switch":
                self.page = pages[index]
                await self.page.bring_to_front()
            else:
                await pages[index].close()
                remaining = [page for page in self.context.pages if not page.is_closed()]
                self.page = remaining[-1] if remaining else await self.context.new_page()
        elif action != "list":
            raise BrowserError("action is list, new, switch or close")
        pages = [page for page in self.context.pages if not page.is_closed()]
        return {
            "success": True,
            "tabs": [{"index": i, "title": await page.title(), "url": page.url, "current": page is self.page} for i, page in enumerate(pages)],
        }

    # ─── acting ──────────────────────────────────────────────────────────────

    def _locator(self, target: Target):
        page = self.page
        if target.ref:
            prefix, _, ref = target.ref.rpartition(":")
            frame = page.main_frame
            if prefix:
                wanted = int(prefix[1:])
                frame = next((f for f, n in self._frame_ids.items() if n == wanted and not f.is_detached()), None)
                if frame is None:
                    raise StepError(f"frame {prefix} is gone; take a new snapshot")
            return frame.locator(f'[data-pcref="{ref}"]')
        spec = target.locator
        exact = bool(spec.get("exact", False))
        if "role" in spec:
            locator = page.get_by_role(spec["role"], name=spec.get("name"), exact=exact) if spec.get("name") else page.get_by_role(spec["role"])
        elif "text" in spec:
            locator = page.get_by_text(spec["text"], exact=exact)
        elif "label" in spec:
            locator = page.get_by_label(spec["label"], exact=exact)
        elif "placeholder" in spec:
            locator = page.get_by_placeholder(spec["placeholder"], exact=exact)
        elif "test_id" in spec:
            locator = page.get_by_test_id(spec["test_id"])
        else:
            locator = page.locator(spec["css"])
        return locator.nth(int(spec.get("nth", 0)))

    async def _checked_locator(self, step: Step):
        locator = self._locator(step.target)
        if step.target.ref and await locator.count() == 0:
            raise StepError(f"{step.target.ref} is no longer on the page; take a new snapshot")
        if step.op in ("fill", "type") and not get("browser", "allow_password_fill", False):
            kind = (await locator.get_attribute("type", timeout=step.extra.get("timeout_ms", 5000)) or "").lower()
            if kind == "password":
                raise StepError("refusing to type into a password field (browser.allow_password_fill: false). Ask the user to sign in themselves in the browser window; the profile keeps the login.")
        return locator

    async def _run_step(self, step: Step) -> str:
        page = self.page
        timeout = step.extra.get("timeout_ms")
        kw = {"timeout": timeout} if timeout else {}
        op = step.op
        if op in ("goto", "back", "forward", "reload"):
            if op == "goto":
                await self.goto(step.value)
            elif op == "back":
                await page.go_back(wait_until="domcontentloaded", **kw)
            elif op == "forward":
                await page.go_forward(wait_until="domcontentloaded", **kw)
            else:
                await page.reload(wait_until="domcontentloaded", **kw)
            return f"{op} → {self.page.url}"
        if op == "press":
            if step.target:
                await (await self._checked_locator(step)).press(step.value, **kw)
            else:
                await page.keyboard.press(step.value)
            return f"pressed {step.value}"
        if op == "scroll":
            if step.target:
                await (await self._checked_locator(step)).scroll_into_view_if_needed(**kw)
            else:
                await page.evaluate("(where) => window.scrollTo(0, where === 'top' ? 0 : document.body.scrollHeight)", step.value)
            return "scrolled"
        if op == "wait_for":
            kind = step.extra["kind"]
            wait_timeout = timeout or int(_setting("navigation_timeout_ms", 20000))
            if kind == "text":
                await page.get_by_text(step.value).first.wait_for(state="visible", timeout=wait_timeout)
            elif kind == "gone":
                await page.get_by_text(step.value).first.wait_for(state="hidden", timeout=wait_timeout)
            elif kind == "url":
                await page.wait_for_url(step.value, timeout=wait_timeout)
            elif kind == "target":
                await self._locator(step.target).wait_for(state="visible", timeout=wait_timeout)
            elif kind == "state":
                await page.wait_for_load_state(step.value, timeout=wait_timeout)
            else:
                await page.wait_for_timeout(step.value)
            return f"waited for {kind}"
        locator = await self._checked_locator(step)
        if op == "click":
            # A link or form that opens another tab: wait for that tab and work on it,
            # so the next step (wait_for, snapshot) already sees the new page.
            opens = await locator.evaluate(
                "el => { const owner = el.closest('a[href], form'); const t = owner ? (owner.target || '') : ''; return !!t && t !== '_self' && t !== '_parent' && t !== '_top'; }",
                **kw,
            )
            if opens:
                async with self.context.expect_page(timeout=int(_setting("navigation_timeout_ms", 20000))) as info:
                    await locator.click(**kw)
                new_page = await info.value
                await new_page.wait_for_load_state("domcontentloaded")
                self.page = new_page
                return f"click {step.target.describe()} → new tab {new_page.url}"
            await locator.click(**kw)
        elif op == "dblclick":
            await locator.dblclick(**kw)
        elif op == "hover":
            await locator.hover(**kw)
        elif op == "fill":
            await locator.fill(step.value, **kw)
        elif op == "type":
            await locator.press_sequentially(step.value, **kw)
        elif op == "clear":
            await locator.clear(**kw)
        elif op == "check":
            await locator.check(**kw)
        elif op == "uncheck":
            await locator.uncheck(**kw)
        elif op == "select":
            if step.extra["by"] == "label":
                await locator.select_option(label=step.value, **kw)
            else:
                await locator.select_option(value=step.value, **kw)
        elif op == "upload":
            await locator.set_input_files(step.value, **kw)
        return f"{op} {step.target.describe()}"

    async def act(self, raw_steps: Any, snapshot: str = "auto", query: str = "") -> dict[str, Any]:
        steps = parse_steps(raw_steps)
        async with self._lock:
            await self.ensure()
            done: list[str] = []
            failure: dict[str, Any] | None = None
            for index, step in enumerate(steps):
                try:
                    done.append(await self._run_step(step))
                except StepError as exc:
                    failure = {"step": index + 1, "action": step.describe(), "error": str(exc)}
                    break
                except Exception as exc:  # Playwright timeouts and errors, shortened for the AI
                    message = str(exc).split("\n")[0][:300]
                    failure = {"step": index + 1, "action": step.describe(), "error": message,
                               "hint": "Take browser_snapshot(query=...) to find the right ref, or wait_for the element first."}
                    break
                if domain_blocked(self.page.url):
                    await self.page.goto("about:blank")
                    failure = {"step": index + 1, "action": step.describe(), "error": "navigated to a blocked domain; the page was cleared"}
                    break
            try:
                await self.page.wait_for_load_state("domcontentloaded", timeout=3000)
            except Exception:
                pass
            result: dict[str, Any] = {
                "success": failure is None,
                "done": done,
                "url": self.page.url,
                "title": await self.page.title(),
            }
            if failure:
                result["failed"] = failure
                result["skipped"] = len(steps) - len(done) - 1
            if snapshot != "none":
                result["snapshot"] = await self.snapshot(query=query)
            return result


SESSION = BrowserSession()
