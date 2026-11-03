#!/usr/bin/env python3
"""Provision isolated local test users and provider endpoints. Never places calls."""
import json,os,secrets
from pathlib import Path
import requests
BENCH=Path('/home/mit/frappe-bench')
os.chdir(BENCH/'sites')
import frappe
frappe.init(site='site1.local',sites_path=str(BENCH/'sites'));frappe.connect();frappe.set_user('Administrator')
frappe.flags.mute_emails=True
from frappe.utils.password import update_password
from vobiz_click_to_call.services.client import VobizClient
client=VobizClient();assert client.auth_id=='MA_ES35Z0CX','Wrong provider account'
APP='21315996863031157';ORIGIN='https://tables-valuables-galvanize.ngrok-free.dev'
assert frappe.get_doc('Vobiz Settings').webhook_base_url==ORIGIN
headers={'X-Auth-ID':client.auth_id,'X-Auth-Token':client.auth_token}
base=client.base_url+'/Account/'+client.auth_id
private=Path('/tmp/vobiz-load-private.json')
state=json.loads(private.read_text()) if private.exists() else {'agents':[]}
def save():
 private.write_text(json.dumps(state));private.chmod(0o600)
r=requests.get(base+'/Endpoint/',headers=headers,params={'limit':100},timeout=20);r.raise_for_status()
endpoints=r.json()['objects']
caller='+919262175565'
try:
 for n in range(1,31):
  user=f'vobiz.sim.agent{n:02d}@example.invalid'
  item=next((x for x in state['agents'] if x['user']==user),None)
  if not item:
   item={'user':user,'password':secrets.token_urlsafe(24),'sip_password':secrets.token_urlsafe(24),'alias':f'LOCAL-LOAD-20261102-{n:02d}'};state['agents'].append(item);save()
  if not frappe.db.exists('User',user):
   frappe.get_doc({'doctype':'User','email':user,'first_name':f'Vobiz Load Agent {n:02d}','enabled':1,'user_type':'System User','send_welcome_email':0,'roles':[{'role':'Sales User'}]}).insert()
  update_password(user,item['password'],logout_all_sessions=False)
  endpoint=next((e for e in endpoints if e.get('alias')==item['alias']),None)
  if not endpoint:
   resp=requests.post(base+'/Endpoint/',headers=headers,json={'username':f'localtest{n:02d}','password':item['sip_password'],'alias':item['alias'],'app_id':APP},timeout=20)
   if resp.status_code not in (200,201,202):raise RuntimeError('Endpoint creation HTTP '+str(resp.status_code))
   data=resp.json();item['endpoint_id']=data.get('endpoint_id');save()
   q=requests.get(base+'/Endpoint/'+str(item['endpoint_id'])+'/',headers=headers,timeout=20);q.raise_for_status();endpoint=q.json();endpoints.append(endpoint)
  item['endpoint_id']=endpoint['endpoint_id'];
  endpoint_url=base+'/Endpoint/'+item['endpoint_id']+'/'
  attached=requests.post(endpoint_url,headers=headers,json={'app_id':APP},timeout=20);attached.raise_for_status()
  verified=requests.get(endpoint_url,headers=headers,timeout=20);verified.raise_for_status()
  assert str(verified.json().get('application','')).endswith('/'+APP+'/'), 'Endpoint application missing'
  item['sip_username']=endpoint['username'];item['sip_uri']=endpoint['sip_uri'];save()
  values={'user':user,'enabled':1,'agent_mobile':caller,'caller_id':caller,'queue_source':'CRM Lead','agent_call_device':'Browser Softphone','browser_softphone_enabled':1,'browser_softphone_username':item['sip_username'],'browser_softphone_endpoint_uri':item['sip_uri'],'browser_softphone_password':item['sip_password'],'accept_calls':0,'availability_status':'Offline','auto_available_after_call':1,'notes':'Isolated local load test. Browser only. Do not use for mobile bridge.'}
  doc=frappe.get_doc('Vobiz User Mapping',user) if frappe.db.exists('Vobiz User Mapping',user) else frappe.new_doc('Vobiz User Mapping')
  if doc.get('current_call_log'):raise RuntimeError('Test mapping has active call')
  doc.update(values);doc.save()
  
  if not frappe.db.exists('User Permission',{'user':user,'allow':'SR Lead Pipeline','for_value':'Vobiz Simulator'}):
   frappe.get_doc({'doctype':'User Permission','user':user,'allow':'SR Lead Pipeline','for_value':'Vobiz Simulator','apply_to_all_doctypes':1}).insert()
  frappe.db.commit();print('READY',n,user,flush=True)
 for i,lead in enumerate(['CRM-LEAD-2026-07373','CRM-LEAD-2026-07374','CRM-LEAD-2026-07375']):
  d=frappe.get_doc('CRM Lead',lead);d.lead_owner=state['agents'][i]['user'];d.save();state['agents'][i]['lead']=lead
 frappe.db.commit();save()
 out=BENCH/'test-results/vobiz-load-30';out.mkdir(exist_ok=True)
 (out/'fixtures.json').write_text(json.dumps({'site':'site1.local','agents':[{k:v for k,v in a.items() if k not in ['password','sip_password']} for a in state['agents']],'max_real_calls':9,'max_concurrent_real_calls':3},indent=2))
 print('COMPLETE: 30 local users, independent endpoints, 3 lead owners')
finally:frappe.destroy()
