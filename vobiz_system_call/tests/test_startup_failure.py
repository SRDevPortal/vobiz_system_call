"""Immediate startup recovery must not release an active or newer call."""
import json
import unittest
from unittest.mock import MagicMock, patch

import frappe
from vobiz_system_call.api import lifecycle, startup_failure, webrtc
from vobiz_system_call.tests import test_call_safety as safety

row = safety.row


class StartupClassificationTests(unittest.TestCase):
    def setUp(self):
        self.row = row(status="Initiated", direction="Outgoing", answer_time=None,
                       call_status="browserCallStarted", recording_call_uuid=None)
        self.mapping = frappe._dict(current_call_log=self.row.name)
        self.details = dict(attempt_id=self.row.name, phase="sdk-failure", originator="remote",
                            protocol="SIP", code="403", state="failed", direction="outgoing")

    def confirmed(self):
        return startup_failure.confirmed(self.mapping, self.row, "onCallFailed", self.details, "")

    def test_explicit_sip_rejection_before_establishment_is_confirmed(self):
        self.assertTrue(self.confirmed())

    def test_sdk_rejection_does_not_require_optional_sip_reason_header(self):
        self.details.update(protocol="none", code="-1", state="rejected", sdk_cause="Rejected")
        self.assertTrue(self.confirmed())
        self.details["originator"] = "local"
        self.assertFalse(self.confirmed())

    def test_no_provider_poll_for_pre_dial_failure_or_explicit_sdk_false(self):
        self.row.call_status = "browser-softphone-starting"
        for phase in ("pre-dial", "sdk-declined"):
            self.details = dict(attempt_id=self.row.name, phase=phase)
            self.assertTrue(self.confirmed())
        self.row.call_status = "browserCallStarted"
        self.assertFalse(self.confirmed())

    def test_unknown_network_timeout_and_normal_clearing_are_not_proof(self):
        for protocol, code, origin in [("none", "-1", "remote"), ("Q.850", "16", "remote"),
                                       ("SIP", "408", "remote"), ("SIP", "487", "remote"),
                                       ("none", "11004", "local"), ("SIP", "403", "local")]:
            with self.subTest(protocol=protocol, code=code):
                self.details.update(protocol=protocol, code=code, originator=origin)
                self.assertFalse(self.confirmed())

    def test_provider_routing_or_answer_evidence_prevents_release(self):
        for field, value in [("call_uuid", "provider-parent"), ("b_leg_uuid", "customer-child"),
                             ("answer_time", "2026-11-02 10:00:00"), ("status", "Connected"),
                             ("call_status", "browser-audio-connected")]:
            original = self.row.get(field)
            self.row[field] = value
            self.assertFalse(self.confirmed(), field)
            self.row[field] = original
        data = lifecycle.context(self.row)
        data["browser_session_answered"] = True
        self.row.request_json = json.dumps(data)
        self.assertFalse(self.confirmed())

    def test_current_attempt_id_is_required(self):
        for attempt in ("", "different-call"):
            self.details["attempt_id"] = attempt
            self.assertFalse(self.confirmed())
        self.details["attempt_id"] = self.row.name
        self.mapping.current_call_log = "new-call"
        self.assertFalse(self.confirmed())

    def test_inbound_conference_and_mismatched_sdk_uuid_are_excluded(self):
        self.row.direction = "Incoming"
        self.assertFalse(self.confirmed())
        self.row.direction = "Outgoing"
        self.row.recording_call_uuid = "earlier-uuid"
        self.assertFalse(self.confirmed())
        self.row.recording_call_uuid = None
        data = lifecycle.context(self.row)
        data["conference_recovery"] = {"generation": 1}
        self.row.request_json = json.dumps(data)
        self.assertFalse(self.confirmed())

    def test_malformed_evidence_is_ignored(self):
        for value in (None, [], '[]', '{', 'x' * 2049):
            self.assertEqual(startup_failure.evidence(value), {})


class StartupEndpointTests(unittest.TestCase):
    # Reuse the existing Frappe isolation without inheriting/repeating its tests.
    setUp = safety.BrowserSafetyTests.setUp
    replace = safety.BrowserSafetyTests.replace

    def prepare(self, **values):
        current = row(status="Initiated", direction="Outgoing", answer_time=None,
                      call_status="browserCallStarted", **values)
        self.mapping = frappe._dict(current_call_log=current.name)
        self.replace(lifecycle, "lock_call", lambda _: (self.mapping, current))
        self.finish = self.replace(lifecycle, "finish_locked", MagicMock(return_value="Failed"))
        self.enqueue = self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        return current

    def details(self):
        return json.dumps(dict(attempt_id="CALL-1", phase="sdk-failure", originator="remote",
                               protocol="SIP", code=403, state="failed", direction="outgoing"))

    def test_confirmed_rejection_finishes_immediately_without_provider_lookup(self):
        self.prepare()
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallFailed", failure_evidence=self.details())
        self.assertEqual(result, {"status": "Failed", "pending_provider": False})
        self.finish.assert_called_once()
        self.assertEqual(self.finish.call_args.kwargs["status"], "Failed")
        self.enqueue.assert_not_called()
        self.assertIn('"startup_failure"', self.db.set_value.call_args.args[3])

    def test_normal_clearing_without_details_stays_pending(self):
        self.prepare()
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallFailed", reason="NORMAL_CLEARING")
        self.assertTrue(result["pending_provider"])
        self.finish.assert_not_called()
        self.enqueue.assert_called_once_with("CALL-1")

    def test_provider_answer_arriving_first_prevents_local_release(self):
        self.prepare(call_uuid="provider-parent")
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallFailed", failure_evidence=self.details())
        self.assertTrue(result["pending_provider"])
        self.finish.assert_not_called()

    def test_delayed_old_event_does_not_write_or_release_new_attempt(self):
        self.prepare()
        self.mapping.current_call_log = "CALL-2"
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallFailed", failure_evidence=self.details())
        self.assertEqual(result["ignored"], "superseded-attempt")
        self.finish.assert_not_called()
        self.db.set_value.assert_not_called()

    def test_mislabelled_event_does_not_change_current_attempt(self):
        self.prepare()
        details = json.loads(self.details())
        details["attempt_id"] = "old-call"
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallFailed", failure_evidence=json.dumps(details))
        self.assertEqual(result["ignored"], "different-attempt")
        self.finish.assert_not_called()
        self.db.set_value.assert_not_called()


if __name__ == "__main__":
    unittest.main()
