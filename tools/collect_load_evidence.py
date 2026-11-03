import os,json
from pathlib import Path
os.chdir('/home/mit/frappe-bench/sites');import frappe
frappe.init(site='site1.local',sites_path=os.getcwd());frappe.connect();frappe.set_user('Administrator')
from vobiz_click_to_call.services.client import VobizClient
client=VobizClient();rows=[]
output=Path('/home/mit/frappe-bench/test-results/vobiz-load-30/provider-verification.json')
cache={}
if output.exists():
 for prior in json.loads(output.read_text()):
  for cdr in [prior.get('provider_parent',{})]+prior.get('provider_customer',[]):
   if cdr.get('uuid') and cdr.get('end_time'):cache[cdr['uuid']]=cdr
errors=[]
def retrieve(uid):
 if uid in cache:return cache[uid]
 try:return client.retrieve_cdr(uid).get('data',{})
 except Exception as e:
  errors.append({'uuid':uid,'error_type':type(e).__name__});return {}

keys=['uuid','call_direction','answer_time','start_time','end_time','billsec','duration','hangup_cause_code','hangup_cause_name','hangup_source','packet_loss','jitter','mos']
for item in frappe.get_all('Vobiz Call Log',filters={'user':['like','vobiz.sim.agent%']},pluck='name',order_by='creation asc'):
 d=frappe.get_doc('Vobiz Call Log',item);row={'call_log':d.name,'agent':d.user,'erp':{k:d.get(k) for k in ['status','call_status','call_uuid','answer_time','end_time','billsec','duration','b_leg_uuid','dial_status','hangup_cause']}}
 callbacks=json.loads(d.raw_callbacks or '[]');uuids=set();events=[]
 for event in callbacks:
  p=event.get('payload',{});uid=p.get('DialBLegUUID')
  if uid:uuids.add(uid)
  data={k:p[k] for k in ['Event','DialAction','DialStatus','DialBLegStatus','DialBLegUUID','DialBLegDuration','DialBLegBillDuration','DialBLegHangupCause','DialBLegHangupCauseName','DialBLegHangupSource','event','reason'] if k in p}
  if data and data not in events:events.append(data)
 row['events']=events;row['provider_customer']=[]
 if d.call_uuid:
  p=retrieve(d.call_uuid);row['provider_parent']={k:p.get(k) for k in keys}
 for uid in uuids:
  p=retrieve(uid);row['provider_customer'].append({k:p.get(k) for k in keys})
 if not d.call_uuid:row['classification']='Test endpoint was not attached to application. SDK failed. ERP manually completed for fixture cleanup; not a successful call.'
 rows.append(row)
 output.write_text(json.dumps(rows,default=str,indent=2))
 print(item,'ERP',d.status,'customer_billsec',[x.get('billsec') for x in row['provider_customer']],flush=True)
Path('/home/mit/frappe-bench/test-results/vobiz-load-30/provider-verification.json').write_text(json.dumps(rows,default=str,indent=2));Path('/home/mit/frappe-bench/test-results/vobiz-load-30/provider-read-errors.json').write_text(json.dumps(errors,indent=2));frappe.destroy()
