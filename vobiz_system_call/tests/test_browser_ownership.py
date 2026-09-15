import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe
from vobiz_system_call.api import lifecycle, ownership, webrtc


class BrowserOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.values, self.expiry = {}, {}
        self.mapping = frappe._dict(name="agent", user="agent", current_call_log="", browser_softphone_enabled=1)
        self.cache = MagicMock()
        self.cache.lock.side_effect = lambda *a, **kw: nullcontext()
        self.cache.get_value.side_effect = lambda key, **kwargs: self.get(key)
        self.cache.set_value.side_effect = self.set
        self.cache.delete_value.side_effect = lambda key: self.values.pop(key, None)
        self.mock(frappe, "local", SimpleNamespace(flags=frappe._dict(in_test=False), request=None))
        self.mock(frappe, "session", SimpleNamespace(user="agent"))
        self.mock(frappe, "db", MagicMock())
        self.mock(frappe, "cache", lambda: self.cache)
        self.mock(frappe, "throw", lambda msg: (_ for _ in ()).throw(ValueError(msg)))
        self.mock(frappe, "publish_realtime", MagicMock())
        self.mock(ownership, "_", lambda x: x)
        self.mock(webrtc, "_", lambda x: x)
        self.mock(webrtc, "_browser_enabled", lambda: True)
        self.mock(lifecycle, "lock_mapping", MagicMock(return_value=self.mapping))
        self.mock(lifecycle, "presence", lambda user: self.get("vsc:presence:" + user))
        self.mock(lifecycle, "set_presence", lambda user, tab: self.set("vsc:presence:" + user, tab, expires_in_sec=65))
        self.mock(ownership.time, "time", lambda: self.now)

    def mock(self, obj, name, value):
        p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        return value

    def get(self, key):
        return self.values.get(key) if self.expiry.get(key, float("inf")) > self.now else None

    def set(self, key, value, expires_in_sec=None):
        self.values[key] = value
        self.expiry[key] = self.now + expires_in_sec if expires_in_sec else float("inf")

    def request_switch(self):
        ownership.presence_heartbeat("old-window")
        return ownership.use_here("new-window")["transfer_token"]

    def test_second_window_gets_use_here_state_without_claiming(self):
        self.assertTrue(ownership.presence_heartbeat("old-window")["registered"])
        self.assertEqual(ownership.presence_heartbeat("new-window")["ownership"], "other_window")
        self.assertEqual(lifecycle.presence("agent"), "old-window")

    def test_owner_refresh_renews_same_identity_without_explicit_switch(self):
        ownership.presence_heartbeat("old-window")
        self.now += 100  # A reload may outlive the short presence lease.
        self.assertIsNone(lifecycle.presence("agent"))
        self.assertEqual(ownership.presence_heartbeat("old-window")["ownership"], "granted")
        self.assertIsNone(self.get(ownership.transfer_key("agent")))
        self.mapping.current_call_log = "unresolved-call"
        self.assertTrue(ownership.presence_heartbeat("old-window")["registered"])
        self.assertEqual(self.mapping.current_call_log, "unresolved-call")

    def test_previous_owner_refresh_cannot_reclaim_after_switch_or_lease_expiry(self):
        token = self.request_switch()
        ownership.release_for_switch("old-window", token)
        self.now += 100
        self.assertEqual(ownership.presence_heartbeat("old-window")["ownership"], "other_window")
        self.assertEqual(ownership.presence_heartbeat("new-window")["ownership"], "granted")
        self.assertEqual(self.get(ownership.owner_key("agent")), "new-window")

    def test_switch_waits_for_logout_then_fences_old_heartbeats(self):
        token = self.request_switch()
        self.assertIsNone(lifecycle.presence("agent"))  # No routing or call starts during transfer.
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "waiting")
        self.assertEqual(ownership.switch_status("old-window", token)["ownership"], "release_requested")
        ownership.release_for_switch("old-window", token)
        self.assertEqual(lifecycle.presence("agent"), "new-window")
        self.assertEqual(ownership.presence_heartbeat("old-window")["ownership"], "other_window")
        ownership.presence_heartbeat("old-window", registered=0)
        self.assertEqual(lifecycle.presence("agent"), "new-window")
        self.assertTrue(ownership.use_here("new-window", token)["registered"])

    def test_active_or_unresolved_mapping_blocks_all_switches_without_changes(self):
        ownership.presence_heartbeat("old-window")
        before = dict(self.values)
        self.mapping.current_call_log = "RINGING-OR-PENDING-CALL"
        self.assertEqual(ownership.use_here("new-window")["ownership"], "active_call")
        self.assertEqual(self.values, before)
        self.assertTrue(ownership.presence_heartbeat("old-window")["registered"])

    def test_expired_presence_never_overrides_an_unresolved_call(self):
        ownership.presence_heartbeat("old-window")
        self.now += 66
        self.mapping.current_call_log = "CALL"
        self.assertEqual(ownership.use_here("new-window")["ownership"], "active_call")

    def test_sdk_busy_rejection_restores_old_owner(self):
        token = self.request_switch()
        self.assertEqual(ownership.release_for_switch("old-window", token, busy=1)["ownership"], "active_call")
        self.assertEqual(lifecycle.presence("agent"), "old-window")
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "expired")

    def test_call_appearing_during_transfer_blocks_ack_and_poll(self):
        token = self.request_switch()
        self.mapping.current_call_log = "CALL"
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "active_call")
        self.assertEqual(ownership.release_for_switch("old-window", token)["ownership"], "active_call")
        self.assertEqual(lifecycle.presence("agent"), "old-window")

    def test_unreachable_idle_window_requires_full_lease_expiry(self):
        token = self.request_switch()
        self.now += 64
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "waiting")
        self.now += 2
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "granted")

    def test_responding_old_window_cannot_be_evicted_by_timeout(self):
        token = self.request_switch()
        self.now += 60
        state = ownership.presence_heartbeat("old-window")
        self.assertEqual(state["ownership"], "release_requested")
        self.assertEqual(state["transfer_token"], token)
        self.now += 10
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "waiting")

    def test_latest_explicit_window_replaces_pending_switch_but_wrong_tokens_cannot(self):
        token = self.request_switch()
        self.assertEqual(ownership.use_here("third-window")["ownership"], "waiting")
        self.assertEqual(ownership.release_for_switch("third-window", token)["ownership"], "expired")
        self.assertEqual(ownership.release_for_switch("old-window", "wrong-token")["ownership"], "expired")
        self.assertEqual(ownership.use_here("new-window", "wrong-token")["ownership"], "superseded")

    def test_stale_events_cannot_release_new_owner(self):
        token = self.request_switch()
        ownership.release_for_switch("old-window", token)
        self.assertEqual(ownership.switch_status("old-window", token)["ownership"], "expired")
        self.assertEqual(ownership.release_for_switch("old-window", token)["ownership"], "expired")
        self.assertEqual(lifecycle.presence("agent"), "new-window")

    def test_refreshed_requester_can_replace_abandoned_switch_without_bypassing_logout(self):
        token = self.request_switch()
        self.now += 16
        replacement = ownership.use_here("refreshed-window")
        self.assertEqual(replacement["ownership"], "waiting")
        self.assertEqual(replacement["old_tab"], "old-window")
        self.assertNotEqual(replacement["transfer_token"], token)
        self.assertEqual(ownership.release_for_switch("old-window", token)["ownership"], "expired")
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "superseded")
        self.assertIsNone(lifecycle.presence("agent"))
        ownership.release_for_switch("old-window", replacement["transfer_token"])
        self.assertEqual(lifecycle.presence("agent"), "refreshed-window")

    def test_live_requester_poll_cannot_override_a_later_explicit_click(self):
        token = self.request_switch()
        self.now += 14
        ownership.use_here("new-window", token)
        self.now += 10
        latest = ownership.use_here("third-window")
        self.assertEqual(latest["ownership"], "waiting")
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "superseded")
        self.assertIsNone(lifecycle.presence("agent"))
        ownership.release_for_switch("old-window", latest["transfer_token"])
        self.assertEqual(lifecycle.presence("agent"), "third-window")

    def test_owner_can_explicitly_cancel_pending_switch_without_waiting(self):
        token = self.request_switch()
        self.assertEqual(ownership.use_here("old-window")["ownership"], "granted")
        self.assertEqual(ownership.release_for_switch("old-window", token)["ownership"], "expired")
        self.assertEqual(ownership.use_here("new-window", token)["ownership"], "expired")
        self.assertEqual(lifecycle.presence("agent"), "old-window")

    def test_repeated_explicit_clicks_have_one_winner_and_cannot_bypass_active_call(self):
        self.request_switch()
        attempts = [(tab, ownership.use_here(tab)["transfer_token"])
                    for tab in ("window-111", "window-222", "window-333")]
        for tab, token in attempts[:-1]:
            self.assertEqual(ownership.use_here(tab, token)["ownership"], "superseded")
            self.assertEqual(ownership.release_for_switch("old-window", token)["ownership"], "expired")
        self.mapping.current_call_log = "CALL"
        self.assertEqual(ownership.use_here("window-444")["ownership"], "active_call")
        self.assertEqual(ownership.release_for_switch("old-window", attempts[-1][1])["ownership"], "active_call")
        self.assertEqual(lifecycle.presence("agent"), "old-window")

    def test_suspended_old_window_never_automatically_reclaims_expired_new_lease(self):
        token = self.request_switch()
        ownership.release_for_switch("old-window", token)
        self.now += 66
        self.assertEqual(ownership.presence_heartbeat("old-window")["ownership"], "other_window")
        self.assertEqual(ownership.use_here("old-window")["ownership"], "granted")

    def test_fresh_connection_recovers_expired_idle_owner_but_heartbeat_does_not(self):
        ownership.presence_heartbeat("closed-window")
        self.now += 66
        self.assertEqual(ownership.presence_heartbeat("only-window")["ownership"], "other_window")
        self.assertEqual(ownership.presence_heartbeat("only-window", claim_idle=1)["ownership"], "granted")
        self.assertEqual(self.get(ownership.owner_key("agent")), "only-window")
        self.assertEqual(ownership.presence_heartbeat("second-window", claim_idle=1)["ownership"], "other_window")

    def test_fresh_connection_cannot_replace_live_presence_or_unresolved_call(self):
        ownership.presence_heartbeat("live-window")
        self.assertEqual(ownership.presence_heartbeat("new-window", claim_idle=1)["ownership"], "other_window")
        self.now += 66
        self.mapping.current_call_log = "CALL"
        self.assertEqual(ownership.presence_heartbeat("new-window", claim_idle=1)["ownership"], "other_window")
        self.assertEqual(self.get(ownership.owner_key("agent")), "live-window")

    def test_selected_window_reload_finishes_abandoned_transfer_after_lease_expiry(self):
        token = self.request_switch()
        self.assertFalse(ownership.presence_heartbeat("new-window", claim_idle=1)["registered"])
        self.now += 66
        self.assertFalse(ownership.presence_heartbeat("third-window", claim_idle=1)["registered"])
        self.assertTrue(ownership.presence_heartbeat("new-window", claim_idle=1)["registered"])
        self.assertEqual(ownership.release_for_switch("old-window", token)["ownership"], "expired")

    def test_selected_window_reload_does_not_release_an_active_call(self):
        self.request_switch()
        self.now += 66
        self.mapping.current_call_log = "CALL"
        self.assertFalse(ownership.presence_heartbeat("new-window", claim_idle=1)["registered"])
        self.assertEqual(self.mapping.current_call_log, "CALL")

    def test_guest_disabled_and_invalid_window_are_rejected(self):
        frappe.session.user = "Guest"
        with self.assertRaises(ValueError): ownership.use_here("new-window")
        frappe.session.user = "agent"
        with self.assertRaises(ValueError): ownership.use_here("bad")
        self.mapping.browser_softphone_enabled = 0
        with self.assertRaises(ValueError): ownership.use_here("new-window")

    def test_no_owner_with_active_call_cannot_be_claimed_after_cache_loss(self):
        self.mapping.current_call_log = "CALL"
        self.assertEqual(ownership.presence_heartbeat("new-window")["ownership"], "active_call")
        self.assertIsNone(lifecycle.presence("agent"))

    def test_ownership_events_are_private_and_published_after_commit(self):
        ownership.use_here("new-window")
        self.assertEqual(frappe.publish_realtime.call_args.kwargs, {"user": "agent", "after_commit": True})
        lifecycle.lock_mapping.assert_called_once_with("agent")
        frappe.db.commit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
