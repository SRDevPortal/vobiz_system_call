"""Conference recovery contract tests; no provider traffic or real calls."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from xml.etree import ElementTree as ET

import frappe
from vobiz_system_call.api import conference as c, lifecycle, ownership, webrtc

AGENT = "11111111-1111-4111-8111-111111111111"
CUSTOMER = "22222222-2222-4222-8222-222222222222"


class ConferenceTests(unittest.TestCase):
    def replace(self, obj, key, value):
        p = patch.object(obj, key, value)
        p.start()
        self.addCleanup(p.stop)
        return value

    def setUp(self):
        self.replace(frappe, "db", MagicMock())
        self.replace(frappe, "conf", frappe._dict())
        self.replace(frappe, "request", None)
        self.replace(frappe, "local", SimpleNamespace(flags=frappe._dict(in_test=False), request=None))
        self.replace(frappe, "session", SimpleNamespace(user="agent@test.invalid"))
        self.replace(frappe, "throw", lambda m: (_ for _ in ()).throw(ValueError(m)))
        self.replace(c, "_", lambda m: m)
        self.replace(frappe.utils, "now", lambda: "2026-09-17 12:00:00")
        self.replace(c.time, "time", lambda: 1000)
        self.cache = MagicMock()
        self.replace(frappe, "cache", lambda: self.cache)
        self.replace(frappe, "enqueue", MagicMock())
        self.replace(c, "get_settings", lambda: frappe._dict(max_call_duration=3600))
        self.replace(c, "get_inbound_callback_token", lambda: "test-secret")
        self.replace(c, "get_webhook_base_url", lambda: "https://erp.invalid")
        self.replace(c, "provider_phone_number", lambda n: n)
        self.replace(webrtc, "_login", lambda: None)
        self.replace(ownership, "current_owner", lambda *a: "TAB")
        self.row = frappe._dict(name="CALL", user="agent@test.invalid", status="Initiated",
            request_json=json.dumps({"source": "vobiz_system_call", "call_device": "Browser Softphone"}),
            call_uuid="", caller_id="+910000000001", customer_number="+910000000002",
            callback_token="recording-secret", answer_time=None, direction="Outgoing")
        self.mapping = frappe._dict(current_call_log="CALL")
        self.replace(lifecycle, "lock_call", lambda *a: (self.mapping, self.row))
        self.finish = self.replace(lifecycle, "finish_locked", MagicMock())
        self.cdr_finish = self.replace(lifecycle, "finish_reconciled_call", MagicMock())
        self.find_cdr = self.replace(lifecycle, "find_recovery_cdr", MagicMock(return_value=None))
        self.client = MagicMock()
        self.replace(c, "VobizClient", lambda *a: self.client)
        self.client.make_call.return_value = {"call_uuid": CUSTOMER}
        self.response = c.prepare(self.row, c.get_settings())
        self.value = c.state(self.row)
        self.value["legs"] = {"1": {"uuid": AGENT, "entered": True}}
        self.value["deadline"] = None
        c.save(self.row, self.value)

    def recover(self, **kw):
        return c.recover(call_log="CALL", tab_id="TAB", generation=1, **kw)

    def issued(self):
        self.value["customer_issue"] = "issued"
        self.row.call_uuid = CUSTOMER
        c.save(self.row, self.value)

    def test_user_mapping_controls_recovery_without_site_config(self):
        self.replace(frappe, "get_meta", lambda dt: SimpleNamespace(has_field=lambda f: True))
        frappe.db.get_value.return_value = 0
        self.assertFalse(c.enabled(self.row.user))
        frappe.db.get_value.return_value = 1
        self.assertTrue(c.enabled(self.row.user))
        frappe.db.get_value.assert_called_with("Vobiz User Mapping",
            {"user": self.row.user, "enabled": 1, "browser_softphone_enabled": 1},
            "browser_call_recovery_enabled")
        # Old pilot configuration cannot override an administrator unchecking it.
        frappe.conf.update(vsc_conference_recovery=1, vsc_conference_recovery_users=[self.row.user])
        frappe.db.get_value.return_value = 0
        self.assertFalse(c.enabled(self.row.user))
        frappe.db.get_value.return_value = None
        self.assertFalse(c.enabled(self.row.user))

    def test_recovery_is_off_before_mapping_field_is_installed(self):
        self.replace(frappe, "get_meta", lambda dt: SimpleNamespace(has_field=lambda f: False))
        self.assertFalse(c.enabled(self.row.user))
        frappe.db.get_value.assert_not_called()

    def test_routes_and_rooms_are_unique_and_grace_is_120(self):
        original = c.state(self.row)
        c.prepare(self.row, c.get_settings())
        fresh = c.state(self.row)
        self.assertNotEqual(original["room"], fresh["room"])
        self.assertNotEqual(original["route"], fresh["route"])
        self.assertEqual(fresh["deadline"], 1120)
        self.assertEqual(self.response["conference_generation"], 1)

    def test_new_calls_require_timeout_sweep_and_conference_worker(self):
        from frappe.utils import background_jobs
        from vobiz_system_call.api import conference_jobs as jobs
        self.replace(background_jobs, "get_queues_timeout", lambda: {c.QUEUE: 120, jobs.URGENT_QUEUE: 120})
        self.cache.get_value.return_value = 999
        c.assert_ready()
        self.cache.get_value.return_value = 800
        with self.assertRaises(ValueError):
            c.assert_ready()
        self.cache.get_value.side_effect = lambda key, **kw: 999 if key == jobs.DISPATCHER_HEARTBEAT else None
        with self.assertRaises(ValueError):
            c.assert_ready()

    def test_cancel_attempts_customer_hangup_even_when_urgent_queue_fails(self):
        from vobiz_system_call.api import conference_jobs as jobs
        self.issued()
        self.replace(jobs, "enqueue", MagicMock(side_effect=ConnectionError("queue down")))
        self.replace(frappe, "logger", MagicMock())
        frappe.db.get_value.return_value = "Connected"
        result = c.cancel(self.mapping, self.row)
        self.assertTrue(c.state(self.row)["closed"])
        self.assertTrue(lifecycle.context(self.row)["agent_cancelled"])
        frappe.db.commit.assert_called()
        self.client.hangup_call.assert_called_once_with(CUSTOMER, allow_missing=True)
        self.assertTrue(result["pending_provider"])
        self.finish.assert_not_called()

    def test_cancel_does_not_wait_for_cdr_queries_or_clear_on_delete_success(self):
        from vobiz_system_call.api import conference_jobs as jobs
        self.issued()
        queued = self.replace(jobs, "enqueue", MagicMock())
        frappe.db.get_value.return_value = "Connected"
        result = c.cancel(self.mapping, self.row)
        queued.assert_called_once_with("CALL", urgent=True, after_commit=False)
        self.find_cdr.assert_not_called()
        self.assertTrue(result["pending_provider"])
        self.finish.assert_not_called()

    def test_busy_reconcile_lease_does_not_execute_duplicate_provider_requests(self):
        self.cache.lock.return_value.acquire.return_value = False
        c.reconcile("CALL")
        self.client.hangup_call.assert_not_called()
        self.find_cdr.assert_not_called()

    def test_shared_erp_reconcile_only_hands_off_conference_calls(self):
        from vobiz_system_call.api import conference_jobs as jobs
        queued = self.replace(jobs, "enqueue", MagicMock())
        lifecycle._reconcile_call("CALL")
        queued.assert_called_once_with("CALL", urgent=False, after_commit=False)
        self.find_cdr.assert_not_called()
        self.client.retrieve_live_call.assert_not_called()
        self.value["closed"] = True
        c.save(self.row, self.value)
        lifecycle._reconcile_call("CALL")
        queued.assert_called_with("CALL", urgent=True, after_commit=False)

    def test_stale_deadline_after_rejoin_cannot_end_connected_call(self):
        self.issued()
        self.value["deadline"] = None
        c.save(self.row, self.value)
        c.reconcile("CALL")
        self.client.hangup_call.assert_not_called()
        self.finish.assert_not_called()

    def test_500_expired_calls_request_both_legs_without_claiming_completion(self):
        from copy import deepcopy
        base = deepcopy(self.value)
        customer_ids = set()
        agent_ids = set()
        for n in range(500):
            customer = f"customer-{n}"
            agent = f"agent-{n}"
            customer_ids.add(customer)
            agent_ids.add(agent)
            self.row.update(name=f"CALL-{n}", call_uuid=customer, status="Connected")
            self.mapping.current_call_log = self.row.name
            value = deepcopy(base)
            value.update(customer_issue="issued", deadline=999,
                         legs={"1": {"uuid": agent, "entered": True}})
            c.save(self.row, value)
            c.reconcile(self.row.name)
            self.assertTrue(c.state(self.row)["closed"])
            self.assertFalse(c.state(self.row)["customer_ended"])
        requested = {call.args[0] for call in self.client.hangup_call.call_args_list}
        self.assertEqual(requested, customer_ids | agent_ids)
        self.assertEqual(self.client.hangup_call.call_count, 1000)
        self.client.make_call.assert_not_called()
        self.cdr_finish.assert_not_called()
        self.finish.assert_not_called()

    def test_join_header_routes_the_call_without_exposing_callback_secret(self):
        join = c.browser_join(self.row, self.value)
        self.assertEqual(join["destination"], self.row.customer_number)
        self.assertEqual(c.browser_route(join["conference_headers"]), self.value["route"])
        self.assertNotIn("test-secret", json.dumps(join))

    def test_agent_answer_requires_exact_call_header_and_never_sets_customer_uuid(self):
        endpoint = "sip:test@registrar.invalid"
        self.mapping.update(browser_softphone_enabled=True)
        self.mapping.as_dict = lambda: dict(self.mapping)
        self.replace(frappe, "get_all", lambda *a, **kw: [frappe._dict(user=self.row.user)])
        self.replace(lifecycle, "lock_mapping", lambda *a: self.mapping)
        self.replace(c, "get_profile_endpoint_uri", lambda *a: endpoint)
        self.replace(webrtc, "_xml_response", lambda xml: xml)
        self.replace(webrtc, "_number", lambda value: value)
        # A new generation has no provider agent UUID yet.
        self.value["legs"] = {}
        c.save(self.row, self.value)
        for header in ({}, {"X-VH-VSC": "old-route"}):
            xml = c.answer_agent(endpoint, self.row.customer_number, {"CallUUID": AGENT, **header})
            self.assertIsNone(ET.fromstring(xml).find("Conference"))
        xml = c.answer_agent(endpoint, self.row.customer_number,
                             {"CallUUID": AGENT, "X-VH-VSC": self.value["route"]})
        self.assertIsNotNone(ET.fromstring(xml).find("Conference"))
        self.assertFalse(self.row.call_uuid)
        self.assertEqual(c.current_leg(c.state(self.row))["uuid"], AGENT)

    def test_room_keeps_other_leg_alive_and_has_no_redial(self):
        xml = ET.fromstring(c.room_xml(self.row, "agent", 1))
        room = xml.find("Conference")
        self.assertEqual(room.get("stayAlone"), "true")
        self.assertEqual(room.get("endConferenceOnExit"), "false")
        self.assertIsNone(xml.find("Dial"))
        self.assertIsNotNone(xml.find("Hangup"))
        self.assertIn("generation=1", room.get("callbackUrl"))

    def test_recording_belongs_to_enduring_customer_only(self):
        from vobiz_click_to_call.services import settings
        self.replace(c, "get_settings", lambda: frappe._dict(enable_recording=1))
        build = self.replace(settings, "build_callback_url", MagicMock(return_value="https://erp.invalid/record"))
        customer = ET.fromstring(c.room_xml(self.row, "customer"))
        agent = ET.fromstring(c.room_xml(self.row, "agent", 1))
        self.assertEqual(customer.find("Record").get("recordSession"), "true")
        self.assertEqual(customer.find("Record").get("redirect"), "false")
        self.assertIsNone(agent.find("Record"))
        self.assertEqual(build.call_args.args[1:3], ("CALL", "recording-secret"))

    def test_callback_tokens_are_call_role_and_generation_bound(self):
        frappe.db.get_value.return_value = self.row
        token = c.token(self.row, "agent", 1)
        self.assertTrue(c.authorize("CALL", "agent", 1, token))
        self.assertFalse(c.authorize("CALL", "customer", 0, token))
        self.assertFalse(c.authorize("CALL", "agent", 2, token))
        self.assertFalse(c.authorize("CALL", "agent", 1, "wrong"))

    def test_duplicate_jobs_issue_customer_only_once(self):
        c.originate_customer("CALL")
        c.originate_customer("CALL")
        self.client.make_call.assert_called_once()
        self.assertEqual(self.row.call_uuid, CUSTOMER)
        self.assertIn("customer_answer", self.client.make_call.call_args.args[0]["answer_url"])

    def test_timeout_never_retries_customer_post_or_releases_agent(self):
        self.client.make_call.side_effect = TimeoutError()
        c.originate_customer("CALL")
        c.originate_customer("CALL")
        self.assertEqual(c.state(self.row)["customer_issue"], "uncertain")
        self.client.make_call.assert_called_once()
        self.finish.assert_not_called()

    def test_request_uuid_is_not_a_customer_call_uuid(self):
        self.client.make_call.return_value = {"request_uuid": CUSTOMER}
        c.originate_customer("CALL")
        self.assertFalse(self.row.call_uuid)
        self.assertEqual(c.state(self.row)["customer_request_uuid"], CUSTOMER)
        self.assertTrue(c.bind_customer(self.row, c.state(self.row), CUSTOMER))

    def test_cancel_before_originate_prevents_customer_call(self):
        self.value["closed"] = True
        c.save(self.row, self.value)
        c.originate_customer("CALL")
        c.reconcile("CALL")
        self.client.make_call.assert_not_called()
        self.assertEqual(self.finish.call_args.kwargs["status"], "Cancelled")

    def test_cancel_during_post_cannot_be_undone_by_response(self):
        def response(payload):
            value = c.state(self.row)
            self.assertEqual(value["customer_issue"], "issuing")
            value["closed"] = True
            c.save(self.row, value)
            return {"call_uuid": CUSTOMER}
        self.client.make_call.side_effect = response
        c.originate_customer("CALL")
        self.assertTrue(c.state(self.row)["closed"])
        c.reconcile("CALL")
        self.client.hangup_call.assert_any_call(CUSTOMER, allow_missing=True)
        self.client.hangup_call.assert_any_call(AGENT, allow_missing=True)
        self.finish.assert_not_called()  # Requests are not proof of termination.

    def test_late_enter_cannot_undo_exit(self):
        c.apply_member(self.value, "agent", 1, AGENT, "exit", 1000)
        c.apply_member(self.value, "agent", 1, AGENT, "enter", 1001)
        self.assertTrue(c.current_leg(self.value)["exited"])
        self.assertEqual(self.value["deadline"], 1120)

    def test_old_generation_exit_cannot_interrupt_new_agent(self):
        self.value["generation"] = 2
        self.value["legs"]["2"] = {"uuid": "new-agent", "entered": True}
        c.apply_member(self.value, "agent", 1, AGENT, "exit", 1000)
        self.assertIsNone(self.value["deadline"])
        self.assertFalse(c.current_leg(self.value).get("exited"))

    def test_customer_exit_prevents_rejoin_without_claiming_hangup(self):
        c.apply_member(self.value, "customer", 0, CUSTOMER, "exit", 1000)
        c.apply_member(self.value, "customer", 0, CUSTOMER, "enter", 1001)
        self.assertTrue(self.value["closed"])
        self.assertFalse(self.value["customer_ended"])

    def test_browser_hangup_does_not_complete_customer(self):
        self.issued()
        c.browser_event(self.mapping, self.row, "onCallTerminated", "", "sdk-id", 1)
        self.assertEqual(self.row.status, "Initiated")
        self.assertEqual(c.state(self.row)["deadline"], 1120)
        self.finish.assert_not_called()

    def test_old_browser_generation_is_ignored(self):
        self.value["generation"] = 2
        c.save(self.row, self.value)
        c.browser_event(self.mapping, self.row, "onCallTerminated", "", "sdk-id", 1)
        self.assertIsNone(c.state(self.row)["deadline"])

    def test_healthy_media_accepts_sdk_identity_distinct_from_provider_uuid(self):
        result = self.recover(sdk_uuid="sdk-session-not-provider-uuid", media_connected=1, session_alive=1)
        self.assertTrue(result["agent_connected"])
        self.client.make_call.assert_not_called()

    def test_only_owned_window_can_recover(self):
        self.replace(ownership, "current_owner", lambda *a: "OTHER")
        with self.assertRaises(ValueError):
            self.recover()
        self.client.make_call.assert_not_called()

    def test_owner_change_during_provider_read_blocks_rejoin(self):
        self.issued()
        self.replace(ownership, "current_owner", MagicMock(side_effect=["TAB", "OTHER"]))
        self.replace(c, "live_customer", lambda *a: True)
        result = self.recover()
        self.assertNotIn("destination", result)
        self.assertNotIn("retire_session", result)

    def test_rejoin_waits_until_old_agent_exit(self):
        self.issued()
        self.replace(c, "live_customer", lambda *a: True)
        self.assertNotIn("destination", self.recover())
        self.assertTrue(c.current_leg(c.state(self.row))["retire"])
        value = c.state(self.row)
        value["legs"]["1"]["exited"] = True
        c.save(self.row, value)
        result = self.recover()
        self.assertEqual(result["conference_generation"], 2)
        self.assertEqual(result["destination"], self.row.customer_number)
        self.assertTrue(result["conference_headers"]["X-VH-VSC"].startswith("vsc"))
        self.client.make_call.assert_not_called()

    def test_end_call_racing_live_check_blocks_rejoin(self):
        self.issued()
        def live(row):
            value = c.state(row)
            value["closed"] = True
            c.save(row, value)
            return True
        self.replace(c, "live_customer", live)
        self.assertNotIn("destination", self.recover())

    def test_expiry_requests_termination_but_does_not_clear_customer(self):
        self.issued()
        self.value["deadline"] = 999
        c.save(self.row, self.value)
        result = self.recover()
        self.assertTrue(result["ending"])
        self.finish.assert_not_called()

    def test_provider_failure_cannot_be_treated_as_customer_end(self):
        self.issued()
        self.value["closed"] = True
        c.save(self.row, self.value)
        self.client.hangup_call.side_effect = TimeoutError()
        self.find_cdr.side_effect = TimeoutError()
        c.reconcile("CALL")
        self.finish.assert_not_called()
        self.cdr_finish.assert_not_called()
        self.assertFalse(c.state(self.row)["customer_ended"])

    def test_wrong_cdr_cannot_complete_call(self):
        self.issued()
        self.find_cdr.return_value = {"call_uuid": AGENT, "status": "completed", "end_time": "2026-09-17 12:00:00"}
        c.reconcile("CALL")
        self.cdr_finish.assert_not_called()
        self.assertFalse(c.state(self.row)["customer_ended"])

    def test_final_customer_cdr_closes_recovery(self):
        self.issued()
        self.find_cdr.return_value = {"call_uuid": CUSTOMER, "status": "completed", "end_time": "2026-09-17 12:00:00"}
        c.reconcile("CALL")
        self.cdr_finish.assert_called_once()
        self.assertTrue(c.state(self.row)["closed"])
        self.assertTrue(c.state(self.row)["customer_ended"])

    def test_customer_live_requires_exact_uuid_and_live_state(self):
        self.issued()
        for response, expected in [
            ({"call_uuid": CUSTOMER, "call_status": "in-progress"}, True),
            ({"call_uuid": AGENT, "call_status": "in-progress"}, False),
            ({"call_uuid": CUSTOMER, "call_status": "completed"}, False),
            ({}, False),
        ]:
            self.client.retrieve_live_call.return_value = response
            self.assertEqual(c.live_customer(self.row), expected)


class MappingRecoveryMigrationTests(unittest.TestCase):
    def run_install(self, field_exists, **config):
        from vobiz_system_call import install
        db = MagicMock()
        db.exists.side_effect = lambda dt, name: field_exists if dt == "Custom Field" else True
        db.get_value.return_value = "pilot-mapping"
        with patch.object(frappe, "db", db), patch.object(frappe, "conf", frappe._dict(config)), \
                patch.object(frappe, "clear_cache"), patch.object(install, "create_custom_fields"):
            install.ensure_patch_fields()
        return db

    def test_existing_pilot_is_preserved_on_first_field_install(self):
        db = self.run_install(False, vsc_conference_recovery=1,
            vsc_conference_recovery_users=["pilot@test.invalid"])
        db.set_value.assert_called_once_with("Vobiz User Mapping", "pilot-mapping",
            "browser_call_recovery_enabled", 1)

    def test_later_migration_does_not_reenable_unchecked_pilot(self):
        db = self.run_install(True, vsc_conference_recovery=1,
            vsc_conference_recovery_users=["pilot@test.invalid"])
        db.set_value.assert_not_called()

    def test_disabled_old_pilot_does_not_enable_anyone(self):
        db = self.run_install(False, vsc_conference_recovery=0,
            vsc_conference_recovery_users=["pilot@test.invalid"])
        db.set_value.assert_not_called()


if __name__ == "__main__":
    unittest.main()
