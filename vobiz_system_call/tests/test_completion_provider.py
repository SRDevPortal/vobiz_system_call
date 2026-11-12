import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import frappe
from vobiz_system_call.api import completion_provider as cp


A = "11111111-1111-1111-1111-111111111111"
B = "22222222-2222-2222-2222-222222222222"
C = "33333333-3333-3333-3333-333333333333"


class CompletionProviderTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 12, 12)
        self.db = self.mock(frappe, "db", MagicMock())
        self.mock(frappe.utils, "now_datetime", lambda: self.now)
        self.mock(frappe.utils, "now", lambda: str(self.now))
        self.row = frappe._dict(name="OLD", user="agent", status="Cancelled", direction="Outgoing",
            call_uuid=A, b_leg_uuid=None, recording_call_uuid=None, completion_provider_status="Pending",
            request_json=json.dumps({"source": "vobiz_system_call", "call_device": "Browser Softphone",
                "manual_local_reset": {"user": "agent"}, cp.KEY: {"version": 1, "requested_at": "now",
                    "attempts": 0, "confirmed_ids": []}}))
        self.mock(frappe, "get_doc", lambda *args, **kwargs: self.row)
        self.provider = MagicMock()
        self.provider.retrieve_cdr.return_value = {}
        self.provider.hangup_call.return_value = {"status_code": 204}
        self.factory = self.mock(cp, "client", MagicMock(return_value=self.provider))
        self.queue = self.mock(frappe, "enqueue", MagicMock())

    def mock(self, obj, name, value):
        p = patch.object(obj, name, value)
        p.start()
        self.addCleanup(p.stop)
        return value

    def edit_state(self, **values):
        data = json.loads(self.row.request_json)
        data[cp.KEY].update(values)
        self.row.request_json = json.dumps(data)

    def test_exact_final_cdr_confirms_without_changing_mapping_outcome_or_billing(self):
        self.provider.retrieve_cdr.return_value = {"data": {"call_uuid": A, "status": "completed", "billsec": 52}}
        cp.verify("OLD")
        self.assertEqual(self.row.completion_provider_status, "Confirmed")
        self.assertIsNone(self.row.completion_provider_due)
        self.assertEqual(cp.state(self.row)["confirmed_ids"], [A])
        self.assertEqual(self.row.status, "Cancelled")
        self.provider.hangup_call.assert_not_called()
        for write in self.db.set_value.call_args_list:
            self.assertEqual(write.args[0:2], ("Vobiz Call Log", "OLD"))
            self.assertEqual(set(write.args[2]), {"request_json", "completion_provider_status", "completion_provider_due"})

    def test_accepted_hangup_missing_call_or_no_cdr_do_not_prove_end(self):
        for response in ({"status_code": 204}, {"call_missing": True}, {"request_deferred": True}):
            with self.subTest(response=response):
                self.provider.hangup_call.return_value = response
                self.edit_state(attempts=0)
                cp.verify("OLD")
                self.assertEqual(self.row.completion_provider_status, "Pending")
                self.assertEqual(cp.state(self.row)["confirmed_ids"], [])
                self.assertGreater(self.row.completion_provider_due, self.now)

    def test_wrong_uuid_or_active_cdr_never_confirms(self):
        for cdr in ({"call_uuid": B, "status": "completed"}, {"call_uuid": A, "status": "in-progress", "end_time": "stale"}):
            self.provider.retrieve_cdr.return_value = {"data": [cdr]}
            cp.verify("OLD")
            self.assertEqual(self.row.completion_provider_status, "Pending")
            self.assertEqual(cp.state(self.row)["confirmed_ids"], [])

    def test_provider_outage_becomes_needs_review_after_bounded_attempts(self):
        self.edit_state(attempts=7)
        self.provider.retrieve_cdr.side_effect = TimeoutError("secret")
        self.provider.hangup_call.side_effect = TimeoutError("secret")
        cp.verify("OLD")
        self.assertEqual(self.row.completion_provider_status, "Needs Review")
        self.assertIsNone(self.row.completion_provider_due)
        self.assertNotIn("secret", self.row.request_json)
        self.factory.reset_mock()
        cp.verify("OLD")
        self.factory.assert_not_called()

    def test_live_sql_lease_skips_duplicate_worker_but_expired_lease_recovers(self):
        self.edit_state(lease_until=str(self.now + timedelta(seconds=150)))
        cp.verify("OLD")
        self.factory.assert_not_called()
        self.now += timedelta(seconds=151)
        cp.verify("OLD")
        self.factory.assert_called_once()

    def test_worker_commits_before_network_and_preserves_callback_changes(self):
        def lookup(uuid):
            self.db.commit.assert_called()
            data = json.loads(self.row.request_json)
            data["late_callback"] = True
            self.row.request_json = json.dumps(data)
            self.row.status = "Completed"
            return {"call_uuid": uuid, "status": "completed"}
        self.provider.retrieve_cdr.side_effect = lookup
        cp.verify("OLD")
        self.assertTrue(json.loads(self.row.request_json)["late_callback"])
        self.assertEqual(self.row.status, "Completed")

    def test_new_target_arriving_during_lookup_remains_pending(self):
        def lookup(uuid):
            self.row.b_leg_uuid = B
            return {"call_uuid": uuid, "status": "completed"}
        self.provider.retrieve_cdr.side_effect = lookup
        cp.verify("OLD")
        self.assertEqual(self.row.completion_provider_status, "Pending")
        self.provider.retrieve_cdr.side_effect = lambda uuid: {"call_uuid": uuid, "status": "completed"}
        cp.verify("OLD")
        self.assertEqual(self.row.completion_provider_status, "Confirmed")
        self.assertEqual(set(cp.state(self.row)["confirmed_ids"]), {A, B})

    def test_sdk_candidate_requires_identity_validation_before_any_hangup(self):
        self.row.call_uuid = None
        self.row.recording_call_uuid = C
        self.provider.retrieve_live_call.return_value = {"call_uuid": C, "status": "live"}
        verified = self.mock(cp.lifecycle, "verified_browser_candidate", MagicMock(return_value=False))
        cp.verify("OLD")
        self.provider.hangup_call.assert_not_called()
        verified.return_value = True
        cp.verify("OLD")
        self.provider.hangup_call.assert_called_once_with(C, allow_missing=True)
        self.assertEqual(self.row.completion_provider_status, "Pending")

    def test_sdk_cdr_requires_identity_even_when_exact_and_final(self):
        self.row.call_uuid = None
        self.row.recording_call_uuid = C
        self.provider.retrieve_cdr.return_value = {"call_uuid": C, "status": "completed"}
        self.mock(cp.lifecycle, "verified_browser_candidate", MagicMock(return_value=False))
        cp.verify("OLD")
        self.assertEqual(self.row.completion_provider_status, "Pending")
        self.assertEqual(cp.state(self.row)["confirmed_ids"], [])
        self.provider.hangup_call.assert_not_called()

    def test_conference_and_customer_legs_are_deduplicated_and_all_checked(self):
        self.row.b_leg_uuid = A
        data = json.loads(self.row.request_json)
        data["conference_recovery"] = {"version": 1, "legs": {"1": {"uuid": B}, "2": {"uuid": C}}}
        self.row.request_json = json.dumps(data)
        self.provider.retrieve_cdr.side_effect = lambda uuid: {"call_uuid": uuid, "status": "completed"}
        cp.verify("OLD")
        self.assertEqual(set(cp.state(self.row)["confirmed_ids"]), {A, B, C})
        self.assertEqual(self.row.completion_provider_status, "Confirmed")
        self.assertEqual(self.provider.retrieve_cdr.call_count, 3)

    def test_missing_ids_remain_unconfirmed_without_provider_mutation(self):
        self.row.call_uuid = None
        cp.verify("OLD")
        self.assertEqual(self.row.completion_provider_status, "Pending")
        self.provider.hangup_call.assert_not_called()
        self.provider.retrieve_cdr.assert_not_called()

    def test_queue_outage_retains_pending_sql_and_next_dispatch_retries(self):
        self.queue.side_effect = ConnectionError
        self.assertFalse(cp.enqueue("OLD"))
        self.assertEqual(self.row.completion_provider_status, "Pending")
        fetch = self.mock(frappe, "get_all", MagicMock(return_value=[frappe._dict(name="OLD")]))
        self.queue.side_effect = None
        self.assertEqual(cp.dispatch_due(), {"examined": 1})
        self.assertEqual(fetch.call_args.kwargs["limit_page_length"], 100)
        self.assertEqual(fetch.call_args.kwargs["filters"]["completion_provider_status"], "Pending")
        self.assertTrue(self.queue.call_args.kwargs["deduplicate"])

    def test_newer_worker_result_cannot_be_overwritten(self):
        def lookup(uuid):
            self.edit_state(attempts=2, last_result="newer_worker")
            return {"call_uuid": uuid, "status": "completed"}
        self.provider.retrieve_cdr.side_effect = lookup
        cp.verify("OLD")
        self.assertEqual(cp.state(self.row)["last_result"], "newer_worker")
        self.assertEqual(self.row.completion_provider_status, "Pending")

    def test_without_button_intent_old_jobs_do_nothing(self):
        self.row.request_json = "{}"
        cp.verify("OLD")
        self.factory.assert_not_called()
        self.db.set_value.assert_not_called()
