"""No real provider calls: verify ordered/late evidence and configuration safety."""
import json
import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import frappe
from vobiz_system_call.api import customer_outcome, lifecycle, settings, webrtc
from vobiz_click_to_call.services import reference_sync


class CustomerOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.db = MagicMock()
        self.stack.enter_context(patch.object(frappe, "db", self.db))
        self.finish = self.stack.enter_context(patch.object(lifecycle, "finish_locked"))
        self.release = self.stack.enter_context(patch.object(lifecycle, "release_locked"))
        self.sync = self.stack.enter_context(patch.object(reference_sync, "request_reference_sync"))
        self.publish = self.stack.enter_context(patch.object(frappe, "publish_realtime"))
        self.row = frappe._dict(name="old", user="agent", direction="Outgoing", status="Cancelled",
                               call_status="terminated", request_json="{}", answer_time=None)
        self.mapping = frappe._dict(current_call_log="new")
        self.payload = {"DialBLegUUID": "customer-uuid", "DialBLegHangupCause": "USER_BUSY",
                        "DialBLegHangupSource": "Carrier", "DialBLegStatus": "hangup"}

    def test_late_busy_refines_cancelled_without_releasing_new_call_or_repeating_popup(self):
        self.assertTrue(customer_outcome.apply(self.mapping, self.row, self.payload, "hangup"))
        values = self.db.set_value.call_args.args[2]
        self.assertEqual(values["status"], "Busy")
        self.assertEqual(values["hangup_cause"], "USER_BUSY")
        self.assertEqual(values["dial_status"], "busy")
        self.assertNotIn("disposition", values)
        self.sync.assert_called_once_with("old")
        self.finish.assert_not_called()
        self.release.assert_not_called()
        self.publish.assert_called_once()
        self.assertEqual(self.publish.call_args.args[0], "vobiz_call_outcome_corrected")
        self.assertTrue(self.publish.call_args.kwargs["after_commit"])
        self.assertEqual(self.mapping.current_call_log, "new")

    def test_busy_first_ends_once_and_duplicate_is_ignored(self):
        self.row.status = "Ringing"
        self.assertTrue(customer_outcome.apply(self.mapping, self.row, self.payload, "hangup"))
        self.finish.assert_called_once()
        self.assertEqual(self.finish.call_args.kwargs["status"], "Busy")
        self.row.status = "Busy"
        self.assertFalse(customer_outcome.apply(self.mapping, self.row, self.payload, "hangup"))
        self.assertEqual(self.finish.call_count, 1)

    def test_redirect_without_b_leg_uuid_still_uses_call_scoped_authenticated_busy(self):
        self.assertTrue(customer_outcome.apply(self.mapping, self.row, {"DialHangupCause": "USER_BUSY"}, "busy"))
        self.assertEqual(self.db.set_value.call_args.args[2]["status"], "Busy")

    def test_incoming_and_conference_results_are_not_customer_dial_results(self):
        self.row.direction = "Incoming"
        self.assertFalse(customer_outcome.apply(self.mapping, self.row, self.payload, "hangup"))
        self.row.direction = "Outgoing"
        self.row.request_json = '{"conference_recovery": {"generation": 1}}'
        self.assertFalse(customer_outcome.apply(self.mapping, self.row, self.payload, "hangup"))
        self.db.set_value.assert_not_called()

    def test_answered_manual_and_other_authoritative_outcomes_are_unchanged(self):
        for status, answered, call_status in [
            ("Completed", None, "terminated"), ("Cancelled", "now", "terminated"),
            ("Failed", None, "provider-cdr"), ("Cancelled", None, "customer-leg-ended"),
        ]:
            with self.subTest(status=status, answered=answered, call_status=call_status):
                self.row.update(status=status, answer_time=answered, call_status=call_status)
                self.assertFalse(customer_outcome.apply(self.mapping, self.row, self.payload, "hangup"))
        self.db.set_value.assert_not_called()

    def test_conflicting_customer_uuid_and_unknown_hangup_are_ignored(self):
        self.row.request_json = json.dumps({"customer_outcome": {"uuid": "different"}})
        self.assertFalse(customer_outcome.apply(self.mapping, self.row, self.payload, "hangup"))
        self.row.request_json = "{}"
        self.assertFalse(customer_outcome.apply(self.mapping, self.row, {}, "hangup"))
        self.db.set_value.assert_not_called()

    def test_invalid_provider_token_never_reaches_outcome_writer(self):
        with patch.object(frappe, "request", None), patch.object(frappe, "local", frappe._dict(request=None, flags=frappe._dict(in_test=False))),              patch.object(webrtc, "_provider_call_token", return_value="correct"),              patch.object(lifecycle, "lock_call") as lock:
            self.db.get_value.return_value = frappe._dict(name="old")
            response = webrtc.provider_event("old", "wrong")
            self.assertEqual(response.status_code, 403)
            lock.assert_not_called()
        self.db.set_value.assert_not_called()


class CallbackSettingsTests(unittest.TestCase):
    def test_defaults_malformed_values_and_independent_endpoint_limits(self):
        with patch.object(frappe, "conf", frappe._dict()):
            self.assertEqual(settings.callback_request_limit("answer"), 600)
            for value in [None, "", "bad", -1, 0, True, "1.5", 60001]:
                frappe.conf.vobiz_answer_requests_per_minute = value
                self.assertEqual(settings.callback_request_limit("answer"), 600, value)
            frappe.conf.vobiz_answer_requests_per_minute = "900"
            self.assertEqual(settings.callback_request_limit("answer"), 900)
            self.assertEqual(settings.callback_request_limit("event"), 600)
            self.assertEqual(settings.callback_request_limit("hangup"), 600)
