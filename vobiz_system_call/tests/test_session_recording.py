import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock,patch
from xml.etree import ElementTree as ET
import frappe
from vobiz_system_call.api import webrtc
from vobiz_click_to_call.services import recording


class BrowserSessionRecordingTests(unittest.TestCase):
    def test_browser_answer_cannot_mark_customer_connected_for_session_recording(self):
        row=frappe._dict(name='CALL',user='agent@test.invalid',direction='Outgoing',status='Ringing',
            call_uuid='provider-call',request_json='{"source":"vobiz_system_call","call_device":"Browser Softphone"}')
        db=MagicMock();db.get_value.return_value='{"mode":"provider_session"}'
        with patch.object(frappe,'local',SimpleNamespace(flags=frappe._dict(in_test=False),request=None)), \
                patch.object(frappe,'db',db),patch.object(frappe,'session',SimpleNamespace(user=row.user)), \
                patch.object(webrtc,'_login'),patch.object(webrtc.lifecycle,'lock_call',return_value=(frappe._dict(),row)), \
                patch.object(webrtc,'_append_callback_if_enabled'),patch.object(frappe,'enqueue') as enqueue:
            result=webrtc.update_browser_softphone_call('CALL','onCallAnswered',call_uuid='provider-call')
            self.assertEqual(result['status'],'Ringing')
            values=db.set_value.call_args.args[2]
            self.assertNotIn('status',values)
            self.assertNotIn('answer_time',values)
            enqueue.assert_not_called()

    def test_browser_and_direct_incoming_dial_record_before_connecting(self):
        settings=frappe._dict(enable_recording=1,max_call_duration=3600)
        db=MagicMock();db.get_value.return_value={}
        row=frappe._dict(name='CALL',call_uuid='provider-call',callback_token='secret',direction='Outgoing')
        with patch.object(frappe,'db',db),patch.object(webrtc,'get_settings',return_value=settings), \
                patch.object(webrtc,'_dial_attrs',return_value='timeout="30"'), \
                patch.object(webrtc,'provider_phone_number',side_effect=lambda n:n), \
                patch.object(recording,'build_callback_url',return_value='https://erp.invalid/callback'):
            for method,target,tag in [(webrtc._dial_number_xml,'+910000000001','Number'),
                    (webrtc._dial_user_xml,'sip:agent@registrar.invalid','User')]:
                root=ET.fromstring(method(target,'+910000000002',row))
                self.assertEqual([e.tag for e in root],['Record','Dial'])
                self.assertEqual(root.find('Dial/'+tag).text,target)
                self.assertEqual(root.find('Record').get('recordSession'),'true')
            row.request_json='{"call_device":"Mobile Bridge"}'
            row.direction='Incoming'
            root=ET.fromstring(webrtc._dial_agent_xml('+910000000001','+910000000002',row))
            self.assertIsNotNone(root.find('Record'))
            self.assertIsNotNone(root.find('Dial/Number'))

    def test_answer_notifications_do_not_queue_duplicate_session_recording(self):
        db=MagicMock();db.get_value.return_value='{"mode":"provider_session"}'
        with patch.object(frappe,'db',db),patch.object(frappe,'enqueue') as enqueue:
            webrtc._enqueue_recording_start('CALL')
            enqueue.assert_not_called()


if __name__=='__main__':unittest.main()
