"""Fast DOM-first browser tooling for PC Control Plus.

A browser snapshot is collected in one in-page JavaScript evaluation. Browser
actions are structured Playwright operations; no pixels or arbitrary site code
are interpreted as instructions.
"""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit

SELECTOR = "a,button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']"
DOM_JS = r"""() => {
  const selector = "a,button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']";
  const raw = [...document.querySelectorAll(selector)];
  const visible = el => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden');
  };
  const controls = [];
  for (let i = 0; i < raw.length && controls.length < 160; i++) {
    const el = raw[i], type = (el.getAttribute('type') || '').toLowerCase();
    if (!visible(el) || ['password','hidden','file'].includes(type)) continue;
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.innerText || el.getAttribute('title') || el.getAttribute('name') || '').trim();
    controls.push({
      index: i, tag: el.tagName.toLowerCase(), type,
      role: el.getAttribute('role') || '',
      label: label.slice(0,130), id: el.id.slice(0,80),
      name: (el.getAttribute('name') || '').slice(0,80),
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').split('?')[0].slice(0,250) : ''
    });
  }
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template,svg,canvas,iframe').forEach(el => el.remove());
  clone.querySelectorAll('input,textarea,option,meta').forEach(el => {
    el.removeAttribute('value'); el.removeAttribute('content');
    if(el.tagName === 'TEXTAREA') el.textContent = '';
  });
  clone.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /^data-/i.test(a.name) ||
          /(nonce|token|secret|authorization|cookie|integrity)/i.test(a.name) ||
          (['src','href','action'].includes(a.name) && a.value.includes('?'))) {
        el.removeAttribute(a.name);
      }
    }
  });
  const html = clone.outerHTML;
  return {
    title: document.title,
    url: location.origin + location.pathname,
    text: (document.body?.innerText || '').slice(0,14000),
    html: html.slice(0,28000),
    html_length: html.length,
    controls, incomplete: html.length > 28000
  };
}"""
_RISK = re.compile(r"\b(pay|purchase|buy|delete|remove|publish|send|submit|checkout|"
                   r"confirm booking|place order|transfer|unsubscribe|cancel subscription)\b", re.I)


def safe_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return False
    host = parsed.hostname.lower().rstrip(".")
    if host in ("localhost",) or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        records = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        return bool(records) and all(ipaddress.ip_address(x[4][0]).is_global for x in records)
    except (OSError, ValueError):
        return False


def inspect(page):
    """Return sanitized rendered HTML, text and indexed interactive controls."""
    return page.evaluate(DOM_JS)


def _locator(page, index):
    if not 0 <= index < 2000:
        raise ValueError("Element index out of bounds")
    locator = page.locator(SELECTOR).nth(index)
    if locator.count() != 1 or not locator.is_visible(timeout=500):
        raise ValueError("Element is missing or hidden; refresh the DOM snapshot")
    typ = (locator.get_attribute("type") or "").lower()
    if typ in ("password", "hidden", "file"):
        raise ValueError("Restricted form field")
    return locator, typ


def execute(page, actions, allow_changes=False, cancel=None):
    """Execute at most six DOM operations; return a fresh snapshot only after the batch.

    Actions may include an expected label to detect DOM reordering. Risky actions
    always stop unless the owner explicitly enables state-changing actions.
    """
    if not isinstance(actions, list) or not 1 <= len(actions) <= 6:
        raise ValueError("Expected 1-6 browser actions")
    result = []
    for action in actions:
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Owner cancelled the task")
        kind = str(action.get("action", "")).lower()
        if kind not in ("click", "fill", "select", "press", "navigate", "wait"):
            raise ValueError("Unsupported browser action")
        if kind == "navigate":
            url = str(action.get("url", ""))
            if not safe_url(url):
                raise ValueError("Only public HTTPS navigation permitted")
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
        elif kind == "wait":
            page.wait_for_timeout(min(max(int(action.get("ms", 250)), 0), 1200))
        elif kind == "press":
            key = str(action.get("key", ""))
            if key not in ("Tab", "Escape", "ArrowDown", "ArrowUp"):
                raise ValueError("Unsupported key")
            page.keyboard.press(key)
        else:
            index = int(action.get("index", -1))
            locator, typ = _locator(page, index)
            expected = str(action.get("expected_label", "")).strip()
            if expected:
                actual = (locator.get_attribute("aria-label") or locator.get_attribute("placeholder")
                          or locator.inner_text(timeout=500) or locator.get_attribute("name") or "").strip()
                if actual[:130] != expected:
                    raise ValueError("Page changed; chosen element no longer matches the snapshot")
            label = (expected or locator.get_attribute("aria-label") or
                     locator.inner_text(timeout=500) or "").strip()
            if not allow_changes and (typ == "submit" or _RISK.search(label)):
                raise PermissionError("A state-changing action needs explicit approval: " + label[:120])
            if kind == "click":
                locator.click(timeout=8000)
            elif kind == "fill":
                if typ in ("checkbox", "radio", "submit", "button"):
                    raise ValueError("Cannot fill this input type")
                locator.fill(str(action.get("value", ""))[:1000], timeout=8000)
            else:
                locator.select_option(str(action.get("value", ""))[:120], timeout=8000)
        if not safe_url(page.url):
            raise PermissionError("Browser navigated outside public HTTPS; action blocked")
        result.append({"action": kind, "ok": True, "url": page.url.split("?")[0]})
    return {"actions": result, "url": page.url.split("?")[0], "title": page.title()}
