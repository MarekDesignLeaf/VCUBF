"""Browser tools against a real headless Chromium and local pages, through the MCP server.

Skipped when Playwright or a Chromium build is not installed. This proves the
snapshot, refs, batched actions, extraction and safety rules on a real browser
engine; it is not an acceptance on the owner's Edge profile or live websites.
"""
import asyncio
import functools
import json
import os
import threading
import time
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import _env

try:
    import playwright  # noqa: F401
    HAVE_PLAYWRIGHT = True
except ImportError:
    HAVE_PLAYWRIGHT = False


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@unittest.skipUnless(HAVE_PLAYWRIGHT, "playwright is not installed")
class BrowserTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import main
        cls.main = main
        handler = functools.partial(Quiet, directory=str(_env.FIXTURES))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.loop = asyncio.new_event_loop()
        try:
            cls.loop.run_until_complete(main.BROWSER.ensure())
        except Exception as exc:
            cls.loop.close()
            cls.server.shutdown()
            cls.server.server_close()
            if os.environ.get("PC_CONTROL_REQUIRE_BROWSER"):
                raise
            raise unittest.SkipTest(f"no Chromium could be started: {exc}")

    @classmethod
    def tearDownClass(cls):
        cls.loop.run_until_complete(cls.main.BROWSER.close())
        cls.loop.close()
        cls.server.shutdown()
        cls.server.server_close()

    def call(self, name, args=None):
        result = self.loop.run_until_complete(self.main.mcp.call_tool(name, args or {}))
        if result.structured_content is not None:
            return result.structured_content
        return json.loads(result.content[0].text)

    def ref(self, snapshot, needle):
        for line in snapshot.splitlines():
            if needle in line and line.startswith("["):
                return line[1:line.index("]")]
        self.fail(f"{needle!r} not in snapshot:\n{snapshot}")

    def open_form(self, **extra):
        data = self.call("browser_open", {"url": f"{self.base}/form.html", **extra})
        self.assertTrue(data["success"], data)
        return data["snapshot"]

    def test_open_returns_controls_as_text_refs_including_offscreen_shadow_and_frames(self):
        snapshot = self.open_form()
        self.assertIn("Page: Objednávka – test", snapshot)
        self.assertIn("Headings: # Objednávka služby", snapshot)
        self.assertRegex(snapshot, r'\[e\d+\] textbox "Jméno" value="" required')
        self.assertRegex(snapshot, r'\[e\d+\] textbox "E-mail" type=email value=""')
        self.assertRegex(snapshot, r'\[e\d+\] combobox "Služba" value="–" options=\[– \| Sekání trávy \| Stříhání živého plotu\]')
        self.assertRegex(snapshot, r'\[e\d+\] checkbox "Souhlasím s podmínkami" not-checked')
        self.assertRegex(snapshot, r'\[e\d+\] link "Katalog" → /catalogue.html')
        self.assertIn('button "Tlačítko dole"', snapshot, "off-screen controls are listed without scrolling")
        self.assertIn('button "Stínové tlačítko"', snapshot, "open shadow DOM is read")
        self.assertRegex(snapshot, r'\[f\d+:e\d+\] button "Tlačítko v rámci"')
        self.assertNotIn("data:image", snapshot)

    def test_query_narrows_the_snapshot_and_refs_stay_stable(self):
        first = self.open_form()
        name_ref = self.ref(first, '"Jméno"')
        narrowed = self.call("browser_snapshot", {"query": "objednávku"})["snapshot"]
        self.assertIn('button "Odeslat objednávku"', narrowed)
        self.assertNotIn('"Jméno"', narrowed)
        again = self.call("browser_snapshot")["snapshot"]
        self.assertEqual(self.ref(again, '"Jméno"'), name_ref)

    def test_one_batched_call_fills_selects_checks_submits_and_waits(self):
        snapshot = self.open_form()
        started = time.perf_counter()
        data = self.call("browser_act", {"steps": [
            {"fill": self.ref(snapshot, '"Jméno"'), "value": "Jana Dvořáková"},
            {"fill": {"label": "E-mail"}, "value": "jana@example.org"},
            {"select": self.ref(snapshot, '"Služba"'), "label": "Stříhání živého plotu"},
            {"check": {"label": "Souhlasím s podmínkami"}},
            {"click": {"role": "button", "name": "Odeslat objednávku"}},
            {"wait_for": {"text": "Objednávka přijata"}},
            {"click": self.ref(snapshot, '"Tlačítko dole"')},
            {"click": self.ref(snapshot, '"Stínové tlačítko"')},
            {"click": self.ref(snapshot, '"Tlačítko v rámci"')},
        ]})
        elapsed = time.perf_counter() - started
        self.assertTrue(data["success"], data)
        self.assertEqual(len(data["done"]), 9)
        self.assertIn('button "Dole kliknuto"', data["snapshot"])
        self.assertIn('button "Stín kliknut"', data["snapshot"])
        self.assertIn('button "Rámec kliknut"', data["snapshot"])
        self.assertRegex(data["snapshot"], r'checkbox "Souhlasím s podmínkami" checked')
        text = self.call("browser_read")["text"]
        self.assertIn("Objednávka přijata: Jana Dvořáková / hedge / podmínky OK", text)
        self.assertLess(elapsed, 10, f"nine steps took {elapsed:.2f}s")
        print(f"\n  9 batched browser steps + snapshot: {elapsed * 1000:.0f} ms")

    def test_a_failing_step_stops_the_batch_and_says_how_to_recover(self):
        self.open_form()
        data = self.call("browser_act", {"steps": [
            {"fill": {"label": "Jméno"}, "value": "X"},
            {"click": {"text": "Neexistující tlačítko"}, "timeout_ms": 300},
            {"click": {"role": "button", "name": "Odeslat objednávku"}},
        ], "snapshot": "none"})
        self.assertFalse(data["success"])
        self.assertEqual(data["failed"]["step"], 2)
        self.assertEqual(data["skipped"], 1)
        self.assertIn("browser_snapshot", data["failed"]["hint"])
        self.assertNotIn("snapshot", data)

    def test_refuses_password_fields_and_keeps_typed_text_out_of_the_audit_log(self):
        snapshot = self.open_form()
        data = self.call("browser_act", {"steps": [{"fill": self.ref(snapshot, '"Heslo"'), "value": "tajne-heslo-123"}]})
        self.assertFalse(data["success"])
        self.assertIn("password", data["failed"]["error"])
        self.call("browser_act", {"steps": [{"fill": {"label": "Jméno"}, "value": "Soukromé jméno"}], "snapshot": "none"})
        log = (_env.TMP / "logs" / "audit.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("tajne-heslo-123", log)
        self.assertNotIn("Soukromé jméno", log)
        self.assertIn("<14 chars>", log)

    def test_stale_and_malformed_refs_are_refused_without_acting(self):
        self.open_form()
        stale = self.call("browser_act", {"steps": [{"click": "e99999"}]})
        self.assertFalse(stale["success"])
        self.assertIn("take a new snapshot", stale["failed"]["error"])
        malformed = self.call("browser_act", {"steps": [{"click": "Odeslat"}]})
        self.assertFalse(malformed["success"])
        self.assertIn("not a snapshot ref", malformed["error"])

    def test_extract_items_tables_and_links_from_the_dom(self):
        self.call("browser_open", {"url": f"{self.base}/catalogue.html"})
        data = self.call("browser_extract", {"items": ".card", "fields": {"name": "h2", "price": ".price", "url": "a@href"}, "tables": True, "links": True, "link_filter": "sluzby"})
        self.assertEqual(data["count"], 3)
        self.assertEqual(data["items"][0], {"name": "Sekání trávy", "price": "450 Kč", "url": f"{self.base}/sluzby/sekani"})
        self.assertEqual(data["tables"][0]["headers"], ["Služba", "Cena"])
        self.assertEqual(data["tables"][0]["rows"], [["Sekání", "450"], ["Plot", "600"]])
        self.assertEqual(len(data["links"]), 3)

    def test_new_tab_from_a_link_becomes_the_current_page(self):
        snapshot = self.open_form()
        data = self.call("browser_act", {"steps": [{"click": self.ref(snapshot, '"Katalog v novém okně"')}, {"wait_for": {"text": "Katalog služeb"}}]})
        self.assertTrue(data["success"], data)
        self.assertIn("Page: Katalog služeb", data["snapshot"])
        tabs = self.call("browser_tabs")["tabs"]
        self.assertGreaterEqual(len(tabs), 2)
        self.assertTrue(next(tab for tab in tabs if tab["current"])["url"].endswith("/catalogue.html"))
        closed = self.call("browser_tabs", {"action": "close", "index": len(tabs) - 1})
        self.assertTrue(closed["success"])

    def test_blocked_domains_and_eval_switch(self):
        blocked = self.call("browser_open", {"url": "https://blocked.invalid/"})
        self.assertFalse(blocked["success"])
        self.assertIn("blocked", blocked["error"])
        refused = self.call("browser_eval", {"expression": "document.title"})
        self.assertFalse(refused["success"])
        self.assertIn("allow_eval", refused["error"])

    def test_web_fetch_reads_markdown_without_a_browser(self):
        data = self.call("web_fetch", {"url": f"{self.base}/catalogue.html", "include_links": True})
        self.assertTrue(data["success"], data)
        self.assertEqual(data["title"], "Katalog služeb")
        self.assertIn("# Katalog služeb", data["markdown"])
        self.assertIn("| Sekání | 450 |", data["markdown"])
        self.assertIn("[Detail](", data["markdown"])
        self.assertNotIn("Patička", data["markdown"], "footer is skipped")
        blocked = self.call("web_fetch", {"url": "https://blocked.invalid/x"})
        self.assertFalse(blocked["success"])


if __name__ == "__main__":
    unittest.main()
