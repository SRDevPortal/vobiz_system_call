import json
import unittest
from unittest.mock import MagicMock, patch
from types import SimpleNamespace
import frappe
from vobiz_system_call.api import complete_retry as cr, lifecycle


def row(**kw):
    return frappe._dict(dict(name="OLD", user="agent", status="Initiated", direction="Outgoing",
        request_json=json.dumps({"source":"vobiz_system_call", "call_device":"Browser Softphone"}),
        call_uuid="parent", recording_call_uuid=None, b_leg_uuid=None, end_time=None, answer_time=None,
        reference_doctype="CRM Lead", reference_name="LEAD", customer_number="+919999999999") | kw)


class CompleteRetryTests(unittest.TestCase):
    def setUp(self):
        self.db = self.mock(frappe, "db", MagicMock())
        self.mock(frappe, "session", SimpleNamespace(user="agent"))
        self.mock(frappe, "throw", lambda m: (_ for _ in ()).throw(ValueError(m)))
        self.mock(cr, "_", lambda m: m)
        self.mock(frappe.utils, "now", lambda: "2026-11-02 12:00:00")
        self.mock(frappe.utils, "now_datetime", lambda: "2026-11-02 12:00:00")
        self.queue = self.mock(frappe, "enqueue", MagicMock(side_effect=AssertionError("Must not wait on a queue")))
        from vobiz_click_to_call.services import client, realtime
        self.provider = self.mock(client, "VobizClient", MagicMock(side_effect=AssertionError("Must not contact provider")))
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

    def test_active_call_resets_without_provider_queue_or_fabricated_timing(self):
        result=cr.check_completion("OLD")
        self.assertTrue(result["local_reset"]);self.assertTrue(result["retry_allowed"])
        self.assertFalse(result["verified_end"]);self.assertFalse(result["pending_provider"])
        self.assertEqual(result["status"],"Cancelled");self.assertIsNone(result["end_time"])
        writes=self.db.set_value.call_args_list
        self.assertEqual(writes[1].args[2]["current_call_log"],"")
        self.assertEqual(writes[1].args[2]["availability_status"],"Available")
        self.assertEqual(writes[1].args[2]["accept_calls"],1)
        self.assertTrue(json.loads(writes[0].args[2]["request_json"])["agent_cancelled"])
        for field in ("end_time","answer_time","billsec","hangup_cause"):
            self.assertNotIn(field,writes[0].args[2])
        self.provider.assert_not_called();self.queue.assert_not_called()

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
