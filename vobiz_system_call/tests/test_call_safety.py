from __future__ import annotations

import inspect
import json
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe
from werkzeug.wrappers import Response
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
        self.patient_lookup = webrtc._incoming_patient
        self.replace(webrtc, "_incoming_patient", lambda number: (None, False))
        from vobiz_click_to_call.api import inbound
        self.replace(inbound, "find_incoming_mapping", lambda did: None)
        self.replace(webrtc, "_incoming_lead", lambda number: row(name="LEAD", lead_owner=frappe.session.user))
        self.replace(webrtc, "get_system_call_profile", lambda *args: {"name": "MAP"})
        self.replace(webrtc, "get_settings", lambda: frappe._dict(enabled=1, store_raw_payloads=0, agent_call_device="Browser Softphone"))

    def replace(self, obj, name, value):
        p = patch.object(obj, name, value)
        p.start()
        self.addCleanup(p.stop)
        return value

    def test_agent_device_overrides_default_and_disabled_mode_is_rejected(self):
        from vobiz_system_call.api import settings as devices
        self.replace(devices, "_", lambda value: value)
        settings = frappe._dict(agent_call_device="Browser Softphone", enable_browser_softphone=1, enable_mobile_bridge=1)
        for selection, expected in [("Use Default", "Browser Softphone"), ("Browser Softphone", "Browser Softphone"),
                                    ("Mobile Bridge", "Mobile Bridge"), (None, "Browser Softphone")]:
            self.assertEqual(devices.get_call_device(settings, {"agent_call_device": selection}), expected)
        settings.enable_mobile_bridge = 0
        with self.assertRaises(ValueError):
            devices.assert_device_enabled("Mobile Bridge", settings)
        settings.agent_call_device = "System Dialer"
        self.assertEqual(devices.get_call_device(settings, {}), "System Dialer")

    def test_administrator_is_skipped_before_agent_lookup_or_lock(self):
        lock = self.replace(lifecycle, "lock_mapping", MagicMock())
        profile = self.replace(webrtc, "get_system_call_profile", MagicMock(return_value=None))
        self.assertIsNone(webrtc._select_inbound_agent("Administrator"))
        self.assertIsNone(webrtc._select_inbound_agent(
            "", candidate_users=["Administrator", "agent@example.test"], listed_only=True))
        profile.assert_called_once_with("agent@example.test")
        lock.assert_not_called()

    def test_mobile_incoming_routes_without_browser_presence_and_records_device(self):
        import json
        caller, did, mobile = "+919876545966", "+911234565565", "+911234567890"
        mapping = row(name="MAP", current_call_log="", enabled=1, availability_status="Available",
                      accept_calls=1, agent_mobile=mobile, agent_call_device="Mobile Bridge", browser_softphone_enabled=0)
        mapping.as_dict = lambda: dict(mapping)
        self.replace(webrtc, "_number", lambda value: value)
        self.replace(frappe, "get_all", lambda *a, **kw: [mapping])
        self.replace(lifecycle, "lock_mapping", lambda _: mapping)
        presence = self.replace(lifecycle, "presence", MagicMock(return_value=None))
        self.replace(lifecycle, "assert_available", lambda _: None)
        documents = []
        def make_doc(data):
            incoming = frappe._dict(data, name="INBOUND")
            incoming.insert = lambda **kw: incoming
            documents.append(incoming)
            return incoming
        self.replace(frappe, "get_doc", make_doc)
        from vobiz_click_to_call.api import call as core_call
        self.replace(core_call, "mark_mapping_busy", MagicMock())
        self.replace(webrtc, "_dial_attrs", lambda *args: 'callerId="business"')
        self.replace(webrtc, "provider_phone_number", lambda number: number)
        self.db.exists.return_value = False
        response = webrtc._answer_pstn_inbound(caller, did, {"CallUUID": "provider-mobile"})
        self.assertIn("<Number>" + mobile + "</Number>", response.get_data(as_text=True))
        self.assertNotIn("<User>", response.get_data(as_text=True))
        presence.assert_not_called()
        self.assertTrue(lifecycle.is_managed_call(documents[0]))
        self.assertFalse(lifecycle.is_browser_call(documents[0]))
        self.assertEqual(json.loads(documents[0].request_json)["call_device"], "Mobile Bridge")

    def test_mapping_mode_change_is_rejected_during_active_call(self):
        from vobiz_system_call.api import device
        self.replace(frappe, "flags", frappe._dict())
        self.replace(device, "_", lambda value: value)
        previous = frappe._dict(agent_call_device="Browser Softphone")
        mapping = row(agent_call_device="Mobile Bridge", enabled=1)
        mapping.get_doc_before_save = lambda: previous
        mapping.is_new = lambda: False
        self.db.sql.return_value = [("ACTIVE",)]
        with self.assertRaisesRegex(ValueError, "End the active call"):
            device.validate_mapping(mapping)

    def test_offline_primary_routes_to_fallback_and_cycles_terminate(self):
        from vobiz_click_to_call.services import safety
        self.replace(safety, "get_working_hours_block_reason", lambda _: "")
        primary = row(user="primary", enabled=1, availability_status="Offline", fallback_user="backup", current_call_log="")
        backup = row(user="backup", enabled=1, availability_status="Available", accept_calls=1,
                     current_call_log="", browser_softphone_enabled=1, fallback_user="primary")
        for mapping in (primary, backup):
            mapping.as_dict = lambda m=mapping: dict(m)
        mappings = {"primary": primary, "backup": backup}
        locked = self.replace(lifecycle, "lock_mapping", MagicMock(side_effect=lambda user: mappings[user]))
        self.replace(webrtc, "get_system_call_profile", lambda user: mappings.get(user))
        self.replace(lifecycle, "presence", lambda user: "tab" if user == "backup" else None)
        self.replace(lifecycle, "assert_available", lambda _: None)
        self.replace(webrtc, "get_profile_endpoint_uri", lambda _: "sip:backup@registrar")
        selected = webrtc._select_inbound_agent("primary")
        self.assertEqual(selected[0].user, "backup")
        self.assertEqual(selected[2], "sip:backup@registrar")
        self.assertEqual(locked.call_count, 2)
        locked.reset_mock()
        backup.availability_status = "Offline"
        self.assertIsNone(webrtc._select_inbound_agent("primary"))
        self.assertEqual(locked.call_count, 2)

    def test_fallback_browser_accepts_routed_did_not_its_own_caller_id(self):
        self.replace(lifecycle, "presence", lambda _: "tab")
        self.replace(webrtc, "get_system_call_profile", lambda: {"current_call_log": "IN"})
        self.replace(webrtc, "_number", lambda value: value)
        incoming = row(name="IN", direction="Incoming", status="Ringing", did_number="primary-did",
                       customer_number="customer", request_json='{"source":"vobiz_system_call","call_device":"Browser Softphone","fallback_origin_user":"primary"}')
        mapping = row(current_call_log="IN", caller_id="backup-did")
        self.replace(lifecycle, "lock_call", lambda _: (mapping, incoming))
        self.assertEqual(webrtc.get_incoming_call("primary-did", "tab")["call_log"], "IN")
        with self.assertRaises(ValueError):
            webrtc.get_incoming_call("unrelated-did", "tab")

    def test_patient_route_requires_queue_department_and_followup(self):
        from vobiz_click_to_call.services import safety
        self.replace(safety, "get_working_hours_block_reason", lambda _: "")
        patient = row(sr_medical_department="Kidney", sr_followup_id="7")
        mapping = row(user="mis", enabled=1, availability_status="Available", accept_calls=1,
                      current_call_log="", browser_softphone_enabled=1, queue_source="Patient",
                      sr_medical_departments="Kidney", sr_followup_ids="7")
        mapping.as_dict = lambda: dict(mapping)
        self.replace(lifecycle, "lock_mapping", lambda _: mapping)
        self.replace(webrtc, "get_system_call_profile", lambda _: mapping)
        self.replace(lifecycle, "presence", lambda _: "tab")
        self.replace(lifecycle, "assert_available", lambda _: None)
        self.replace(webrtc, "get_profile_endpoint_uri", lambda _: "sip:mis@registrar")
        self.assertEqual(webrtc._select_inbound_agent("primary", patient, ["mis"])[0].user, "mis")
        for field, value in [("sr_followup_ids", "8"), ("sr_medical_departments", "Liver"), ("queue_source", "CRM Lead")]:
            original = mapping[field]
            mapping[field] = value
            self.assertIsNone(webrtc._select_inbound_agent("primary", patient, ["mis"]))
            mapping[field] = original
        self.assertIsNone(webrtc._select_inbound_agent("mis"))

    def test_patient_lookup_rejects_ambiguous_phone(self):
        self.db.exists.return_value = True
        self.db.sql.return_value = ["vobiz_mobile_last10", "vobiz_phone_last10"]
        self.replace(frappe, "get_all", lambda *args, **kwargs: ["PAT-1", "PAT-2"])
        self.assertEqual(self.patient_lookup("+919876543210"), (None, True))

    def test_patient_lookup_returns_unique_match_from_indexes(self):
        self.db.exists.return_value = True
        self.db.sql.return_value = ["vobiz_mobile_last10", "vobiz_phone_last10"]
        self.replace(frappe, "get_all", lambda *args, **kwargs: ["PAT-1"])
        patient = row(name="PAT-1")
        self.replace(frappe, "get_doc", lambda *args: patient)
        self.assertEqual(self.patient_lookup("+919876543210"), (patient, False))

    def test_unknown_mapping_rotates_enabled_agents(self):
        incoming = frappe._dict(routing_strategy="Round Robin", last_assigned_agent="a", agents=[
            frappe._dict(agent_user="a", enabled=1, priority=1, idx=1),
            frappe._dict(agent_user="disabled", enabled=0, priority=1, idx=2),
            frappe._dict(agent_user="b", enabled=1, priority=1, idx=3),
        ])
        self.assertEqual([r.agent_user for r in webrtc._unknown_incoming_candidates(incoming)], ["b", "a"])

    def test_unknown_caller_uses_mapping_without_unique_did_user(self):
        import json
        from vobiz_click_to_call.api import inbound, call as core_call
        self.replace(webrtc, "_number", lambda value: value)
        self.replace(webrtc, "_incoming_lead", lambda _: None)
        incoming = frappe._dict(name="DID", routing_strategy="Round Robin", agents=[
            frappe._dict(name="ROW", agent_user="listed", enabled=1, priority=1, idx=1)])
        self.replace(inbound, "find_incoming_mapping", lambda _: incoming)
        self.replace(frappe, "get_all", lambda *args, **kwargs: [])
        mapping = row(user="listed", agent_mobile="mobile")
        selector = self.replace(webrtc, "_select_inbound_agent", MagicMock(return_value=(mapping,"Mobile Bridge","mobile")))
        documents=[]
        def make_doc(data):
            doc=frappe._dict(data,name="IN")
            doc.insert=lambda **kwargs: doc
            documents.append(doc)
            return doc
        self.replace(frappe, "get_doc", make_doc)
        self.replace(core_call, "mark_mapping_busy", MagicMock())
        assignment=self.replace(inbound, "update_incoming_assignment", MagicMock())
        creator=self.replace(inbound, "create_unknown_inbound_lead", MagicMock(return_value=row(name="NEW-LEAD")))
        self.replace(webrtc, "_dial_agent_xml", lambda *args: "<Response/>")
        self.db.exists.return_value=False
        webrtc._answer_pstn_inbound("customer","did",{"CallUUID":"provider-uuid"})
        selector.assert_called_once_with("",candidate_users=["listed"],listed_only=True)
        self.assertEqual(json.loads(documents[0].request_json)["incoming_mapping"],"DID")
        assignment.assert_called_once_with(incoming,{"user":"listed","agent_row":"ROW"})
        creator.assert_called_once_with("customer", "did", incoming, {"user": "listed"})
        self.assertEqual(documents[0].reference_doctype, "CRM Lead")
        self.assertEqual(documents[0].reference_name, "NEW-LEAD")
        self.assertEqual(documents[0].crm_lead, "NEW-LEAD")
        self.db.exists.return_value=True
        mapping.current_call_log="IN"
        self.replace(lifecycle,"lock_call",lambda _: (mapping,documents[0]))
        webrtc._answer_pstn_inbound("customer","did",{"CallUUID":"provider-uuid"})
        self.assertEqual(creator.call_count,1)
        self.assertEqual(assignment.call_count,1)

    def test_listed_agents_do_not_escape_to_unlisted_fallback(self):
        from vobiz_click_to_call.api import console
        mapping=row(user="listed",enabled=1,availability_status="Offline",accept_calls=0,
                    current_call_log="",fallback_user="unlisted")
        mapping.as_dict=lambda: dict(mapping)
        self.replace(lifecycle,"lock_mapping",MagicMock(return_value=mapping))
        self.replace(console,"is_agent_console_online",lambda _:False)
        self.assertIsNone(webrtc._select_inbound_agent("",candidate_users=["listed"],listed_only=True))
        lifecycle.lock_mapping.assert_called_once_with("listed")

    def test_incoming_action_does_not_retry_cancelled_or_answered_calls(self):
        from contextlib import nullcontext
        self.replace(frappe,"cache",lambda: SimpleNamespace(lock=lambda *args,**kwargs:nullcontext()))
        self.replace(webrtc,"_provider_call_token",lambda _:"secret")
        retry=self.replace(webrtc,"_retry_incoming_agent",MagicMock())
        event=self.replace(webrtc,"provider_event",MagicMock())
        self.db.get_value.side_effect=[row(),'{"agent_cancelled":true}']
        inspect.unwrap(webrtc.incoming_action)("CALL-1","secret")
        retry.assert_not_called()
        event.assert_not_called()
        self.db.get_value.side_effect=[row(),'{}']
        self.replace(frappe,"get_doc",lambda *args:row(direction="Incoming",status="Completed"))
        self.replace(webrtc,"_request_params",lambda:{"DialStatus":"no-answer"})
        inspect.unwrap(webrtc.incoming_action)("CALL-1","secret")
        retry.assert_not_called()

    def test_unanswered_fallback_creates_separate_attempt(self):
        import json
        from vobiz_click_to_call.api import call as core_call
        original=row(direction="Incoming",status="No Answer",answer_time=None,customer_number="caller",did_number="did",
                     request_json='{"source":"vobiz_system_call","call_device":"Browser Softphone"}')
        mapping=row(user="backup",agent_mobile="mobile")
        self.replace(webrtc,"get_system_call_profile",lambda _: {"fallback_user":"backup"})
        selector=self.replace(webrtc,"_select_inbound_agent",MagicMock(return_value=(mapping,"Mobile Bridge","mobile")))
        created=[]
        def make_doc(data):
            child=frappe._dict(data,name="CHILD")
            child.insert=lambda **kwargs:child
            created.append(child)
            return child
        self.replace(frappe,"get_doc",make_doc)
        self.replace(core_call,"mark_mapping_busy",MagicMock())
        self.replace(webrtc,"_dial_agent_xml",lambda *args:"<Response/>")
        webrtc._retry_incoming_agent(original)
        self.assertEqual(created[0].user,"backup")
        self.assertEqual(created[0].call_uuid,original.call_uuid)
        child_context=json.loads(created[0].request_json)
        self.assertEqual(child_context["previous_call_log"],original.name)
        self.assertEqual(child_context["attempted_users"],[original.user,"backup"])
        self.assertTrue(child_context["incoming_mobile_bridge"])
        self.assertEqual(selector.call_args.kwargs["excluded_users"],[original.user])
        core_call.mark_mapping_busy.assert_called_once_with(mapping.name,"CHILD")

    def test_inbound_sip_leg_presents_business_did_on_first_route_and_retry(self):
        caller, did = "+919876545966", "+911234565565"
        mapping = row(name="MAP", current_call_log="", availability_status="Available",
                      accept_calls=1, browser_softphone_enabled=1, agent_mobile="+911234567890")
        mapping.as_dict = lambda: dict(mapping)
        incoming = row(name="INBOUND", direction="Incoming", status="Ringing", customer_number=caller,
                       did_number=did, agent_number="sip:agent@registrar", call_status="provider-routed")
        self.replace(webrtc, "_number", lambda value: value)
        self.replace(frappe, "get_all", lambda *a, **kw: [mapping])
        self.replace(lifecycle, "lock_mapping", lambda _: mapping)
        self.replace(lifecycle, "presence", lambda _: "tab")
        self.replace(lifecycle, "assert_available", lambda _: None)
        self.replace(webrtc, "get_profile_endpoint_uri", lambda _: incoming.agent_number)
        document = MagicMock()
        document.insert.return_value = incoming
        self.replace(frappe, "get_doc", lambda _: document)
        from vobiz_click_to_call.api import call as core_call
        self.replace(core_call, "mark_mapping_busy", MagicMock())
        dial = self.replace(webrtc, "_dial_user_xml", MagicMock(return_value="<Response/>"))
        self.db.exists.return_value = False
        webrtc._answer_pstn_inbound(caller, did, {"CallUUID": "provider-inbound-uuid"})
        dial.assert_called_once_with(incoming.agent_number, did, incoming)
        dial.reset_mock()
        self.db.exists.return_value = True
        self.db.get_value.return_value = incoming.user
        mapping.current_call_log = "VSC-IN-" + webrtc.hashlib.sha256(b"provider-inbound-uuid").hexdigest()[:40]
        self.replace(lifecycle, "lock_call", lambda _: (mapping, incoming))
        webrtc._answer_pstn_inbound(caller, did, {"CallUUID": "provider-inbound-uuid"})
        dial.assert_called_once_with(incoming.agent_number, did, incoming)

    def test_incoming_link_uses_reserved_did_and_returns_authenticated_customer(self):
        self.replace(webrtc, "get_default_country_code", lambda: "+91")
        self.replace(lifecycle, "presence", lambda _: "tab")
        self.replace(webrtc, "get_system_call_profile", lambda: {"current_call_log": "INBOUND"})
        incoming = row(name="INBOUND", direction="Incoming", status="Ringing", customer_number="+919876545966",
                       normalized_customer_number="+919876545966", did_number="+911234565565")
        mapping = row(current_call_log="INBOUND", caller_id=incoming.did_number)
        self.replace(lifecycle, "lock_call", lambda _: (mapping, incoming))
        result = webrtc.get_incoming_call("sip:911234565565@registrar.vobiz.ai", "tab")
        self.assertEqual(result["call_log"], "INBOUND")
        self.assertEqual(result["customer_number"], incoming.customer_number)
        for address in ["+911234565565@registrar.vobiz.ai", "911234565565@registrar.vobiz.ai", "sips:+911234565565@registrar.vobiz.ai"]:
            self.assertEqual(webrtc.get_incoming_call(address, "tab")["call_log"], "INBOUND")
        for invalid in ["agent@registrar.vobiz.ai", "sip:+911234565565@", "+911234565565@registrar.vobiz.ai@evil", ""]:
            self.assertEqual(webrtc._number(invalid), "")
        with self.assertRaisesRegex(ValueError, "does not match"):
            webrtc.get_incoming_call("sip:911111111111@registrar.vobiz.ai", "tab")
        mapping.current_call_log = "OTHER"
        with self.assertRaisesRegex(ValueError, "does not match"):
            webrtc.get_incoming_call("sip:911234565565@registrar.vobiz.ai", "tab")

    def test_incoming_reference_matching_requires_unique_accessible_indexed_lead(self):
        self.replace(webrtc, "_number", lambda value: value)
        self.db.exists.return_value = True
        self.db.sql.return_value = ["sr_mobile_norm", "vobiz_phone_last10"]
        meta = MagicMock()
        meta.has_field.return_value = False
        self.replace(frappe, "get_meta", lambda _: meta)
        lookup = self.replace(frappe, "get_all", MagicMock(return_value=["LEAD-1"]))
        permission = self.replace(frappe, "has_permission", MagicMock(return_value=True))
        self.assertEqual(webrtc._unique_incoming_lead("+919876545966"), "LEAD-1")
        self.assertEqual(webrtc._unique_incoming_lead("+919876545966", "LEAD-1"), "LEAD-1")
        self.assertEqual(lookup.call_args.kwargs["filters"]["name"], "LEAD-1")
        permission.return_value = False
        self.assertIsNone(webrtc._unique_incoming_lead("+919876545966"))
        permission.return_value = True
        lookup.return_value = ["LEAD-1", "LEAD-2"]
        self.assertIsNone(webrtc._unique_incoming_lead("+919876545966"))
        self.db.sql.return_value = []
        lookup.reset_mock()
        self.assertIsNone(webrtc._unique_incoming_lead("+919876545966"))
        lookup.assert_not_called()
        self.assertIsNone(webrtc._unique_incoming_lead("+14155550123"))

    def test_incoming_disposition_preparation_rejects_active_or_foreign_calls(self):
        doc = row(direction="Incoming", status="Connected")
        self.replace(frappe, "get_doc", lambda *args: doc)
        with self.assertRaisesRegex(ValueError, "not ended"):
            webrtc.prepare_incoming_disposition("CALL-1")
        doc.status = "Completed"
        doc.user = "other@example.test"
        with self.assertRaisesRegex(ValueError, "Not permitted"):
            webrtc.prepare_incoming_disposition("CALL-1")

    def test_public_token_fails_closed_and_checks_exact_match(self):
        self.replace(webrtc, "get_inbound_callback_token", lambda *args: "")
        self.assertFalse(webrtc._valid_public_token(None))
        self.replace(webrtc, "get_inbound_callback_token", lambda *args: "a" * 40)
        self.assertFalse(webrtc._valid_public_token("bad"))
        self.assertTrue(webrtc._valid_public_token("a" * 40))

    def test_disabled_answer_never_routes(self):
        self.replace(webrtc, "_valid_public_token", lambda _: True)
        self.replace(webrtc, "is_enabled", lambda _: False)
        handler = self.replace(webrtc, "_answer_sdk_outbound", MagicMock())
        self.assertEqual(inspect.unwrap(webrtc.answer)("token").status_code, 403)
        handler.assert_not_called()

    def test_public_answer_uses_core_inbound_route_and_upgrades_browser_agent(self):
        from contextlib import nullcontext
        from vobiz_click_to_call.api import inbound

        self.replace(webrtc, "_valid_public_token", lambda _: True)
        self.replace(webrtc, "is_enabled", lambda _: True)
        self.replace(webrtc, "get_default_country_code", lambda *args: "+91")
        self.replace(webrtc, "_request_params", lambda: {
            "From": "+919876543210", "To": "+919999999999", "CallUUID": "uuid-12345678",
        })
        self.replace(frappe, "cache", lambda: SimpleNamespace(lock=lambda *args, **kwargs: nullcontext()))
        self.replace(inbound, "route", MagicMock(return_value=Response(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Number>911234567890</Number></Dial></Response>',
            content_type="text/xml",
        )))
        call_log = row(
            name="INBOUND",
            user="agent@example.test",
            agent_number="+911234567890",
            user_mobile="+911234567890",
            direction="Incoming",
            request_json='{"CallUUID":"uuid-12345678"}',
        )
        self.replace(inbound, "find_existing_inbound_call", MagicMock(return_value=call_log))
        mapping = row(
            name="agent@example.test",
            user="agent@example.test",
            current_call_log="INBOUND",
            agent_call_device="Browser Softphone",
            browser_softphone_enabled=1,
            browser_softphone_username="agent",
        )
        mapping.as_dict = lambda: dict(mapping)
        self.replace(webrtc, "get_system_call_profile", lambda user: {"name": mapping.name})
        self.replace(frappe, "get_doc", lambda *args, **kwargs: mapping)
        self.replace(webrtc, "get_profile_endpoint_uri", lambda *args: "sip:agent@registrar")

        response = inspect.unwrap(webrtc.answer)("secret")
        xml = response.get_data(as_text=True)

        self.assertIn("<User>sip:agent@registrar</User>", xml)
        self.assertNotIn("<Number>911234567890</Number>", xml)
        values = self.db.set_value.call_args.args[2]
        self.assertEqual(values["agent_number"], "sip:agent@registrar")
        context = json.loads(values["request_json"])
        self.assertEqual(context["source"], "vobiz_system_call")
        self.assertEqual(context["call_device"], "Browser Softphone")
        self.assertTrue(context["core_inbound_route"])

    def test_disabled_config_does_not_fetch_or_return_secrets(self):
        self.replace(webrtc, "_browser_enabled", lambda: False)
        self.replace(webrtc, "get_system_call_profile", lambda: frappe._dict(name="MAP", browser_softphone_enabled=1))
        self.replace(webrtc, "get_call_device", lambda *args: "Mobile Bridge")
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
        self.db.exists.return_value = False
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

    def test_outgoing_browser_answer_starts_recording_from_sdk_uuid(self):
        self.replace(lifecycle, "lock_call", lambda _: (
            frappe._dict(), row(direction="Outgoing", status="Ringing", answer_time=None, recording_call_uuid="")
        ))
        enqueue = self.replace(webrtc, "_enqueue_recording_start", MagicMock())
        webrtc.update_browser_softphone_call("CALL-1", "onCallAnswered", call_uuid="provider-uuid")
        values = self.db.set_value.call_args.args[2]
        self.assertEqual(values["recording_call_uuid"], "provider-uuid")
        self.assertEqual(values["status"], "Connected")
        self.assertEqual(values["answer_time"], "2026-09-08 10:05:00")
        self.assertNotIn("call_uuid", values)
        enqueue.assert_called_once_with("CALL-1")

    def test_end_with_provider_uuid_retains_reservation_for_reconciliation(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(call_uuid="provider-uuid")))
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        enqueue = self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        result = webrtc.update_browser_softphone_call("CALL-1", "onCallTerminated")
        self.assertEqual(result["status"], "Connected")
        finish.assert_not_called()
        enqueue.assert_called_once_with("CALL-1")

    def test_cancel_without_uuid_retains_intent_until_confirmed(self):
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(status="Initiated", answer_time=None)))
        finish = self.replace(lifecycle, "finish_locked", MagicMock(return_value="Cancelled"))
        result = webrtc.cancel_browser_call("CALL-1")
        self.assertEqual(result["status"], "Initiated")
        self.assertTrue(result["pending_provider"])
        finish.assert_not_called()
        writes = self.db.set_value.call_args_list
        self.assertTrue(any(args.args[2] == "call_status" and args.args[3] == "cancellation-requested" for args in writes))
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
        from vobiz_click_to_call.services.callback_logging import append_callback_job as append_callback
        inspect.signature(append_callback).bind(**{k: args[k] for k in ("call_log", "event_type", "payload")})
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
        provider.hangup_call.side_effect = lambda _, **kwargs: events.append("network")
        self.replace(client, "VobizClient", lambda _: provider)
        result = webrtc.cancel_browser_call("CALL-1")
        self.assertLess(events.index("commit"), events.index("network"))
        self.assertTrue(result["pending_provider"])

    def test_missing_provider_call_is_pending_without_releasing_reservation(self):
        from vobiz_click_to_call.services import client
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), row(call_uuid="provider-uuid")))
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        enqueue = self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        provider = MagicMock()
        provider.hangup_call.return_value = {"call_missing": True, "status_code": 404}
        self.replace(client, "VobizClient", lambda _: provider)
        result = webrtc.cancel_browser_call("CALL-1")
        self.assertTrue(result["pending_provider"])
        provider.hangup_call.assert_called_once_with("provider-uuid", allow_missing=True)
        finish.assert_not_called()
        enqueue.assert_called_once_with("CALL-1")

    def setup_static_hangup(self, payload, **changes):
        self.replace(webrtc, "_valid_public_token", lambda token: token == "valid")
        self.replace(webrtc, "_request_params", lambda: payload)
        current = row(call_uuid="provider-uuid", **changes)
        self.replace(frappe, "get_all", MagicMock(return_value=[current]))
        self.replace(lifecycle, "lock_call", MagicMock(return_value=(frappe._dict(), current)))
        self.replace(webrtc, "_append_callback_if_enabled", MagicMock())
        self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        return self.replace(lifecycle, "finish_locked", MagicMock())

    def test_static_hangup_rejects_invalid_token(self):
        finish = self.setup_static_hangup({"CallUUID": "provider-uuid", "Event": "Hangup"})
        self.assertEqual(webrtc.hangup("wrong").status_code, 403)
        frappe.get_all.assert_not_called()
        finish.assert_not_called()

    def test_static_hangup_finishes_matching_parent(self):
        finish = self.setup_static_hangup({"CallUUID": "provider-uuid", "Event": "Hangup",
                                          "CallStatus": "completed", "token": "secret"})
        self.assertEqual(webrtc.hangup("valid").status_code, 200)
        self.assertEqual(finish.call_args.kwargs["status"], "Completed")
        self.assertNotIn("token", webrtc._append_callback_if_enabled.call_args.args[2])

    def test_static_hangup_ignores_progress_recording_and_missing_uuid(self):
        for payload in ({"CallUUID": "provider-uuid", "Event": "RecordStop", "CallStatus": "completed"},
                        {"CallUUID": "provider-uuid", "Event": "DialAnswer"},
                        {"Event": "Hangup"},
                        {"CallUUID": "provider-uuid", "CallStatus": "in-progress"}):
            finish = self.setup_static_hangup(payload)
            webrtc.hangup("valid")
            finish.assert_not_called()

    def test_static_hangup_ignores_unknown_ambiguous_or_changed_uuid(self):
        for matches in ([], [row(), row()]):
            finish = self.setup_static_hangup({"CallUUID": "provider-uuid", "Event": "Hangup"})
            frappe.get_all.return_value = matches
            webrtc.hangup("valid")
            finish.assert_not_called()
        finish = self.setup_static_hangup({"CallUUID": "other-uuid", "Event": "Hangup"})
        webrtc.hangup("valid")
        finish.assert_not_called()
        self.db.rollback.assert_called()

    def test_static_hangup_is_idempotent_and_keeps_failed_outcome(self):
        finish = self.setup_static_hangup({"CallUUID": "provider-uuid", "Event": "Hangup"}, status="Failed")
        release = self.replace(lifecycle, "release_locked", MagicMock())
        webrtc.hangup("valid")
        finish.assert_not_called()
        release.assert_called_once()

    def test_static_hangup_preserves_busy_classification(self):
        finish = self.setup_static_hangup({"CallUUID": "provider-uuid", "Event": "Hangup",
                                          "CallStatus": "busy"}, status="Ringing", answer_time=None)
        webrtc.hangup("valid")
        self.assertEqual(finish.call_args.kwargs["status"], "Busy")

    def test_static_fallback_only_returns_hangup_xml(self):
        self.replace(webrtc, "_valid_public_token", lambda token: token == "valid")
        self.assertEqual(webrtc.fallback("wrong").status_code, 403)
        self.assertIn("<Hangup", webrtc.fallback("valid").get_data(as_text=True))
        self.db.set_value.assert_not_called()

    def test_cancel_after_delivered_terminal_event_preserves_evidence(self):
        pending = row(call_uuid="provider-uuid", call_status="browser-ended-pending-provider",
            request_json=json.dumps({"browser_terminal_event": "onCallTerminated",
                                     "browser_terminal_at": "2026-09-08 10:00:00"}))
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), pending))
        enqueue = self.replace(lifecycle, "enqueue_reconcile", MagicMock())
        for _ in range(2):
            self.assertTrue(webrtc.cancel_browser_call("CALL-1")["pending_provider"])
        self.db.set_value.assert_not_called()
        self.assertEqual(enqueue.call_count, 2)

    def test_terminal_after_cancel_retains_recovery_and_first_timestamp(self):
        pending = row(call_status="cancellation-requested",
                      request_json=json.dumps({"agent_cancelled": True,
                                               "browser_terminal_event": "hangup"}))
        values = lifecycle.provider_pending_values(pending, "onCallTerminated", "Terminated")
        pending.update(values)
        data = json.loads(pending.request_json)
        data["browser_terminal_at"] = "2026-09-08 10:00:00"
        pending.request_json = json.dumps(data)
        duplicate = lifecycle.provider_pending_values(pending, "onCallTerminated", "duplicate")
        self.assertEqual(json.loads(duplicate["request_json"])["browser_terminal_at"], "2026-09-08 10:00:00")
        self.assertTrue(lifecycle.provider_pending_expired(pending))
        self.assertEqual(lifecycle.provider_pending_outcome(pending)[0], "Completed")

    def test_live_cdr_prevents_browser_timeout_finalization(self):
        from vobiz_click_to_call.services import cdr, client, settings
        pending = row(call_uuid="provider-uuid", call_status="browser-ended-pending-provider",
                      request_json=json.dumps({"browser_terminal_event": "onCallTerminated",
                                               "browser_terminal_at": "2026-09-08 10:00:00"}))
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), pending))
        self.replace(settings, "get_settings", lambda: frappe._dict(enabled=1, enable_cdr_sync=1))
        self.replace(client, "VobizClient", lambda _: MagicMock())
        self.replace(cdr, "extract_cdr_rows", lambda _: [{"uuid": "provider-uuid", "status": "in-progress"}])
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        lifecycle.reconcile_call("CALL-1")
        finish.assert_not_called()

    def test_provider_pending_call_releases_after_cdr_timeout(self):
        from vobiz_click_to_call.services import cdr, client, settings
        data = {
            "source": "vobiz_system_call",
            "call_device": "Browser Softphone",
            "browser_terminal_at": "2026-09-08 10:00:00",
            "browser_terminal_event": "onCallTerminated",
            "browser_terminal_reason": "Terminated",
        }
        pending = row(
            call_uuid="provider-uuid",
            call_status="browser-ended-pending-provider",
            request_json=json.dumps(data),
            modified=datetime(2026, 9, 8, 10),
        )
        self.replace(lifecycle, "lock_call", MagicMock(return_value=(frappe._dict(), pending)))
        self.replace(settings, "get_settings", lambda: frappe._dict(enabled=1, enable_cdr_sync=1))
        provider = MagicMock()
        provider.search_cdrs.return_value = {}
        self.replace(client, "VobizClient", lambda _: provider)
        self.replace(cdr, "extract_cdr_rows", lambda _: [])
        finish = self.replace(lifecycle, "finish_locked", MagicMock(return_value="Completed"))
        lifecycle.reconcile_call("CALL-1")
        finish.assert_called_once()
        self.assertEqual(finish.call_args.kwargs["status"], "Completed")

    def test_provider_pending_call_waits_before_timeout(self):
        from vobiz_click_to_call.services import cdr, client, settings
        data = {
            "source": "vobiz_system_call",
            "call_device": "Browser Softphone",
            "browser_terminal_at": "2026-09-08 10:04:00",
            "browser_terminal_event": "onCallTerminated",
        }
        pending = row(
            call_uuid="provider-uuid",
            call_status="browser-ended-pending-provider",
            request_json=json.dumps(data),
            modified=datetime(2026, 9, 8, 10, 4),
        )
        self.replace(lifecycle, "lock_call", MagicMock(return_value=(frappe._dict(), pending)))
        self.replace(settings, "get_settings", lambda: frappe._dict(enabled=1, enable_cdr_sync=1))
        provider = MagicMock()
        provider.search_cdrs.return_value = {}
        self.replace(client, "VobizClient", lambda _: provider)
        self.replace(cdr, "extract_cdr_rows", lambda _: [])
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        lifecycle.reconcile_call("CALL-1")
        finish.assert_not_called()

    def test_failed_cancel_retry_still_checks_terminal_cdr(self):
        from vobiz_click_to_call.services import client, cdr, settings
        pending = row(call_uuid="provider-uuid", call_status="cancellation-requested",
                      request_json=json.dumps({"source": "vobiz_system_call",
                          "call_device": "Browser Softphone", "agent_cancelled": True}))
        self.replace(lifecycle, "lock_call", lambda _: (frappe._dict(), pending))
        self.replace(settings, "get_settings", lambda: frappe._dict(enabled=1, enable_cdr_sync=1))
        provider = MagicMock()
        provider.hangup_call.side_effect = RuntimeError("DELETE unavailable")
        self.replace(client, "VobizClient", lambda _: provider)
        self.replace(cdr, "extract_cdr_rows", lambda _: [{"uuid": "provider-uuid", "status": "completed"}])
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        self.replace(frappe, "log_error", MagicMock())
        self.replace(frappe, "get_traceback", lambda: "DELETE unavailable")
        lifecycle.reconcile_call("CALL-1")
        provider.search_cdrs.assert_called_once()
        finish.assert_called_once()
        self.assertEqual(finish.call_args.kwargs["status"], "Completed")

    def test_cancel_pending_timeout_does_not_prove_termination(self):
        data = {
            "source": "vobiz_system_call",
            "call_device": "Browser Softphone",
            "browser_terminal_at": "2026-09-08 10:00:00",
        }
        pending = row(
            call_uuid="provider-uuid",
            call_status="cancellation-requested",
            request_json=json.dumps(data),
            modified=datetime(2026, 9, 8, 10),
        )
        self.replace(lifecycle, "lock_call", MagicMock(return_value=(frappe._dict(), pending)))
        finish = self.replace(lifecycle, "finish_locked", MagicMock(return_value="Cancelled"))
        lifecycle.finish_provider_pending_if_expired("CALL-1", "provider-uuid")
        finish.assert_not_called()

    def test_local_browser_call_without_uuid_is_not_startup_failed(self):
        active = row(
            call_uuid="",
            status="Initiated",
            call_status="browserCallStarted",
            creation=datetime(2026, 9, 8, 10),
            request_json='{"source":"vobiz_system_call","call_device":"Browser Softphone"}',
        )
        self.replace(lifecycle, "lock_call", MagicMock(return_value=(frappe._dict(), active)))
        finish = self.replace(lifecycle, "finish_locked", MagicMock())
        lifecycle.reconcile_call("CALL-1")
        finish.assert_not_called()

    def test_client_missing_call_opt_in_does_not_hide_other_failures(self):
        from vobiz_click_to_call.services import client
        self.replace(client, "_", lambda value: value)
        provider = client.VobizClient.__new__(client.VobizClient)
        provider.auth_id, provider.auth_token = "test", "test"
        provider.base_url, provider.timeout = "https://provider.example", 1
        response = MagicMock(status_code=404)
        response.json.return_value = {"message": "call not found"}
        self.replace(client.requests, "delete", MagicMock(return_value=response))
        self.assertTrue(provider.hangup_call("uuid", allow_missing=True)["call_missing"])
        with self.assertRaisesRegex(ValueError, "call not found"):
            provider.hangup_call("uuid")
        for code, message in [(401, "call not found"), (500, "call not found"), (404, "account not found")]:
            response.status_code = code
            response.json.return_value = {"message": message}
            with self.assertRaises(ValueError):
                provider.hangup_call("uuid", allow_missing=True)

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
