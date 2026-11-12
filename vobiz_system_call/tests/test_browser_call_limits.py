"""Use isolated Redis, never the site's Redis, for expiry/race regressions."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch
import shutil
import subprocess
import time
import unittest
import uuid

import frappe
import redis
from frappe.utils.redis_wrapper import RedisWrapper
from vobiz_system_call import browser_call_limits as limits


@unittest.skipUnless(shutil.which("redis-server"), "redis-server is required")
class BrowserCallLimitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory(prefix="vobiz-browser-limits-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.socket = str(Path(cls.temp.name) / "redis.sock")
        cls.server = subprocess.Popen([
            "redis-server", "--port", "0", "--unixsocket", cls.socket,
            "--unixsocketperm", "700", "--save", "", "--appendonly", "no",
            "--dir", cls.temp.name, "--loglevel", "warning",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop_server)
        probe = redis.Redis(unix_socket_path=cls.socket)
        cls.addClassCleanup(probe.close)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not Path(cls.socket).exists():
                time.sleep(0.01)
                continue
            try:
                if probe.ping():
                    return
            except redis.ConnectionError:
                time.sleep(0.01)
        raise RuntimeError("Isolated Redis did not start")

    @classmethod
    def stop_server(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait(timeout=5)

    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.cache = RedisWrapper(unix_socket_path=self.socket)
        self.addCleanup(self.cache.close)
        self.site = "browser_limits_" + uuid.uuid4().hex
        def reject(message, exc=ValueError):
            raise exc(message)
        for name, value in {
            "cache": self.cache, "request": SimpleNamespace(method="POST"),
            "local": SimpleNamespace(request_ip="2001:db8::1", flags=frappe._dict(in_test=True)),
            "form_dict": frappe._dict(cmd=limits.COMMAND, call_log="CTC-test"),
            "conf": frappe._dict(db_name=self.site), "throw": reject,
            "_": lambda value: value,
        }.items():
            stack.enter_context(patch.object(frappe, name, value))
        self.handler = limits.browser_verification_rate_limit(lambda: "OK")

    def key(self):
        return self.cache.make_key(
            f"rl:{frappe.form_dict.cmd}:{frappe.local.request_ip}:{frappe.form_dict.call_log}"
        )

    def wait_expired(self, key):
        deadline = time.monotonic() + 3
        while self.cache.execute_command("EXISTS", key) and time.monotonic() < deadline:
            time.sleep(0.002)
        self.assertFalse(self.cache.execute_command("EXISTS", key))

    def test_exact_limit_rejects_thirteenth_and_retains_expiry(self):
        for _ in range(12):
            self.assertEqual(self.handler(), "OK")
        with self.assertRaises(frappe.RateLimitExceededError):
            self.handler()
        self.assertEqual(int(self.cache.get(self.key())), 13)
        self.assertGreater(self.cache.pttl(self.key()), 0)
        self.assertLessEqual(self.cache.pttl(self.key()), 60000)

    def test_observed_stuck_counts_repair_then_recover_after_expiry(self):
        for count in (628, 242):
            with self.subTest(count=count):
                self.cache.set(self.key(), count)
                with self.assertRaises(frappe.RateLimitExceededError):
                    self.handler()
                self.assertEqual(int(self.cache.get(self.key())), count + 1)
                self.assertGreater(self.cache.pttl(self.key()), 0)
                self.assertLessEqual(self.cache.pttl(self.key()), 60000)
                self.cache.pexpire(self.key(), 2)
                self.wait_expired(self.key())
                self.assertEqual(self.handler(), "OK")
                self.assertEqual(int(self.cache.get(self.key())), 1)

    def test_subsecond_expiry_is_not_extended_even_when_rejected(self):
        self.cache.set(self.key(), 12, px=400)
        self.assertEqual(self.cache.ttl(self.key()), 0)
        with self.assertRaises(frappe.RateLimitExceededError):
            self.handler()
        self.assertLessEqual(self.cache.pttl(self.key()), 400)
        self.assertGreaterEqual(self.cache.pttl(self.key()), 0)

    def test_concurrent_requests_allow_exactly_twelve(self):
        def request(_):
            try:
                return self.handler() == "OK"
            except frappe.RateLimitExceededError:
                return False
        with ThreadPoolExecutor(max_workers=16) as pool:
            accepted = list(pool.map(request, range(100)))
        self.assertEqual(sum(accepted), 12)
        self.assertEqual(int(self.cache.get(self.key())), 100)
        self.assertGreater(self.cache.pttl(self.key()), 0)

    def test_concurrent_requests_across_expiry_keep_timer(self):
        self.cache.set(self.key(), 628, px=2)
        def request(index):
            if index % 2:
                time.sleep(0.008)
            try:
                self.handler()
            except frappe.RateLimitExceededError:
                pass
        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(request, range(100)))
        self.assertLess(int(self.cache.get(self.key())), 628)
        self.assertGreater(self.cache.pttl(self.key()), 0)

    def test_ip_call_and_site_isolation_preserve_legacy_ipv6_key(self):
        key = self.key()
        self.cache.set(key, 628)
        with self.assertRaises(frappe.RateLimitExceededError):
            self.handler()
        frappe.form_dict.call_log = "CTC-other"
        self.assertEqual(self.handler(), "OK")
        frappe.form_dict.call_log = "CTC-test"
        frappe.local.request_ip = "2001:db8::2"
        self.assertEqual(self.handler(), "OK")
        frappe.local.request_ip = "2001:db8::1"
        frappe.conf.db_name = self.site + "_other"
        self.assertEqual(self.handler(), "OK")
        self.assertEqual(int(self.cache.get(key)), 629)

    def test_migration_is_scoped_and_idempotent(self):
        from vobiz_system_call.patches.v1_0.repair_browser_verification_counter_expiry import execute
        stuck = self.key()
        healthy = self.cache.make_key(f"rl:{limits.COMMAND}:2001:db8::2:CTC-healthy")
        self.cache.set(stuck, 628)
        self.cache.set(healthy, 3, px=10000)
        excluded = [
            (self.site + "_other|rl:" + limits.COMMAND + ":2001:db8::1:CTC-test").encode(),
            self.cache.make_key(f"rl:{limits.COMMAND}_extra:2001:db8::1:CTC-test"),
            self.cache.make_key("rl:vobiz_system_call.api.webrtc.answer:192.0.2.1"),
            self.cache.make_key("session:test"),
        ]
        for key in excluded:
            self.cache.set(key, 123)
        self.assertEqual(execute(), {"examined": 2, "repaired": 1, "window_seconds": 60})
        self.assertEqual(int(self.cache.get(stuck)), 628)
        self.assertGreater(self.cache.pttl(stuck), 0)
        self.assertLessEqual(self.cache.pttl(healthy), 10000)
        for key in excluded:
            self.assertEqual(self.cache.pttl(key), -1)
        self.assertEqual(execute()["repaired"], 0)

    def test_migration_escapes_site_glob_characters(self):
        frappe.conf.db_name = self.site + "[a]*?"
        self.cache.set(self.key(), 242)
        self.assertEqual(limits.repair_browser_verification_counter_expiry()["repaired"], 1)
        self.assertGreater(self.cache.pttl(self.key()), 0)

    def test_redis_failure_does_not_run_handler(self):
        fn = Mock()
        with patch.object(self.cache, "eval", side_effect=redis.ConnectionError):
            with self.assertRaises(redis.ConnectionError):
                limits.browser_verification_rate_limit(fn)()
        fn.assert_not_called()

    def test_non_http_calls_bypass_counter(self):
        with patch.object(frappe, "request", None):
            self.assertEqual(self.handler(), "OK")
        self.assertIsNone(self.cache.get(self.key()))

    def test_missing_ip_does_not_run_handler(self):
        frappe.local.request_ip = None
        fn = Mock()
        with self.assertRaises(ValueError):
            limits.browser_verification_rate_limit(fn)()
        fn.assert_not_called()

    def test_real_route_still_checks_login_and_ownership(self):
        from vobiz_system_call.api import webrtc
        translation = patch.object(webrtc, "_", lambda value: value)
        translation.start()
        self.addCleanup(translation.stop)
        with patch.object(frappe, "session", frappe._dict(user="Guest")):
            with self.assertRaises(frappe.AuthenticationError):
                webrtc.verify_browser_call("CTC-test")
        row = frappe._dict(user="owner", name="CTC-test", status="Completed")
        with patch.object(frappe, "session", frappe._dict(user="other")), \
                patch.object(frappe, "get_doc", return_value=row), \
                patch.object(frappe, "get_roles", return_value=[]):
            with self.assertRaises(frappe.PermissionError):
                webrtc.verify_browser_call("CTC-test")
        with patch.object(frappe, "session", frappe._dict(user="owner")), \
                patch.object(frappe, "get_doc", return_value=row), \
                patch.object(webrtc.lifecycle, "is_browser_call", return_value=True):
            self.assertEqual(webrtc.verify_browser_call("CTC-test")["provider_state"], "ended")
        with patch.object(frappe, "session", frappe._dict(user="manager")), \
                patch.object(frappe, "get_doc", return_value=row), \
                patch.object(frappe, "get_roles", return_value=["System Manager"]), \
                patch.object(webrtc.lifecycle, "is_browser_call", return_value=True):
            for _ in range(9):
                self.assertEqual(webrtc.verify_browser_call("CTC-test")["provider_state"], "ended")
            with self.assertRaises(frappe.RateLimitExceededError):
                webrtc.verify_browser_call("CTC-test")
        self.assertEqual(int(self.cache.get(self.key())), 13)

    def test_callback_nesting_cannot_bypass_browser_limit(self):
        from vobiz_click_to_call.services.callback_limits import _active
        token = _active.set(True)
        try:
            self.cache.set(self.key(), 12, px=10000)
            with self.assertRaises(frappe.RateLimitExceededError):
                self.handler()
        finally:
            _active.reset(token)
