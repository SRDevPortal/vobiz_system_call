import os,json,time,concurrent.futures
from pathlib import Path
import requests
os.chdir('/home/mit/frappe-bench/sites');import frappe
frappe.init(site='site1.local',sites_path=os.getcwd());frappe.connect();frappe.set_user('Administrator')
from vobiz_system_call.api.webrtc import _provider_call_token
names=['CTC-iEUx8UdIiLg5qNb9l4gxzobn','CTC-Ym7UXVB9eHaLESJAM8q0fCZS','CTC-1S3U9TNNtSp6AoN9huXYEfK5']
fields=['status','answer_time','end_time','billsec','duration','call_uuid']
fixtures=[];before={}
for name in names:
 d=frappe.get_doc('Vobiz Call Log',name);assert d.status in ['Completed','No Answer','Cancelled','Busy','Failed']
 events=[x['payload'] for x in json.loads(d.raw_callbacks or '[]') if x['event']=='provider-event' and (x['payload'].get('DialAction')=='hangup' or x['payload'].get('Event')=='Redirect')]
 assert events,'No terminal callback captured'
 payload=events[-1].copy();payload.pop('token',None);payload.pop('cmd',None)
 fixtures.append((name,_provider_call_token(d),payload));before[name]={k:d.get(k) for k in fields}
frappe.destroy()
def send(i):
 name,token,payload=fixtures[i%3];t=time.monotonic()
 r=requests.post('http://127.0.0.1:8000/api/method/vobiz_system_call.api.webrtc.provider_event',params={'call_log':name,'token':token,'final':'1'},data=payload,timeout=30)
 return {'call_log':name,'status':r.status_code,'ms':round((time.monotonic()-t)*1000,1)}
with concurrent.futures.ThreadPoolExecutor(max_workers=30) as pool:rows=list(pool.map(send,range(90)))
frappe.init(site='site1.local',sites_path=os.getcwd());frappe.connect()
after={name:{k:frappe.get_doc('Vobiz Call Log',name).get(k) for k in fields} for name in names};frappe.destroy()
from collections import Counter
lat=sorted(r['ms'] for r in rows);report={'type':'Replay captured final callbacks through real local HTTP handler, not provider traffic','requests':90,'concurrency':30,'statuses':dict(Counter(r['status'] for r in rows)),'p95_ms':lat[int((len(lat)-1)*.95)],'unchanged_terminal_records':before==after,'before':before,'after':after,'requests_detail':rows}
Path('/home/mit/frappe-bench/test-results/vobiz-load-30/callback-replay.json').write_text(json.dumps(report,default=str,indent=2));print({k:v for k,v in report.items() if k not in ['before','after','requests_detail']})
