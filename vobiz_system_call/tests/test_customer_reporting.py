"""Customer evidence and post-hangup reconciliation, without placing calls."""
import json
import unittest
from contextlib import ExitStack
from datetime import datetime
from unittest.mock import MagicMock, patch

import frappe
from vobiz_system_call.api import customer_reporting, lifecycle, webrtc
from vobiz_click_to_call.services import cdr, recovery_policy, reference_sync, settings


class CustomerReportingTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.db = MagicMock()
        self.stack.enter_context(patch.object(frappe, "db", self.db))
        self.now = datetime(2026, 11, 2, 16, 0, 33)
        self.stack.enter_context(patch.object(frappe.utils, "now_datetime", return_value=self.now))
        self.stack.enter_context(patch.object(frappe.utils, "now", return_value=str(self.now)))
        self.stack.enter_context(patch.object(reference_sync, "request_reference_sync"))
        self.stack.enter_context(patch.object(settings, "get_settings", return_value=frappe._dict(enabled=1, enable_cdr_sync=1)))
        self.row = frappe._dict(name="old", user="agent", status="Ringing", direction="Outgoing",
                                call_uuid="parent-uuid", b_leg_uuid=None, answer_time=None,
                                request_json=json.dumps({"source": "vobiz_system_call", "call_device": "Browser Softphone"}))
        self.mapping = frappe._dict(current_call_log="new")

    def test_answer_captures_customer_once_and_never_copies_rounded_billing(self):
        payload = {"DialBLegUUID": "customer-uuid", "DialBLegBillDuration": "60"}
        self.assertTrue(customer_reporting.capture(self.row, payload, "answered"))
        self.assertEqual(self.row.b_leg_uuid, "customer-uuid")
        self.assertEqual(self.row.answer_time, self.now)
        self.assertNotIn("billsec", self.db.set_value.call_args.args[2])
        self.assertEqual(self.row.cdr_sync_status, "Not Synced")
        self.assertTrue(customer_reporting.capture(self.row, payload, "connected"))
        self.db.set_value.assert_called_once()

    def test_final_callback_recovers_id_when_answer_callback_is_missing(self):
        self.row.status = "Completed"
        self.assertTrue(customer_reporting.capture(self.row, {"DialBLegUUID": "customer-uuid"}, "hangup"))
        self.assertEqual(self.row.b_leg_uuid, "customer-uuid")
        self.assertIsNone(self.row.answer_time)  # REST will supply the actual time.
        self.assertEqual(self.row.status, "Completed")
        self.assertEqual(self.mapping.current_call_log, "new")

    def test_conflicting_parent_and_malformed_uuid_do_not_mutate(self):
        self.row.b_leg_uuid = "customer-uuid"
        for uuid in ("other-customer", "parent-uuid", "bad value"):
            self.assertFalse(customer_reporting.capture(self.row, {"DialBLegUUID": uuid}, "answered"))
        self.db.set_value.assert_not_called()

    def test_inbound_agent_and_conference_legs_are_excluded(self):
        self.row.direction = "Incoming"
        self.assertTrue(customer_reporting.capture(self.row, {"DialBLegUUID": "agent-uuid"}, "answered"))
        self.row.direction = "Outgoing"
        data = json.loads(self.row.request_json)
        data["conference_recovery"] = {"generation": 1}
        self.row.request_json = json.dumps(data)
        self.assertTrue(customer_reporting.capture(self.row, {"DialBLegUUID": "agent-uuid"}, "answered"))
        self.db.set_value.assert_not_called()

    def test_late_duplicate_does_not_reset_synced_report(self):
        self.row.update(status="Completed", b_leg_uuid="customer-uuid", answer_time=self.now, cdr_sync_status="Synced")
        self.assertTrue(customer_reporting.capture(self.row, {"DialBLegUUID": "customer-uuid"}, "answered"))
        self.db.set_value.assert_not_called()

    def test_finished_call_worker_reconciles_after_releasing_locks(self):
        self.row.update(status="Completed", b_leg_uuid="customer-uuid")
        def process(names):
            self.db.commit.assert_called()
            self.assertEqual(names, ["old"])
        with patch.object(lifecycle, "lock_call", return_value=(self.mapping, self.row)), \
                patch.object(lifecycle, "release_locked") as release, \
                patch.object(recovery_policy, "clear"), \
                patch.object(cdr, "process_cdr_batch", side_effect=process) as batch:
            lifecycle._reconcile_call("old")
        release.assert_called_once_with(self.mapping, self.row)
        batch.assert_called_once()

    def test_synced_and_missing_customer_id_do_not_poll(self):
        with patch.object(cdr, "process_cdr_batch") as batch:
            customer_reporting.reconcile_ended(self.row)
            self.row.update(b_leg_uuid="customer-uuid", cdr_sync_status="Synced")
            customer_reporting.reconcile_ended(self.row)
        batch.assert_not_called()

    def test_recovery_lookup_still_uses_parent_for_termination_evidence(self):
        self.row.b_leg_uuid = "customer-uuid"
        provider = MagicMock()
        provider.retrieve_cdr.return_value = {"data": {"uuid": "parent-uuid", "status": "completed"}}
        self.assertEqual(lifecycle.find_recovery_cdr(provider, self.row)["uuid"], "parent-uuid")
        provider.retrieve_cdr.assert_called_once_with("parent-uuid")

    def test_parent_recovery_never_marks_customer_report_synced_or_copies_duration(self):
        self.row.update(status="Completed", b_leg_uuid="customer-uuid")
        parent = {"uuid": "parent-uuid", "status": "completed", "billsec": 90, "duration": 100}
        with patch.object(lifecycle, "lock_call", return_value=(self.mapping, self.row)), \
                patch.object(lifecycle, "finish_locked"), patch.object(recovery_policy, "clear"), \
                patch.object(customer_reporting, "reconcile_ended") as reconcile:
            lifecycle.finish_reconciled_call(dict(self.row), parent)
        self.db.set_value.assert_not_called()
        reconcile.assert_called_once_with(self.row)

    def test_conflicting_authenticated_dial_callback_cannot_change_outcome(self):
        self.row.b_leg_uuid = "customer-uuid"
        self.db.get_value.return_value = self.row
        with patch.object(frappe, "request", None), \
                patch.object(frappe, "local", frappe._dict(request=None, flags=frappe._dict(in_test=False))), \
                patch.object(webrtc, "_provider_call_token", return_value="correct"), \
                patch.object(lifecycle, "lock_call", return_value=(self.mapping, self.row)), \
                patch.object(webrtc, "_request_params", return_value={"DialBLegUUID": "other-customer", "DialStatus": "busy"}), \
                patch.object(lifecycle, "finish_locked") as finish:
            response = webrtc.provider_event("old", "correct")
        self.assertEqual(response.status_code, 200)
        self.db.set_value.assert_not_called()
        finish.assert_not_called()


if __name__ == "__main__":
    unittest.main()
