"""
web_fetch.py — read a web page as Markdown over plain HTTP, without a browser.

The fastest way to read static pages (articles, documentation, product pages
served as HTML): one HTTP request, no JavaScript, no rendering. Pages that need
JavaScript or a login are read with browser_open / browser_read instead.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin

from browser.engine import domain_blocked

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) pc-control/0.2 (VCUBF Alfonzo)"
SKIP = {"script", "style", "noscript", "template", "svg", "nav", "footer", "aside", "form", "iframe", "head"}
BLOCK = {"p", "div", "section", "article", "main", "br", "tr", "table", "ul", "ol", "header", "blockquote", "pre", "figure", "dl"}


class _Markdown(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.out: list[str] = []
        self.skip_depth = 0
        self.title = ""
        self._in_title = False
        self._link: str | None = None
        self._link_text: list[str] = []
        self.links: list[dict[str, str]] = []
        self._cells: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        if tag in SKIP:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if re.fullmatch(r"h[1-6]", tag):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag == "tr":
            self._cells = []
        elif tag in ("td", "th") and self._cells is not None:
            self._cells.append("")
        elif tag in BLOCK:
            self.out.append("\n\n")
        elif tag == "a":
            href = dict(attrs).get("href")
            if href and not href.startswith(("javascript:", "#", "mailto:")):
                self._link = urljoin(self.base_url, href)
                self._link_text = []
        elif tag == "img":
            alt = dict(attrs).get("alt")
            if alt:
                self.out.append(f"[image: {alt}]")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in SKIP:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth:
            return
        if tag == "a" and self._link:
            text = " ".join("".join(self._link_text).split())
            if text:
                self.out.append(f"[{text}]({self._link})")
                self.links.append({"text": text, "url": self._link})
            self._link = None
        elif tag == "tr" and self._cells is not None:
            cells = [" ".join(cell.split()) for cell in self._cells]
            if any(cells):
                self.out.append("\n| " + " | ".join(cells) + " |")
            self._cells = None
        elif re.fullmatch(r"h[1-6]", tag) or tag in BLOCK:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
            return
        if self.skip_depth:
            return
        if self._link is not None:
            self._link_text.append(data)
        elif self._cells is not None and self._cells:
            self._cells[-1] += data
        else:
            self.out.append(re.sub(r"\s+", " ", data))

    def markdown(self) -> str:
        text = "".join(self.out)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def html_to_markdown(html: str, base_url: str = "") -> dict[str, Any]:
    parser = _Markdown(base_url)
    parser.feed(html)
    parser.close()
    return {"title": " ".join(parser.title.split()), "markdown": parser.markdown(), "links": parser.links}


async def web_fetch(url: str, max_chars: int = 20000, include_links: bool = False) -> dict[str, Any]:
    if not re.match(r"^https?://", url or ""):
        return {"success": False, "error": "url must start with http:// or https://"}
    if domain_blocked(url):
        return {"success": False, "error": "that domain is on the blocked domain list"}
    import httpx

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers={"User-Agent": USER_AGENT, "Accept-Language": "cs,en;q=0.8"}) as client:
        response = await client.get(url)
    content_type = response.headers.get("content-type", "")
    if "html" not in content_type and "xml" not in content_type:
        text = response.text if content_type.startswith("text/") or "json" in content_type else ""
        if not text:
            return {"success": False, "status": response.status_code, "error": f"not a text page ({content_type}); use browser_open"}
        return {"success": response.is_success, "status": response.status_code, "url": str(response.url), "content_type": content_type,
                "markdown": text[:max_chars], "truncated": len(text) > max_chars}
    page = html_to_markdown(response.text, str(response.url))
    markdown = page["markdown"]
    result: dict[str, Any] = {
        "success": response.is_success,
        "status": response.status_code,
        "url": str(response.url),
        "title": page["title"],
        "markdown": markdown[:max_chars],
        "truncated": len(markdown) > max_chars,
    }
    if len(markdown) < 200:
        result["hint"] = "Little text came back: the page probably needs JavaScript. Use browser_open or browser_read."
    if include_links:
        result["links"] = page["links"][:200]
    return result
