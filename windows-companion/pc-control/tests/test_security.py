"""Security regressions for the shared engine: requests to refused addresses are never sent.

Two local HTTP servers stand in for the internet and a protected network:
"public" on 127.0.0.1 and "forbidden" on 127.0.0.2, which records every request
it receives. The policy under test allows only 127.0.0.1, so every assertion
"forbidden.hits == []" proves the request was refused before it left, not after.

Browser cases run on a real headless Chromium, in the engine's own browser
(launch) and attached over CDP to a separately started browser that stands in
for the user's own (their tabs must never be closed, cleared or filtered).
"""
import functools
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import _env  # noqa: F401

import pc_engine
from pc_engine import EngineError, UrlPolicy


class Recorder(BaseHTTPRequestHandler):
    routes: dict = {}
    hits: list = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.hits.append((self.path, self.headers.get("Host")))
        status, headers, body = self.routes.get(self.path.split("?")[0], (200, {"Content-Type": "text/html; charset=utf-8"}, b"<title>ok</title>ok"))
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body if isinstance(body, bytes) else body.encode("utf-8"))


def serve(address, routes):
    handler = type("Handler", (Recorder,), {"routes": routes, "hits": []})
    server = ThreadingHTTPServer((address, 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, handler


def html(body, title="page"):
    return (200, {"Content-Type": "text/html; charset=utf-8"}, f"<!doctype html><title>{title}</title>{body}")


def only_public_server(address):
    return str(address) == "127.0.0.1"


class Servers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.forbidden, cls.forbidden_handler = serve("127.0.0.2", {})
        cls.F = f"http://127.0.0.2:{cls.forbidden.server_address[1]}"
        F = cls.F
        cls.public, cls.public_handler = serve("127.0.0.1", {
            "/": html(f"<a id=ok href='/hop'>ok</a> <a id=bad href='/to-forbidden'>bad</a> "
                      f"<button id=pop onclick=\"window.open('/to-forbidden')\">popup</button> "
                      f"<a id=direct href='{F}/direct'>direct</a> <a id=blank href='/hop' target=_blank>new tab</a>", "start"),
            "/hop": (302, {"Location": "/final"}, b""),
            "/final": html("FINAL", "final"),
            "/to-forbidden": (302, {"Location": f"{F}/secret"}, b""),
            "/to-metadata": (302, {"Location": "http://169.254.169.254/latest/meta-data/"}, b""),
            "/late": html(f"<script>setTimeout(() => location.href = '{F}/late', 150)</script>late", "late"),
            "/pixel": html(f"<img src='{F}/pixel.png'>pixel", "pixel"),
            "/text": (200, {"Content-Type": "text/plain"}, b"plain text"),
        })
        cls.P = f"http://127.0.0.1:{cls.public.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        for server in (cls.public, cls.forbidden):
            server.shutdown()
            server.server_close()

    def setUp(self):
        self.forbidden_handler.hits.clear()
        self.public_handler.hits.clear()

    def settings(self, **extra):
        return pc_engine.EngineSettings(policy=UrlPolicy(address_allowed=only_public_server), **extra)

    def assertForbiddenUntouched(self):
        self.assertEqual(self.forbidden_handler.hits, [], "a request reached the forbidden server")


class Policy(unittest.TestCase):
    def test_default_policy_refuses_local_private_link_local_and_odd_urls_without_any_request(self):
        policy = UrlPolicy(resolver=lambda host, port: ["93.184.216.34"])
        policy.check("https://example.com/a")
        for url in ("http://127.0.0.1/", "http://localhost:8080/", "http://router.local/", "http://10.0.0.1/",
                    "http://192.168.1.1/", "http://169.254.169.254/latest/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
                    "http://100.64.0.1/", "http://0.0.0.0/", "https://user:pw@example.com/", "file:///C:/Windows/win.ini",
                    "javascript:alert(1)", "data:text/html,x", "ftp://example.com/"):
            with self.subTest(url=url), self.assertRaises(EngineError):
                policy.check(url)

    def test_a_name_that_resolves_to_any_private_address_is_refused(self):
        policy = UrlPolicy(resolver=lambda host, port: ["93.184.216.34", "10.0.0.5"])
        with self.assertRaises(EngineError) as caught:
            policy.check("https://rebind.example/")
        self.assertIn("non-public", str(caught.exception))

    def test_unresolvable_names_fail_closed(self):
        def nxdomain(host, port):
            raise socket.gaierror("no such name")
        with self.assertRaises(EngineError):
            UrlPolicy(resolver=nxdomain).check("https://nowhere.example/")

    def test_https_only_and_private_network_opt_in(self):
        with self.assertRaises(EngineError):
            UrlPolicy(require_https=True, resolver=lambda h, p: ["93.184.216.34"]).check("http://example.com/")
        private = UrlPolicy(allow_private_network=True)
        self.assertEqual(private.check("http://127.0.0.1:1/"), ["127.0.0.1"])
        with self.assertRaises(EngineError):
            private.check("http://169.254.169.254/")  # link-local / metadata stays refused even then


class FetchWithoutSsrf(Servers):
    def fetch(self, url, policy=None):
        settings = pc_engine.EngineSettings(policy=policy or UrlPolicy(address_allowed=only_public_server))
        return pc_engine.web_fetch(url, settings)

    def test_a_redirect_to_a_forbidden_address_is_refused_before_it_is_requested(self):
        with self.assertRaises(EngineError) as caught:
            self.fetch(self.P + "/to-forbidden")
        self.assertIn("127.0.0.2", str(caught.exception))
        self.assertForbiddenUntouched()
        with self.assertRaises(EngineError):
            self.fetch(self.P + "/to-metadata")

    def test_allowed_redirects_are_followed_and_reported(self):
        result = self.fetch(self.P + "/hop")
        self.assertTrue(result["success"], result)
        self.assertEqual(result["title"], "final")
        self.assertEqual(result["redirects"], [self.P + "/hop"])

    def test_the_connection_goes_to_the_checked_address_only(self):
        # A name is resolved once, checked, and the socket goes to that address:
        # no second lookup a DNS rebinding could change.
        port = self.public.server_address[1]
        resolved = []

        def resolver(host, port_):
            resolved.append(host)
            return ["127.0.0.1"]
        result = self.fetch(f"http://public.test:{port}/final", UrlPolicy(resolver=resolver, address_allowed=only_public_server))
        self.assertTrue(result["success"])
        self.assertEqual(resolved, ["public.test"])
        self.assertEqual(self.public_handler.hits[-1], ("/final", f"public.test:{port}"))
        with self.assertRaises(EngineError):
            self.fetch(f"http://mixed.test:{port}/final", UrlPolicy(resolver=lambda h, p: ["127.0.0.1", "127.0.0.2"], address_allowed=only_public_server))
        self.assertForbiddenUntouched()

    def test_no_downgrade_from_https_to_http(self):
        connections = []

        class FakeHttps:
            def __init__(self, host, port, address, timeout):
                connections.append((host, address))

            def request(self, *args, **kwargs):
                pass

            def getresponse(self):
                class Response:
                    status = 302

                    def getheader(self, name, default=None):
                        return "http://example.com/plain" if name == "Location" else default

                    def read(self, *args):
                        return b""
                return Response()

            def close(self):
                pass
        policy = UrlPolicy(resolver=lambda h, p: ["93.184.216.34"])
        with mock.patch.object(pc_engine, "_PinnedHTTPSConnection", FakeHttps), \
             mock.patch.object(pc_engine, "_PinnedHTTPConnection", side_effect=AssertionError("an http connection was opened")):
            with self.assertRaises(EngineError) as caught:
                pc_engine.web_fetch("https://example.com/start", pc_engine.EngineSettings(policy=policy))
        self.assertIn("HTTPS", str(caught.exception))
        self.assertEqual(len(connections), 1)


@functools.lru_cache(maxsize=1)
def chromium_path():
    """A Chromium to start as the stand-in user browser: the configured one, else Playwright's own."""
    configured = os.environ.get("PC_CONTROL_BROWSER_EXECUTABLE_PATH")
    if configured:
        return configured
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            path = playwright.chromium.executable_path
        return path if os.path.exists(path) else ""
    except Exception:
        return ""


try:
    import playwright  # noqa: F401
    HAVE_PLAYWRIGHT = True
except ImportError:
    HAVE_PLAYWRIGHT = False


@unittest.skipUnless(HAVE_PLAYWRIGHT, "playwright is not installed")
class BrowserGuardLaunched(Servers):
    """The engine's own browser."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.profile = tempfile.mkdtemp(prefix="pc_engine_guard_")
        settings = pc_engine.EngineSettings(mode="launch", channel="chromium", executable_path=chromium_path(), headless=True,
                                            profile_dir=cls.profile, policy=UrlPolicy(address_allowed=only_public_server))
        cls.engine = pc_engine.Engine(settings)
        try:
            cls.engine.call("browser_snapshot")
        except Exception as exc:
            if os.environ.get("PC_CONTROL_REQUIRE_BROWSER"):
                raise
            raise unittest.SkipTest(f"no Chromium: {exc}")

    @classmethod
    def tearDownClass(cls):
        cls.engine.shutdown()
        shutil.rmtree(cls.profile, ignore_errors=True)
        super().tearDownClass()

    def test_opening_a_forbidden_address_sends_nothing(self):
        for url in (self.F + "/direct", self.P + "/to-forbidden", self.P + "/to-metadata"):
            with self.subTest(url=url), self.assertRaises(EngineError):
                self.engine.call("browser_open", {"url": url})
        self.assertForbiddenUntouched()

    def test_a_click_whose_redirect_goes_to_a_forbidden_address_is_refused_before_it_is_sent(self):
        self.engine.call("browser_open", {"url": self.P + "/"})
        result = self.engine.call("browser_act", {"steps": [{"click": {"css": "#bad"}}], "snapshot": "none"})
        self.assertFalse(result["success"])
        self.assertIn("refused before it was sent", result["failed"]["error"])
        self.assertForbiddenUntouched()
        self.assertTrue(result["url"].endswith("/"), "the tab is back on the page it was on")
        direct = self.engine.call("browser_act", {"steps": [{"click": {"css": "#direct"}}], "snapshot": "none"})
        self.assertFalse(direct["success"])
        self.assertForbiddenUntouched()

    def test_allowed_redirect_chains_still_work(self):
        self.engine.call("browser_open", {"url": self.P + "/"})
        result = self.engine.call("browser_act", {"steps": [{"click": {"css": "#ok"}}, {"wait_for": {"text": "FINAL"}}], "snapshot": "none"})
        self.assertTrue(result["success"], result)
        self.assertTrue(result["url"].endswith("/final"))

    def test_a_popup_to_a_forbidden_address_is_refused_and_closed(self):
        self.engine.call("browser_open", {"url": self.P + "/"})
        pages_before = len(self.engine.call("browser_tabs")["tabs"])
        self.engine.call("browser_act", {"steps": [{"click": {"css": "#pop"}}, {"wait_for": {"ms": 600}}], "snapshot": "none"})
        self.assertForbiddenUntouched()
        self.assertEqual(len(self.engine.call("browser_tabs")["tabs"]), pages_before)

    def test_a_late_navigation_by_the_page_itself_is_refused_and_reported(self):
        self.engine.call("browser_open", {"url": self.P + "/late"})
        time.sleep(0.6)
        result = self.engine.call("browser_snapshot")
        self.assertForbiddenUntouched()
        self.assertTrue(result.get("refused_navigations_since_last_call"), result)

    def test_sub_resources_on_forbidden_addresses_are_not_loaded(self):
        result = self.engine.call("browser_open", {"url": self.P + "/pixel"})
        time.sleep(0.3)
        self.assertForbiddenUntouched()
        self.assertTrue(result["success"], "the page itself loads")
        self.assertTrue(any("/pixel.png" in url for url in result.get("refused_subresources", [])), result)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(HAVE_PLAYWRIGHT and chromium_path(), "playwright or a Chromium executable is missing")
class BrowserGuardAttached(Servers):
    """Attached over CDP to a browser that stands in for the user's own Chrome or Edge."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from playwright.sync_api import sync_playwright
        cls.port = free_port()
        cls.profile = tempfile.mkdtemp(prefix="pc_engine_user_")
        cls.browser_process = subprocess.Popen(
            [chromium_path(), "--headless=new", f"--remote-debugging-port={cls.port}", f"--user-data-dir={cls.profile}",
             # As Playwright itself launches Chromium: CI runners (Ubuntu 24 AppArmor) and root refuse its sandbox.
             "--no-sandbox",
             "--no-first-run", "--no-default-browser-check", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        cls.user = sync_playwright().start()  # the "user", driving their own two tabs
        deadline = time.monotonic() + 30
        while True:
            try:
                cls.user_browser = cls.user.chromium.connect_over_cdp(f"http://127.0.0.1:{cls.port}")
                break
            except Exception:
                if cls.browser_process.poll() is not None:
                    raise RuntimeError("the stand-in browser exited: " + cls.browser_process.stderr.read().decode(errors="replace")[-800:])
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.2)
        context = cls.user_browser.contexts[0]
        cls.other_tab = context.pages[0]
        cls.other_tab.goto(cls.P + "/final")
        cls.work_tab = context.new_page()
        cls.work_tab.goto(cls.P + "/")
        settings = pc_engine.EngineSettings(mode="cdp", cdp_endpoint=f"http://127.0.0.1:{cls.port}", manage_tabs_when_attached=False,
                                            policy=UrlPolicy(address_allowed=only_public_server))
        cls.engine = pc_engine.Engine(settings)

    @classmethod
    def tearDownClass(cls):
        cls.engine.shutdown()
        try:
            cls.user_browser.close()
        finally:
            cls.user.stop()
            cls.browser_process.terminate()
            cls.browser_process.wait(10)
            shutil.rmtree(cls.profile, ignore_errors=True)
        super().tearDownClass()

    def use_work_tab(self):
        """Work in the user's tab with the test page, whatever order the browser lists tabs in."""
        tabs = self.engine.call("browser_tabs")["tabs"]
        index = next(tab["index"] for tab in tabs if tab["url"].rstrip("/") == self.P)
        self.engine.call("browser_tabs", {"action": "switch", "index": index})

    def user_tab_urls(self):
        return sorted(page.url for page in self.user_browser.contexts[0].pages)

    def test_refused_navigation_leaves_every_user_tab_open_and_where_it_was(self):
        before = self.user_tab_urls()
        self.use_work_tab()
        result = self.engine.call("browser_act", {"steps": [{"click": {"css": "#bad"}}], "snapshot": "none"})
        self.assertFalse(result["success"])
        self.assertForbiddenUntouched()
        self.assertEqual(self.user_tab_urls(), before, "no user tab was closed, cleared or moved")

    def test_no_tab_is_opened_or_closed_in_the_users_browser(self):
        self.use_work_tab()
        before = self.user_tab_urls()
        result = self.engine.call("browser_act", {"steps": [{"click": {"css": "#blank"}}], "snapshot": "none"})
        self.assertFalse(result["success"])
        self.assertIn("opens a new tab", result["failed"]["error"])
        for action in ({"action": "new"}, {"action": "close", "index": 0}):
            with self.subTest(action=action), self.assertRaises(EngineError):
                self.engine.call("browser_tabs", action)
        self.assertEqual(self.user_tab_urls(), before)

    def test_the_users_other_tabs_are_not_filtered(self):
        # The engine drives work_tab only; the user's own navigation in their other tab is theirs.
        self.use_work_tab()
        self.engine.call("browser_snapshot")
        self.other_tab.goto(self.F + "/user-own-navigation")
        self.assertIn(("/user-own-navigation", f"127.0.0.2:{self.forbidden.server_address[1]}"), self.forbidden_handler.hits)
        self.forbidden_handler.hits.clear()
        self.other_tab.goto(self.P + "/final")

    def test_close_only_disconnects(self):
        before = self.user_tab_urls()
        self.engine.call("browser_snapshot")
        result = self.engine.call("browser_close")
        self.assertTrue(result["disconnected"])
        self.assertEqual(self.user_tab_urls(), before)


if __name__ == "__main__":
    unittest.main()
