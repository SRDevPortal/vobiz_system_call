import json
import logging
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import frappe
from vobiz_click_to_call.services import availability_recovery as availability
from vobiz_system_call.api import diagnostics, lifecycle, ownership, webrtc
from vobiz_system_call import request_diagnostics as http


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 3, 12)
        self.db, self.cache, self.logger = MagicMock(), MagicMock(), MagicMock()
        self.cache.get_value.return_value = None
        self.mapping = frappe._dict(name='MAP', user='agent', availability_status='Busy',
            current_call_log='CALL', enabled=1, auto_available_after_call=1,
            browser_softphone_enabled=1, last_status_at=self.now)
        self.local = SimpleNamespace(flags=frappe._dict(in_test=False), request=None,
            session=SimpleNamespace(user='Guest'))
        for obj, name, value in (
            (frappe, 'db', self.db), (frappe, 'local', self.local),
            (frappe, 'session', SimpleNamespace(user='agent')),
            (frappe, 'cache', lambda: self.cache), (frappe, 'logger', lambda *a, **kw: self.logger),
            (frappe, 'publish_realtime', MagicMock()),
            (frappe, 'as_json', json.dumps),
            (frappe.utils, 'now_datetime', lambda: self.now),
            (frappe.utils, 'now', lambda: str(self.now)),
            (frappe, 'throw', self.throw),
        ):
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)

    @staticmethod
    def throw(message, exception=frappe.ValidationError):
        raise exception(message)

    def disconnected(self):
        self.mapping.update(availability_status='Offline', current_call_log='')
        self.cache.get_value.return_value = {'at': str(self.now), 'call_log': 'CALL'}

    def test_lost_presence_is_offline_not_break(self):
        self.assertEqual(availability.after_call_state(self.mapping, browser=True, present=False),
                         ('Offline', 'browser_presence_lost'))

    def test_explicit_status_and_configured_break_are_preserved(self):
        for status in ('Away', 'Offline'):
            self.mapping.availability_status = status
            self.assertEqual(availability.after_call_state(self.mapping, browser=True, present=False)[0], status)
        self.mapping.update(availability_status='Busy', auto_available_after_call=0)
        self.assertEqual(availability.after_call_state(self.mapping)[0], 'Away')

    def test_marker_and_log_are_written_only_after_commit(self):
        availability.record_transition(self.mapping, 'Offline', self.now, 'browser_presence_lost', 'CALL')
        self.cache.set_value.assert_not_called()
        self.logger.info.assert_not_called()
        self.db.after_commit.add.call_args.args[0]()
        self.assertEqual(self.cache.set_value.call_args.args[1]['at'], str(self.now))
        self.assertEqual(json.loads(self.logger.info.call_args.args[0])['from'], 'Busy')

    def test_verified_reconnect_restores_once(self):
        self.disconnected()
        self.assertTrue(availability.restore_browser_availability(self.mapping))
        self.assertEqual(self.mapping.availability_status, 'Available')
        self.assertFalse(availability.restore_browser_availability(self.mapping))
        self.db.set_value.assert_called_once()

    def test_later_manual_offline_invalidates_marker_even_if_cache_delete_was_lost(self):
        self.disconnected()
        self.mapping.last_status_at += timedelta(microseconds=1)
        self.assertFalse(availability.restore_browser_availability(self.mapping))
        self.db.set_value.assert_not_called()

    def test_new_call_disabled_agent_and_manual_break_cannot_auto_restore(self):
        for field, value in [('current_call_log', 'NEW'), ('enabled', 0),
                             ('browser_softphone_enabled', 0), ('auto_available_after_call', 0),
                             ('availability_status', 'Away')]:
            with self.subTest(field=field):
                original = self.mapping.copy()
                self.disconnected(); self.mapping[field] = value
                self.assertFalse(availability.restore_browser_availability(self.mapping))
                self.mapping = frappe._dict(original)
        self.db.set_value.assert_not_called()

    def test_cache_failure_never_makes_agent_available(self):
        self.disconnected(); self.cache.get_value.side_effect = ConnectionError()
        self.assertFalse(availability.restore_browser_availability(self.mapping))

    def test_live_call_missing_presence_never_releases_mapping(self):
        row = frappe._dict(name='CALL', status='Connected')
        lifecycle.release_locked(self.mapping, row)
        self.db.set_value.assert_not_called()

    def test_manual_break_checks_locked_current_call_before_writing(self):
        from vobiz_click_to_call.api import call
        self.db.get_value.return_value = self.mapping
        with patch.object(call, 'get_user_mapping', return_value={'name': 'MAP', 'current_call_log': ''}), \
                patch.object(call, 'is_active_call_log', return_value=True), patch.object(call, '_', lambda x: x):
            with self.assertRaises(frappe.ValidationError):
                call.set_my_availability('Away')
        self.assertTrue(self.db.get_value.call_args.kwargs['for_update'])
        self.db.set_value.assert_not_called()

    def test_connection_claim_cannot_restore_before_registered_heartbeat(self):
        from contextlib import nullcontext
        self.disconnected()
        self.cache.get_value.side_effect = lambda key, **kw: (
            {'at': str(self.now), 'call_log': 'CALL'} if key.startswith('vobiz:connection-offline:') else None)
        with patch.object(ownership, 'locked_browser', return_value=nullcontext(('agent', self.mapping, self.cache))):
            ownership.presence_heartbeat('owner-window', claim_idle=1)
            self.db.set_value.assert_not_called()
            ownership.presence_heartbeat('owner-window', registered=1)
        self.assertEqual(self.mapping.availability_status, 'Available')

    def test_login_expiry_has_typed_authentication_error(self):
        with patch.object(frappe, 'session', SimpleNamespace(user='Guest')), patch.object(webrtc, '_', lambda x: x):
            with self.assertRaises(frappe.AuthenticationError):
                webrtc._login()

    def test_duplicate_final_and_old_call_cannot_release_new_reservation(self):
        row = frappe._dict(name='CALL', status='Completed', request_json=json.dumps({
            'source': 'vobiz_system_call', 'call_device': 'Browser Softphone'}))
        lifecycle.release_locked(self.mapping, row)
        self.assertEqual(self.mapping.availability_status, 'Offline')
        lifecycle.release_locked(self.mapping, row)
        self.mapping.current_call_log = 'NEW'
        lifecycle.release_locked(self.mapping, row)
        self.db.set_value.assert_called_once()

    def test_cancellation_origin_survives_retry_without_inventing_manual_click(self):
        original = diagnostics.cancellation_context({}, 'media_timeout', {'online': False})
        retried = diagnostics.cancellation_context(original, 'manual_button', {'online': True})
        self.assertEqual(retried, original)
        self.assertEqual(diagnostics.cancellation_context({})['cancel_origin'], 'legacy_unspecified')
        self.assertEqual(diagnostics.cancellation_context({}, 'forged')['cancel_origin'], 'legacy_unspecified')

    def test_diagnostics_remove_secrets_and_unbounded_values(self):
        clean = diagnostics.evidence({'token': 'SECRET', 'phone': '1234567890',
            'online': False, 'registered': 'true', 'http_status': 417,
            'media_lost_ms': float('inf'), 'exception': 'SECRET'})
        self.assertEqual(clean, {'online': False, 'http_status': 417})
        self.assertEqual(diagnostics.evidence('{broken'), {})

    def test_diagnostics_enforce_call_owner_before_logging(self):
        self.db.get_value.return_value = 'other'
        with self.assertRaises(frappe.PermissionError):
            diagnostics.record_browser_diagnostic('CALL', 'heartbeat_failed', '{}')
        self.logger.info.assert_not_called()
        self.cache.set.assert_not_called()

    def test_diagnostics_throttle_and_allow_only_known_fields(self):
        self.db.get_value.return_value = 'agent'
        self.cache.set.side_effect = [True, False]
        for _ in range(2):
            diagnostics.record_browser_diagnostic('CALL', 'heartbeat_failed', '{"token":"SECRET","http_status":417}')
        self.logger.info.assert_called_once()
        self.assertNotIn('SECRET', self.logger.info.call_args.args[0])
        self.assertEqual(self.cache.set.call_args.kwargs, {'nx': True, 'ex': 30})

    def test_callback_trace_records_status_and_timing_without_tokens(self):
        request = SimpleNamespace(path='/api/method/vobiz_system_call.api.webrtc.provider_event')
        self.local.request = request
        self.local.form_dict = {'call_log': 'CALL', 'token': 'SECRET', 'CallUUID': 'uuid',
                                'phone': '1234567890', 'response': 'SECRET'}
        response = SimpleNamespace(status_code=500, headers={})
        http.before_request(); http.after_request(request, response)
        data = json.loads(self.logger.info.call_args.args[0])
        self.assertEqual(data['status'], 500)
        self.assertEqual(data['call_log'], 'CALL')
        self.assertGreaterEqual(data['elapsed_ms'], 0)
        self.assertEqual(data['trace_id'], response.headers['X-Vobiz-Trace-Id'])
        self.logger.setLevel.assert_called_with(logging.INFO)
        self.assertNotIn('SECRET', json.dumps(data))

    def test_callback_logging_failure_cannot_change_provider_response(self):
        self.logger.info.side_effect = OSError('full disk')
        response = SimpleNamespace(status_code=200, headers={})
        http.after_request(SimpleNamespace(path='/api/method/vobiz_system_call.api.webrtc.answer'), response)
        self.assertEqual(response.status_code, 200)

    def test_normal_fast_heartbeat_does_not_fill_logs(self):
        request = SimpleNamespace(path='/api/method/vobiz_system_call.api.webrtc.browser_presence')
        self.local.request = request
        http.before_request()
        http.after_request(request, SimpleNamespace(status_code=200, headers={}))
        self.logger.info.assert_not_called()


if __name__ == '__main__':
    unittest.main()
