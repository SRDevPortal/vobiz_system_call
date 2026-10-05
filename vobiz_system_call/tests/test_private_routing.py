"""Private outbound routing checks; no SDK or provider call is issued."""
import json
import unittest
from unittest.mock import patch, MagicMock

import frappe
from vobiz_system_call.api import private_routing as private, settings, webrtc, lifecycle, conference


class PrivateRoutingTests(unittest.TestCase):
    def setUp(self):
        self.customer = "+919999991234"
        self.caller_id = "+911111115678"
        self.row = frappe._dict(name="CALL-PRIVATE", user="agent@test.invalid", direction="Outgoing",
            customer_number=self.customer, caller_id=self.caller_id, status="Initiated",
            call_uuid="", call_status="", request_json=json.dumps({
                "source": "vobiz_system_call", "call_device": "Browser Softphone",
                **private.prepare(self.caller_id, self.customer)}))
        self.patch(private.number_privacy, "restricted", lambda user=None: True)

    def patch(self, obj, name, value):
        p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        return value

    def test_checkbox_selects_browser_and_unchecked_uses_default(self):
        config = frappe._dict(agent_call_device="Mobile Bridge")
        self.assertEqual(settings.get_call_device(config, {
            "browser_softphone_enabled": 1, "agent_call_device": "Use Default"}), "Browser Softphone")
        self.assertEqual(settings.get_call_device(config, {
            "browser_softphone_enabled": 0, "agent_call_device": "Browser Softphone"}), "Mobile Bridge")

    def test_browser_payload_contains_no_real_customer_number(self):
        result = private.browser_payload(self.row)
        self.assertNotIn(self.customer.lstrip("+"), json.dumps(result))
        self.assertEqual(result["destination"], self.caller_id.lstrip("+"))
        self.assertTrue(result["private_browser_call"])
        self.assertEqual(self.row.customer_number, self.customer)

    def test_token_wrong_target_or_other_call_rejected(self):
        result = private.browser_payload(self.row)
        self.assertTrue(private.matches(self.row, result["destination"], result["conference_headers"]))
        self.assertFalse(private.matches(self.row, self.customer, result["conference_headers"]))
        self.assertFalse(private.matches(self.row, result["destination"], {}))
        other = frappe._dict(self.row)
        other.request_json = json.dumps(private.prepare(self.caller_id, self.customer))
        self.assertFalse(private.matches(other, result["destination"], result["conference_headers"]))
        self.assertTrue(private.matches(self.row, result["destination"], {
            "sip_header_X-VH-Private": private.state(self.row)["token"]}))

    def test_restricted_legacy_call_cannot_return_raw_destination(self):
        self.row.request_json = "{}"
        with self.assertRaises(frappe.PermissionError):private.browser_payload(self.row)
        self.patch(private.number_privacy, "restricted", lambda user=None: False)
        self.assertEqual(private.browser_payload(self.row)["destination"], self.customer)

    def test_route_cannot_be_the_customer_number(self):
        with self.assertRaises(frappe.ValidationError):private.prepare(self.customer, self.customer)
        with self.assertRaises(frappe.ValidationError):private.prepare("", self.customer)

    def test_recovery_join_preserves_private_target_and_both_tokens(self):
        result = conference.browser_join(self.row, {"generation": 2, "route": "conference-token"})
        self.assertNotIn(self.customer.lstrip("+"), json.dumps(result))
        self.assertEqual(result["conference_headers"]["X-VH-VSC"], "conference-token")
        self.assertTrue(result["conference_headers"][private.HEADER])

    def setup_callback(self):
        self.patch(frappe, "db", MagicMock())
        self.patch(frappe, "get_all", lambda *a, **k: [frappe._dict(user=self.row.user)])
        mapping = frappe._dict(browser_softphone_enabled=1, current_call_log=self.row.name)
        mapping.as_dict = lambda: dict(mapping)
        self.patch(lifecycle, "lock_mapping", lambda *a: mapping)
        self.patch(lifecycle, "lock_call", lambda *a: (mapping, self.row))
        self.patch(lifecycle, "startup_expired", lambda *a: False)
        self.patch(webrtc, "get_profile_endpoint_uri", lambda *a: "sip:agent@registrar.vobiz.ai")
        self.patch(webrtc, "_provider_uuid", lambda *a: "provider-uuid")
        self.patch(webrtc, "_append_callback_if_enabled", MagicMock())
        self.patch(webrtc, "_xml_response", lambda x: x)
        self.patch(webrtc, "_hangup_xml", lambda: "HANGUP")
        return self.patch(webrtc, "_dial_number_xml", MagicMock(return_value="SERVER-DIAL"))

    def test_authenticated_callback_resolves_customer_only_on_server(self):
        dial = self.setup_callback()
        browser = private.browser_payload(self.row)
        result = webrtc._answer_sdk_outbound("sip:agent@registrar.vobiz.ai",
            browser["destination"], browser["conference_headers"])
        self.assertEqual(result, "SERVER-DIAL")
        self.assertEqual(dial.call_args.args[0], webrtc._number(self.customer))
        self.assertEqual(dial.call_count, 1)

    def test_missing_or_invalid_token_never_dials_customer(self):
        dial = self.setup_callback()
        for payload in ({}, {private.HEADER: "wrong"}):
            self.assertEqual(webrtc._answer_sdk_outbound("sip:agent@registrar.vobiz.ai",
                self.caller_id, payload), "HANGUP")
        dial.assert_not_called()

    def test_other_sip_endpoint_cannot_use_valid_private_token(self):
        dial = self.setup_callback()
        browser = private.browser_payload(self.row)
        self.assertEqual(webrtc._answer_sdk_outbound("sip:other@registrar.vobiz.ai",
            browser["destination"], browser["conference_headers"]), "HANGUP")
        dial.assert_not_called()

    def test_prepare_call_response_masks_customer_and_persists_private_route(self):
        from vobiz_system_call.api import call
        self.patch(frappe, "db", MagicMock())
        self.patch(call, "get_profile_endpoint_uri", lambda *a: "sip:agent@registrar.vobiz.ai")
        self.patch(call, "get_profile_password", lambda *a: "test-password")
        self.patch(call.core_call, "mark_mapping_busy", MagicMock())
        self.patch(call, "request_reference_sync", MagicMock())
        self.patch(call, "log_vobiz_event", MagicMock())
        self.patch(conference, "enabled", lambda *a: False)
        self.row.reload = lambda: self.row
        frappe.db.set_value.side_effect = lambda dt, name, values, **kw: self.row.update(values)
        result = call.start_browser_softphone_call(call_log=self.row, settings=frappe._dict(),
            mapping={"name": "MAP"}, profile={"name": "MAP", "browser_softphone_enabled": 1,
                "browser_softphone_username": "agent"}, reference_doctype="CRM Lead",
            reference_name="LEAD-1", customer_number=self.customer, raw_customer_number=self.customer,
            user_mobile="+912222225555", caller_id=self.caller_id, call_flow="Agent First")
        self.assertNotIn(self.customer.lstrip("+"), json.dumps(result))
        self.assertTrue(result["browser_softphone"])
        self.assertTrue(result["private_browser_call"])
        self.assertEqual(result["destination"], self.caller_id.lstrip("+"))
        self.assertTrue(private.matches(self.row, result["destination"], result["conference_headers"]))
        self.assertEqual(lifecycle.context(self.row)["customer_number"], self.customer)

    def test_full_visibility_call_preserves_previous_response(self):
        self.row.request_json = "{}"
        self.patch(private.number_privacy, "restricted", lambda user=None: False)
        self.assertEqual(private.browser_payload(self.row),
            {"destination": self.customer, "customer_number": self.customer})
