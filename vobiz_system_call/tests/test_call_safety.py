from __future__ import annotations

import inspect
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe
from vobiz_system_call.api import lifecycle, webrtc, call
from vobiz_system_call import install


def row(**values):
    base = dict(name="CALL-1", user="agent@example.test", status="Connected", call_uuid="",
                answer_time=datetime(2026, 9, 8, 10), end_time=None, creation=datetime(2026, 9, 8, 10),
                reference_doctype="", reference_name="", request_json='{"source":"vobiz_system_call","call_device":"Browser Softphone"}')
    return frappe._dict(base | values)


class BrowserSafetyTests(unittest.TestCase):
    def setUp(self):
        self.patches = []
        self.replace(frappe, "local", SimpleNamespace(flags=frappe._dict(in_test=False), request=None))
        self.replace(frappe.utils, "now", lambda: "2026-09-08 10:05:00")
        self.replace(frappe.utils, "now_datetime", lambda: datetime(2026, 9, 8, 10, 5))
        self.db = self.replace(frappe, "db", MagicMock())
        self.replace(frappe, "session", SimpleNamespace(user="agent@example.test"))
        self.replace(frappe, "form_dict", {})
        self.replace(frappe, "request", None)
        self.replace(frappe, "get_roles", lambda: [])
        self.replace(frappe, "throw", lambda message: (_ for _ in ()).throw(ValueError(message)))
        self.replace(webrtc, "_", lambda value: value)
        self.replace(lifecycle, "_", lambda value: value)
        self.replace(call, "_", lambda value: value)
        self.replace(frappe, "enqueue", MagicMock())
        self.replace(webrtc, "get_settings", lambda: frappe._dict(enabled=1, store_raw_payloads=0))

    def replace(self, obj, name, value):
        p = patch.object(obj, name, value)
        p.start()
        self.addCleanup(p.stop)
        return value

    def test_public_token_fails_closed_and_checks_exact_match(self):
        self.replace(webrtc, "get_inbound_callback_token", lambda *args: "")
        self.assertFalse(webrtc._valid_public_token(None))
        self.replace(webrtc, "get_inbound_callback_token", lambda *args: "a" * 40)
        self.assertFalse(webrtc._valid_public_token("bad"))
        self.assertTrue(webrtc._valid_public_token("a" * 40))

    def test_disabled_answer_never_routes(self):
        self.replace(webrtc, "_valid_public_token", lambda _: True)
        self.replace(webrtc, "_browser_enabled", lambda: False)
        handler = self.replace(webrtc, "_answer_sdk_outbound", MagicMock())
        self.assertEqual(inspect.unwrap(webrtc.answer)("token").status_code, 403)
        handler.assert_not_called()

    def test_disabled_config_does_not_fetch_or_return_secrets(self):
        self.replace(webrtc, "_browser_enabled", lambda: False)
        self.replace(webrtc, "get_system_call_profile", lambda: frappe._dict(name="MAP", browser_softphone_enabled=1))
        self.replace(webrtc, "get_call_device", lambda _: "Mobile Bridge")
        password = self.replace(webrtc, "get_profile_password", MagicMock())
        result = webrtc.get_browser_softphone_config()
        self.assertNotIn("password", result)
        self.assertNotIn("answer_url", result)
        password.assert_not_called()

    def test_outbound_without_known_endpoint_returns_hangup(self):
        self.replace(webrtc, "_number", lambda _: "+911234567890")
        self.replace(frappe, "get_all", lambda *a, **kw: [])
        result = webrtc._answer_sdk_outbound("sip:unknown@registrar", "1234567890", {"CallUUID": "uuid-12345678"})
        self.assertIn("<Hangup", result.get_data(as_text=True))
        self.db.set_value.assert_not_called()

    def test_missing_or_ambiguous_inbound_did_does_not_route(self):
        self.replace(webrtc, "_number", lambda value: value)
        self.replace(frappe, "get_all", lambda *a, **kw: [row(), row(name="OTHER")])
        result = webrtc._answer_pstn_inbound("+911234567890", "+919999999999", {"CallUUID": "uuid-12345678"})
        self.assertIn("<Hangup", result.get_data(as_text=True))
        self.db.set_value.assert_not_called()

    def test_busy_agent_cannot_be_reserved(self):
        mapping = SimpleNamespace(current_call_log="OTHER", availability_status="Available", enabled=1, accept_calls=1)
        mapping.get = lambda name: getattr(mapping, name, None)
        with self.assertRaisesRegex(ValueError, "previous call"):
            lifecycle.assert_available(mapping)

    def test_terminal_status_preserves_every_final_result(self):
        for previous in lifecycle.TERMINAL:
            for event in ("onCallTerminated", "onCallFailed", "hangup"):
                self.assertEqual(lifecycle.terminal_status(previous, event, "busy"), previous)
        self.assertEqual(lifecycle.terminal_status("Connected", "onCallTerminated"), "Completed")
        self.assertEqual(lifecycle.terminal_status("Ringing", "onCallFailed", "busy"), "Busy")
        self.assertEqual(lifecycle.terminal_status("Ringing", "onCallFailed", "timeout"), "No Answer")
        self.assertEqual(lifecycle.terminal_status("Ringing", "onCallTerminated", answered=True), "Completed")

    def test_duplicate_terminal_event_does_not_write_or_release(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(status="Completed")))
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallTerminated")
        self.assertEqual(result["status"], "Completed")
        self.db.set_value.assert_not_called()

    def test_browser_cannot_replace_provider_uuid(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(call_uuid="provider-uuid")))
        webrtc.update_browser_softphone_call("CALL-1", "onCallAnswered", call_uuid="attacker-uuid")
        self.assertNotIn("call_uuid", self.db.set_value.call_args.args[2])

    def test_end_with_provider_uuid_retains_reservation_for_reconciliation(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(call_uuid="provider-uuid")))
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        enqueue = self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallTerminated")
        self.assertEqual(result["status"], "Connected")
        finish.assert_not_called()
        enqueue.assert_called_once_with("CALL-1")

    def test_cancel_without_uuid_closes_before_callback_can_route(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(status="Initiated", answer_time=None)))
        finish = self.replace(lifecycle, "finish_locked", MagicMock(return_value="Cancelled"))
        result = webrtc.cancel_browser_call("CALL-1")
        self.assertEqual(result["status"], "Cancelled")
        finish.assert_called_once()
        self.db.commit.assert_called()

    def test_foreign_call_cannot_be_updated(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(user="someone-else")))
        with self.assertRaisesRegex(ValueError, "Not permitted"):
            webrtc.update_browser_softphone_call("CALL-1", "onCallTerminated")
        self.db.set_value.assert_not_called()

    def test_callback_job_arguments_bind_to_actual_worker(self):
        self.replace(webrtc, "get_settings", lambda: frappe._dict(store_raw_payloads=1))
        webrtc._append_callback_if_enabled("CALL-1", "answer", {"token": "secret", "cmd": "method", "CallUUID": "uuid"})
        args = frappe.enqueue.call_args.kwargs
        self.assertNotIn("kwargs", args)
        self.assertNotIn("token", args["payload"])
        from vobiz_ai.api.call_log import append_callback
        inspect.signature(append_callback).bind(**{k: args[k] for k in ("call_log", "event", "payload")})
        self.assertTrue(args["enqueue_after_commit"])

    def test_per_call_token_is_bound_to_id_and_not_stored_callback_token(self):
        self.replace(webrtc, "get_inbound_callback_token", lambda: "provider-secret")
        a = webrtc._provider_call_token(row(call_uuid="uuid-1"))
        b = webrtc._provider_call_token(row(call_uuid="uuid-2"))
        self.assertNotEqual(a, b)
        self.assertEqual(len(a), 64)

    def test_legacy_cleanup_is_non_destructive(self):
        delete = self.replace(frappe, "delete_doc", MagicMock())
        install.cleanup_standalone_ui()
        delete.assert_not_called()

    def test_expired_unissued_call_is_recovered_without_provider_request(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(creation=datetime(2000, 1, 1), answer_time=None)))
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        lifecycle.reconcile_call("CALL-1")
        finish.assert_called_once()

    def test_cancel_from_core_ui_dispatches_browser_handler(self):
        self.db.get_value.return_value = row()
        cancel = self.replace(webrtc, "cancel_browser_call", MagicMock(return_value={"status": "Cancelled"}))
        call.cancel_call("CALL-1")
        cancel.assert_called_once_with("CALL-1")


    def test_prepared_call_rejects_destination_change_and_uuid_replay(self):
        self.replace(webrtc, "_number", lambda x: x)
        self.replace(frappe, "get_all", lambda *a, **kw: [row()])
        mapping = frappe._dict(user="agent@example.test", browser_softphone_enabled=1, current_call_log="CALL-1")
        mapping.as_dict = lambda: mapping
        self.replace(lifecycle, "lock_mapping", lambda _: mapping)
        self.replace(webrtc, "get_profile_endpoint_uri", lambda _: "sip:agent@registrar")
        self.replace(lifecycle, "lock_call", lambda _: (
            mapping, row(direction="Outgoing", customer_number="+911234567890", call_uuid="original-uuid")
        ))
        response = webrtc._answer_sdk_outbound("sip:agent@registrar", "+919999999999", {"CallUUID": "original-uuid"})
        self.assertIn("<Hangup", response.get_data(as_text=True))
        response = webrtc._answer_sdk_outbound("sip:agent@registrar", "+911234567890", {"CallUUID": "replayed-uuid"})
        self.assertIn("<Hangup", response.get_data(as_text=True))
        self.db.set_value.assert_not_called()

    def test_prepared_call_routes_only_bound_destination(self):
        self.replace(webrtc, "_number", lambda x: x)
        self.replace(frappe, "get_all", lambda *a, **kw: [row()])
        mapping = frappe._dict(user="agent@example.test", browser_softphone_enabled=1, current_call_log="CALL-1")
        mapping.as_dict = lambda: mapping
        self.replace(lifecycle, "lock_mapping", lambda _: mapping)
        self.replace(webrtc, "get_profile_endpoint_uri", lambda _: "sip:agent@registrar")
        self.replace(lifecycle, "lock_call", lambda _: (
            mapping, row(direction="Outgoing", customer_number="+911234567890", call_uuid="", caller_id="+919999999999")
        ))
        self.replace(lifecycle, "startup_expired", lambda _: False)
        xml = self.replace(webrtc, "_dial_number_xml", MagicMock(return_value="<Response/>"))
        response = webrtc._answer_sdk_outbound("sip:agent@registrar", "+911234567890", {"CallUUID": "provider-uuid"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.db.set_value.call_args.args[2]["call_uuid"], "provider-uuid")
        self.assertEqual(xml.call_args.args[0], "+911234567890")

    def test_offline_inbound_agent_is_rejected(self):
        self.replace(webrtc, "_number", lambda x: x)
        self.replace(frappe, "get_all", lambda *a, **kw: [row()])
        self.replace(lifecycle, "lock_mapping", lambda _: row(availability_status="Offline"))
        self.replace(lifecycle, "presence", lambda _: None)
        self.db.exists.return_value = False
        response = webrtc._answer_pstn_inbound("+911234567890", "+919999999999", {"CallUUID": "provider-uuid"})
        self.assertIn("<Hangup", response.get_data(as_text=True))
        self.db.set_value.assert_not_called()

    def test_incoming_link_cannot_fall_back_to_outgoing_call(self):
        self.replace(lifecycle, "presence", lambda _: "registered-tab")
        self.replace(webrtc, "get_system_call_profile", lambda: {"current_call_log": "CALL-1"})
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(direction="Outgoing")))
        with self.assertRaisesRegex(ValueError, "does not match"):
            webrtc.get_incoming_call("+911234567890", "registered-tab")

    def test_provider_cancel_releases_transaction_before_network(self):
        from vobiz_click_to_call.services import client
        events = []
        self.db.commit.side_effect = lambda: events.append("commit")
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(call_uuid="provider-uuid")))
        self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        provider = MagicMock()
        provider.hangup_call.side_effect = lambda _: events.append("network")
        self.replace(client, "VobizClient", lambda _: provider)
        result = webrtc.cancel_browser_call("CALL-1")
        self.assertLess(events.index("commit"), events.index("network"))
        self.assertTrue(result["pending_provider"])

    def test_provider_failure_keeps_mapping_and_queues_reconciliation(self):
        from vobiz_click_to_call.services import client
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(call_uuid="provider-uuid")))
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        enqueue = self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        provider = MagicMock()
        provider.hangup_call.side_effect = RuntimeError("provider unavailable")
        self.replace(client, "VobizClient", lambda _: provider)
        with self.assertRaisesRegex(RuntimeError, "provider unavailable"):
            webrtc.cancel_browser_call("CALL-1")
        finish.assert_not_called()
        enqueue.assert_called_once()

    def test_callback_logging_failure_does_not_abort_transition(self):
        self.replace(webrtc, "get_settings", lambda: frappe._dict(store_raw_payloads=1))
        frappe.enqueue.side_effect = RuntimeError("queue offline")
        self.replace(frappe, "get_traceback", lambda: "queue offline")
        log = self.replace(frappe, "log_error", MagicMock())
        webrtc._append_callback_if_enabled("CALL-1", "answer", {})
        log.assert_called_once()

    def test_cdr_does_not_count_browser_leg_billing_as_customer_answer(self):
        self.assertEqual(lifecycle.provider_outcome({"status": "completed", "billsec": 30}), "No Answer")
        self.assertEqual(lifecycle.provider_outcome({"status": "completed"}, answered=True), "Completed")
        self.assertEqual(lifecycle.provider_outcome({"dial_status": "busy", "billsec": 30}), "Busy")
        self.assertIsNone(lifecycle.provider_outcome({"status": "ringing"}))

    def test_browser_answer_is_not_authoritative_provider_answer(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(status="Ringing", answer_time=None)))
        webrtc.update_browser_softphone_call("CALL-1", "onCallAnswered")
        self.assertNotIn("answer_time", self.db.set_value.call_args.args[2])

    def test_release_preserves_manual_offline_and_does_not_release_new_call(self):
        self.replace(lifecycle, "presence", lambda _: "registered-tab")
        mapping = row(current_call_log="CALL-1", availability_status="Offline", auto_available_after_call=1)
        lifecycle.release_locked(mapping, row())
        self.assertEqual(self.db.set_value.call_args.args[2]["availability_status"], "Offline")
        self.db.set_value.reset_mock()
        mapping.current_call_log = "NEW-CALL"
        lifecycle.release_locked(mapping, row())
        self.db.set_value.assert_not_called()


if __name__ == "__main__":
    unittest.main()
