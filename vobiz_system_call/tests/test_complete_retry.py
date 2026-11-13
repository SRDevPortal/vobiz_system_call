import json
import unittest
from datetime import datetime
from unittest.mock import MagicMock, patch
from types import SimpleNamespace
import frappe
from vobiz_system_call.api import complete_retry as cr, lifecycle, completion_provider as cp
from vobiz_system_call.tests.call_log_document import call_log_document


def row(**kw):
    return call_log_document(**(dict(name="OLD", user="agent", status="Initiated", direction="Outgoing",
        request_json=json.dumps({"source":"vobiz_system_call", "call_device":"Browser Softphone"}),
        call_uuid="11111111-1111-1111-1111-111111111111", recording_call_uuid=None, b_leg_uuid=None, end_time=None, answer_time=None,
        reference_doctype="CRM Lead", reference_name="LEAD", customer_number="+919999999999") | kw))


class CompleteRetryTests(unittest.TestCase):
    def setUp(self):
        self.db = self.mock(frappe, "db", MagicMock())
        self.mock(frappe, "session", SimpleNamespace(user="agent"))
        self.mock(frappe, "throw", lambda m: (_ for _ in ()).throw(ValueError(m)))
        self.mock(cr, "_", lambda m: m)
        self.mock(frappe.utils, "now", lambda: "2026-11-02 12:00:00")
        self.mock(frappe.utils, "now_datetime", lambda: datetime(2026, 11, 2, 12))
        self.queue = self.mock(frappe, "enqueue", MagicMock())
        from vobiz_click_to_call.services import client, realtime
        self.provider = self.mock(cp, "client", MagicMock())
        self.provider.return_value.hangup_call.return_value = {"status_code": 204}
        self.publish = self.mock(realtime, "publish_call_disconnected", MagicMock())
        self.mapping = frappe._dict(name="MAP",current_call_log="OLD",availability_status="Busy",accept_calls=0)
        self.current = row()
        self.mock(lifecycle, "lock_mapping", lambda user: self.mapping)
        self.mock(frappe, "get_doc", lambda *a, **kw: self.current)

    def mock(self,obj,name,value):
        p=patch.object(obj,name,value);p.start();self.addCleanup(p.stop);return value

    def reset_row(self,**data):
        return row(status="Cancelled",request_json=json.dumps({"source":"vobiz_system_call", "call_device":"Browser Softphone",
                   "manual_local_reset":{"at":"now","user":"agent"}, **data}))

    def test_button_attempts_hangup_then_resets_without_fabricated_timing(self):
        result=cr.check_completion("OLD")
        self.assertTrue(result["local_reset"]);self.assertTrue(result["retry_allowed"])
        self.assertFalse(result["verified_end"]);self.assertFalse(result["pending_provider"])
        self.assertEqual(result["status"],"Cancelled");self.assertIsNone(result["end_time"])
        writes=self.db.set_value.call_args_list
        mapping_write = next(w.args[2] for w in writes if w.args[0] == "Vobiz User Mapping")
        self.assertEqual(mapping_write["current_call_log"],"")
        self.assertEqual(mapping_write["availability_status"],"Available")
        self.assertEqual(mapping_write["accept_calls"],1)
        self.assertTrue(json.loads(writes[0].args[2]["request_json"])["agent_cancelled"])
        for field in ("end_time","answer_time","billsec","hangup_cause"):
            self.assertTrue(all(field not in w.args[2] for w in writes))
        self.provider.return_value.hangup_call.assert_called_once_with(self.current.call_uuid, allow_missing=True)
        self.assertEqual(result["provider_hangup"], "requested")
        self.assertEqual(result["provider_confirmation"], "Pending")
        self.db.after_commit.add.assert_called_once()

    def test_duplicate_reset_keeps_original_audit_and_final_outcome(self):
        cr.check_completion("OLD");data=self.current.request_json
        self.db.set_value.reset_mock();self.mapping.current_call_log=""
        result=cr.check_completion("OLD")
        self.db.set_value.assert_not_called();self.assertEqual(self.current.request_json,data)
        self.assertTrue(result["retry_allowed"])
        self.current=row(status="Busy",end_time="actual-end")
        result=cr.check_completion("OLD")
        self.assertEqual(result["status"],"Busy");self.assertEqual(result["end_time"],"actual-end")

    def test_foreign_or_newer_call_cannot_be_reset(self):
        for foreign in (True,False):
            self.current=row(user="other" if foreign else "agent")
            self.mapping.current_call_log="NEW"
            with self.assertRaises(ValueError):cr.check_completion("OLD")
            self.db.set_value.assert_not_called()

    def test_offline_and_break_choices_are_preserved(self):
        for state in ("Offline","Away","Break"):
            self.current=row();self.mapping.availability_status=state
            cr.check_completion("OLD")
            self.assertEqual(self.db.set_value.call_args.args[2],{"current_call_log":""})

    def test_no_incoming_retry_but_browser_conference_can_be_reset(self):
        self.current.direction="Incoming"
        self.current.request_json=json.dumps({"source":"vobiz_system_call","call_device":"Browser Softphone",
                                              "conference_recovery":{"generation":1}})
        self.assertFalse(cr.check_completion("OLD")["retry_allowed"])

    def test_unreset_call_cannot_use_linked_retry(self):
        with self.assertRaisesRegex(ValueError,"Reset the previous"):
            cr.lock_retry("OLD","CRM Lead","LEAD","+919999999999")

    def test_retry_owner_target_single_use_and_no_chains(self):
        for change,message in [({"user":"other"},"Not permitted"),({"customer_number":"different"},"original customer"),
                               ({"reference_name":"different"},"original customer")]:
            self.current=self.reset_row();self.current.update(change)
            with self.assertRaisesRegex(ValueError,message):cr.lock_retry("OLD","CRM Lead","LEAD","+919999999999")
        for data in ({"retry_call_log":"NEW"},{"retry_of":"ROOT"}):
            self.current=self.reset_row(**data)
            with self.assertRaisesRegex(ValueError,"already been used"):
                cr.lock_retry("OLD","CRM Lead","LEAD","+919999999999")
        self.current=self.reset_row()
        previous=cr.lock_retry("OLD","CRM Lead","LEAD","+919999999999")
        new=row(name="NEW");cr.link_retry(previous,new)
        self.assertEqual(json.loads(new.request_json)["retry_of"],"OLD")
        self.current.request_json=self.db.set_value.call_args.args[3]
        with self.assertRaisesRegex(ValueError,"already been used"):
            cr.lock_retry("OLD","CRM Lead","LEAD","+919999999999")

    def test_old_verification_jobs_do_not_query_provider(self):
        cr.verify_completion("OLD")
        self.provider.assert_not_called();self.db.set_value.assert_not_called()

    def test_provider_timeout_still_releases_agent_and_keeps_pending_record(self):
        self.provider.return_value.hangup_call.side_effect = TimeoutError("secret provider URL")
        result = cr.check_completion("OLD")
        self.assertTrue(result["local_reset"])
        self.assertEqual(result["provider_hangup"], "request_failed")
        self.assertEqual(self.db.set_value.call_args.args[2]["availability_status"], "Available")
        self.assertNotIn("secret", self.current.request_json)

    def test_hangup_runs_after_commit_before_local_cancel(self):
        def hangup(*args, **kwargs):
            self.db.commit.assert_called()
            self.assertEqual(self.current.status, "Initiated")
            self.assertEqual(self.mapping.current_call_log, "OLD")
            return {"status_code": 204}
        self.provider.return_value.hangup_call.side_effect = hangup
        cr.check_completion("OLD")
        self.assertEqual(self.current.status, "Cancelled")

    def test_new_call_during_network_wait_is_never_released(self):
        def hangup(*args, **kwargs):
            self.mapping.current_call_log = "NEW"
            return {"status_code": 204}
        self.provider.return_value.hangup_call.side_effect = hangup
        with self.assertRaisesRegex(ValueError, "Another call"):
            cr.check_completion("OLD")
        self.assertFalse(any(w.args[0] == "Vobiz User Mapping" for w in self.db.set_value.call_args_list))
        self.assertEqual(self.current.status, "Initiated")

    def test_repeated_button_click_does_not_repeat_inline_hangup(self):
        cr.check_completion("OLD")
        cr.check_completion("OLD")
        self.assertEqual(self.provider.return_value.hangup_call.call_count, 1)

    def test_missing_verified_uuid_never_hangs_up_sdk_candidate_blindly(self):
        self.current.call_uuid = None
        self.current.recording_call_uuid = "22222222-2222-2222-2222-222222222222"
        result = cr.check_completion("OLD")
        self.assertTrue(result["local_reset"])
        self.assertEqual(result["provider_hangup"], "missing_verified_id")
        self.provider.assert_not_called()
