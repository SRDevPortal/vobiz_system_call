"""Direct dial uses the normal device, owner, busy and safety gates."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import frappe
from vobiz_system_call.api import call, lifecycle, conference
from vobiz_click_to_call.api import call as core
from vobiz_click_to_call.services import direct_dial


class DirectCallStartTests(unittest.TestCase):
    def setUp(self):
        self.mock(frappe, 'local', SimpleNamespace(flags=frappe._dict(in_test=False), request=None))
        self.mock(frappe, 'session', frappe._dict(user='agent'))
        self.mock(frappe, 'throw', lambda m, *a: (_ for _ in ()).throw(ValueError(m)))
        self.mock(frappe, 'get_roles', lambda: [])
        self.mock(call, '_', lambda m: m)
        self.mock(lifecycle, '_', lambda m: m)
        self.mock(direct_dial, '_', lambda m: m)
        self.db = self.mock(frappe, 'db', MagicMock())
        self.db.get_value.return_value = frappe._dict(reference_doctype='', reference_name='')
        self.settings = frappe._dict(enabled=1, enable_cdr_sync=1)
        self.mock(call, 'get_settings', lambda: self.settings)
        self.mock(call, 'is_enabled', lambda _: True)
        self.mock(call, 'get_core_settings', lambda: frappe._dict(enabled=1, enable_ndr_dialpad=1, default_country_code='+91'))
        self.mock(call, 'get_default_country_code', lambda _: '+91')
        self.mapping = frappe._dict(name='MAP', user='agent', enabled=1, queue_source='NDR', agent_mobile='+919999999999', availability_status='Available')
        self.mapping.as_dict = lambda: dict(self.mapping)
        self.lock = self.mock(lifecycle, 'lock_mapping', MagicMock(return_value=self.mapping))
        self.available = self.mock(lifecycle, 'assert_available', MagicMock())
        self.mock(core, 'get_user_mapping', lambda _: self.mapping)
        self.mock(call, 'get_system_call_profile', lambda _: self.mapping)
        self.device = self.mock(call, 'get_call_device', MagicMock(return_value='Browser Softphone'))
        self.mock(call, 'assert_device_enabled', MagicMock())
        self.mock(call, 'get_inbound_callback_token', lambda _: 'callback-token')
        self.mock(call, 'get_caller_id', lambda *a: '+911234567890')
        self.mock(lifecycle, 'presence', lambda _: 'owner-tab')
        self.mock(conference, 'enabled', lambda _: False)
        self.mock(direct_dial, 'get_allowed_doctypes', lambda _: [])
        self.dialpad_settings = frappe._dict(enable_ndr_dialpad=1)
        self.mock(direct_dial, 'get_settings', lambda: self.dialpad_settings)
        self.mock(direct_dial, 'get_default_country_code', lambda _: '+91')
        self.guard = self.mock(call, 'assert_call_allowed', MagicMock())
        self.created = self.mock(core, 'create_call_log', MagicMock(return_value=frappe._dict(name='CALL')))
        self.started = self.mock(call, 'start_browser_softphone_call', MagicMock(return_value={'call_log': 'CALL'}))
        self.mobile = self.mock(core, 'start_direct_call', MagicMock(return_value={'call_log': 'MOBILE'}))
        self.mock(call.number_privacy, 'restricted', lambda: False)

    def mock(self, obj, name, value):
        p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop); return value

    def start(self, **kw):
        return call.start_direct_call('9876543210', client_context='agent_console', tab_id=kw.get('tab_id', 'owner-tab'))

    def test_browser_start_uses_own_mapping_and_caller_id_and_standalone_log(self):
        result = self.start()
        self.assertTrue(result['direct_dial'])
        self.assertEqual(result['reference_name'], '')
        data = self.created.call_args.kwargs
        self.assertEqual(data['customer_number'], '+919876543210')
        self.assertEqual(data['caller_id'], '+911234567890')
        self.assertEqual(data['reference_doctype'], '')
        self.assertTrue(data['direct_dial'])
        self.assertEqual(self.guard.call_args.kwargs['user'], 'agent')
        self.assertEqual(self.started.call_args.kwargs['mapping']['name'], 'MAP')

    def test_normal_mapping_cannot_use_api_even_if_button_is_forged(self):
        self.mapping.queue_source = 'Patient'
        with self.assertRaisesRegex(ValueError, 'NDR'): self.start()
        self.created.assert_not_called()

    def test_mapping_revocation_is_rechecked_under_final_lock(self):
        revoked = frappe._dict(self.mapping, queue_source='Patient')
        revoked.as_dict = lambda: dict(revoked)
        self.lock.side_effect = [self.mapping, revoked]
        with self.assertRaisesRegex(ValueError, 'NDR'): self.start()
        self.created.assert_not_called()

    def test_wrong_browser_owner_cannot_start_call(self):
        with self.assertRaisesRegex(ValueError, 'Connect this browser'): self.start(tab_id='other-tab')
        self.created.assert_not_called()

    def test_busy_and_blocked_fail_before_call_creation(self):
        self.available.side_effect = ValueError('Busy')
        with self.assertRaisesRegex(ValueError, 'Busy'): self.start()
        self.available.side_effect = None
        self.guard.side_effect = ValueError('Blocked')
        with self.assertRaisesRegex(ValueError, 'Blocked'): self.start()
        self.created.assert_not_called()

    def test_mobile_uses_core_direct_endpoint_and_still_owns_mapping(self):
        self.device.return_value = 'Mobile Bridge'
        self.assertEqual(self.start()['call_log'], 'MOBILE')
        self.mobile.assert_called_once_with('9876543210')
        self.lock.assert_called_once_with('agent')
        self.started.assert_not_called()

    def test_system_dialer_uses_existing_device_flow(self):
        self.device.return_value = 'System Dialer'
        with patch.object(call, 'start_system_dialer_call', return_value={'call_log': 'CALL'}) as dialer:
            self.start()
            self.assertEqual(dialer.call_args.kwargs['customer_number'], '+919876543210')
            self.started.assert_not_called()

    def test_direct_retry_keeps_server_destination_and_rejects_foreign_call(self):
        previous = frappe._dict(user='agent', customer_number='+919876543210', reference_doctype='',
                                reference_name='', request_json='{"direct_dial":true}')
        with patch.object(frappe, 'get_doc', return_value=previous), patch.object(call, '_start_call', return_value={}) as start:
            call.retry_call_log('OLD', 'owner-tab')
            self.assertTrue(start.call_args.kwargs['direct_dial'])
            self.assertEqual(start.call_args.kwargs['phone_number'], previous.customer_number)
            self.assertEqual(start.call_args.kwargs['retry_of'], 'OLD')
            start.reset_mock(); previous.user = 'other-agent'
            with self.assertRaisesRegex(ValueError, 'Not permitted'): call.retry_call_log('OLD', 'owner-tab')
            start.assert_not_called()

    def test_setting_disabled_before_final_start_blocks_new_call(self):
        self.dialpad_settings.enable_ndr_dialpad = 0
        with self.assertRaisesRegex(ValueError, 'Enable NDR Dialpad'): self.start()
        self.created.assert_not_called()
