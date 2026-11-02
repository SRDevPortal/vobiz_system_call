import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import frappe
from vobiz_system_call.api import lifecycle, webrtc


class PrivateRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.uuid = "e43bcc5d-3feb-4f3d-900e-b5a2b03c493e"
        self.created = datetime(2026, 11, 2, 13, 56, 19)
        self.context = {"source": "vobiz_system_call", "call_device": "Browser Softphone",
                        "endpoint_username": "agent", "private_browser_route": {
                            "target": "911111115678", "token": "not-logged"}}
        self.row = {"direction": "Outgoing", "call_uuid": None, "recording_call_uuid": self.uuid,
                    "customer_number": "+919999991234", "caller_id": "+911111115678",
                    "creation": self.created}
        self.evidence = {"uuid": self.uuid, "caller_id_number": "sip:agent@registrar.vobiz.ai",
                         "destination_number": "911111115678", "start_time": self.created}
        p = patch.object(lifecycle, "provider_datetime", lambda value: value)
        p.start(); self.addCleanup(p.stop)

    def matches(self):
        self.row["request_json"] = json.dumps(self.context)
        return lifecycle.verified_browser_candidate(self.row, self.evidence)

    def test_private_browser_leg_matches_routing_number(self):
        self.assertTrue(self.matches())
        self.evidence["destination_number"] = self.row["customer_number"]
        self.assertFalse(self.matches())

    def test_legacy_browser_leg_still_requires_customer(self):
        del self.context["private_browser_route"]
        self.assertFalse(self.matches())
        self.evidence["destination_number"] = self.row["customer_number"]
        self.assertTrue(self.matches())

    def test_identity_and_time_checks_remain_required(self):
        for key, value in [("uuid", "different"), ("caller_id_number", "sip:other@registrar.vobiz.ai"),
                           ("start_time", self.created + timedelta(minutes=2))]:
            with self.subTest(key=key):
                original = self.evidence[key]
                self.evidence[key] = value
                self.assertFalse(self.matches())
                self.evidence[key] = original

    def test_corrupt_private_route_fails_closed(self):
        for route in ["invalid", {"target": ""}, {"target": "912222225555"},
                      {"target": "919999991234"}]:
            self.context["private_browser_route"] = route
            self.assertFalse(self.matches())

    def test_rejection_logging_contains_only_reason_and_identifiers(self):
        with patch.object(frappe, "logger") as logger, patch.object(webrtc, "_xml_response", side_effect=lambda x:x):
            response = webrtc._reject_browser_answer("private_route_validation_failed", self.uuid, "CALL-1")
            self.assertIn("Hangup", response)
            entry = logger.return_value.warning.call_args.args[0]
            self.assertEqual(set(entry), {"event", "reason", "call_uuid", "call_log"})
            self.assertEqual(entry["reason"], "private_route_validation_failed")
