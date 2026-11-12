const test=require('node:test'), assert=require('node:assert/strict'), fs=require('fs'),path=require('path'),vm=require('node:vm');
function setup(){
 const requests=[],errors=[],alerts=[];const ctx={frappe:{pages:{'vobiz-agent-console':{}},call:args=>{
  requests.push(args);return Promise.resolve({message:{name:'C1',status:'Cancelled',local_reset:true,retry_allowed:true,reference_doctype:'CRM Lead',reference_name:'LEAD'}});
 },msgprint:m=>errors.push(m),show_alert:a=>alerts.push(a)},__:s=>s,console,document:{},window:{},$:()=>({trigger(){}})};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),'utf8')+';this.Console=VobizAgentConsole;',ctx);
 const c=Object.create(ctx.Console.prototype);let hung=0,loggedOut=0,closed=0,tracksStopped=0;
 const sdk={getCallUUID:()=> 'uuid',hangup(){assert.equal(c.state.softphone.client,null);hung++;return new Promise(()=>{});},
 logout(){loggedOut++;return new Promise(()=>{});},getPeerConnection:()=>({getSenders:()=>[{track:{stop(){tracksStopped++;}}}],close(){closed++;}})};
 c.state={active_call:{name:'C1',status:'Initiated'},softphone:{client:{client:sdk},current_call_log:'C1',sdk_call_uuid:'uuid',registered:true,config:{call_device:'Browser Softphone'}}};
 c.browser_request_with_timeout=p=>p;c.render_header_active_call=()=>{};c.load=()=>{};
 for(const n of ['stop_browser_network_monitor','stop_browser_microphone_test','stop_browser_softphone_audio','render_browser_softphone','clear_tracked_live_call','update_workdesk_primary_action'])c[n]=()=>{};
 c.reset_browser_softphone_call_state=()=>{c.state.softphone.current_call_log='';c.state.softphone.in_call=false;c.cleaned=(c.cleaned||0)+1;};
 c.handle_call_disconnected=()=>{};c.check_browser_microphone=async()=>true;c.connect_browser_softphone=async()=>{c.state.softphone.registered=true;};c.browser_softphone_reconnecting=()=>false;
 return {c,ctx,requests,errors,alerts,counts:()=>({hung,loggedOut,closed,tracksStopped})};
}
test('local reset completes despite hanging SDK hangup/logout; next click explicitly retries',async()=>{
 const t=setup();let starts=0,row;t.c.start_call_for_row=async r=>{starts++;row=r;};
 const p=t.c.complete_header_active_call();await t.c.complete_header_active_call();await p;
 assert.equal(t.requests.length,1);assert.equal(starts,0);assert.equal(t.c.state.softphone.current_call_log,'');
 assert.equal(t.requests[0].method,'vobiz_system_call.api.call.complete_call_from_button');
 assert.equal(t.requests[0].type,'POST');
 assert.equal(t.alerts[0].indicator,'orange');
 assert.match(t.alerts[0].message,/end has not been confirmed/);
 assert.deepEqual(t.counts(),{hung:1,loggedOut:1,closed:1,tracksStopped:1});
 await t.c.softphone_reset_promise;await t.c.complete_header_active_call();
 assert.equal(starts,1);assert.equal(row.retry_of,'C1');assert.equal(t.errors.length,0);
});
test('ERP failure, old API and mismatched response do not clear the browser',async()=>{
 for(const mode of ['reject','wrong','old']){
  const t=setup();t.ctx.frappe.call=()=>mode==='reject'?Promise.reject(Error('ERP unavailable')):Promise.resolve({message:{name:mode==='wrong'?'C2':'C1',status:'Completed'}});
  await t.c.complete_header_active_call();assert.equal(t.c.cleaned,undefined);assert.equal(t.c.state.softphone.current_call_log,'C1');assert.equal(t.errors.length,1);
 }
});
test('a late reset response cannot dispose a newer call',async()=>{
 const t=setup();let resolve;t.ctx.frappe.call=()=>new Promise(r=>resolve=r);
 const p=t.c.complete_header_active_call();t.c.state.active_call={name:'C2',status:'Connected'};t.c.state.softphone.current_call_log='C2';
 resolve({message:{name:'C1',status:'Cancelled',local_reset:true}});await p;
 assert.equal(t.c.cleaned,undefined);assert.equal(t.counts().hung,0);assert.equal(t.c.state.active_call.name,'C2');
});
test('mic or registration failure does not keep the old call reserved',async()=>{
 for(const mode of ['mic','registration']){
  const t=setup();if(mode==='mic')t.c.check_browser_microphone=async()=>false;else t.c.connect_browser_softphone=async()=>{throw Error('registration failed');};
  await t.c.complete_header_active_call();const reconnect=t.c.softphone_reset_promise;
  if(reconnect)await reconnect.catch(()=>{});await new Promise(r=>setImmediate(r));
  assert.equal(t.c.state.softphone.current_call_log,'');assert.equal(t.c.state.completion_retry_candidate.name,'C1');
  assert.equal(t.c.state.completing_call_log,'');assert.ok(t.c.state.softphone.error);
 }
});
test('new call waits only for browser readiness and keeps single-start guard',async()=>{
 const t=setup();t.c.state.softphone.current_call_log='';t.c.get_softphone_tab_id=()=> 'tab';
 let browserReady;t.c.softphone_reset_promise=new Promise(r=>browserReady=r);
 let resolve;t.ctx.frappe.call=args=>{t.requests.push(args);return new Promise(r=>resolve=r);};
 const row={doctype:'CRM Lead',name:'LEAD',retry_of:'C1'};const first=t.c.start_call_for_row(row);await t.c.start_call_for_row(row);
 assert.equal(t.requests.length,0);browserReady();for(let i=0;i<15&&!resolve;i++)await Promise.resolve();
 assert.equal(t.requests.length,1);assert.equal(t.requests[0].method,'vobiz_system_call.api.call.retry_call_log');
 assert.deepEqual(Object.keys(t.requests[0].args).sort(),['call_log','tab_id']);resolve({message:{}});await first;
});
test('idle button does nothing',async()=>{const t=setup();t.c.state.active_call={};await t.c.complete_header_active_call();assert.equal(t.requests.length,0);});
test('a late startup response after reset never starts the old SDK call',async()=>{
 const t=setup();t.c.state.softphone.current_call_log='';t.c.get_softphone_tab_id=()=> 'tab';
 let resolve;t.ctx.frappe.call=()=>new Promise(r=>resolve=r);
 let dials=0;t.c.start_browser_softphone_call=async()=>{dials++;};
 const pending=t.c.start_call_for_row({doctype:'CRM Lead',name:'LEAD',phone_field:'mobile_no',phone:'9999999999'},null,true);
 for(let i=0;i<4&&!resolve;i++)await Promise.resolve();
 t.c.state.softphone.retired_call_logs=['C1'];
 resolve({message:{call_log:'C1',browser_softphone:true}});
 await assert.rejects(pending,/was reset/);assert.equal(dials,0);
});
test('an older request finishing cannot clear the newer in-flight guard',async()=>{
 const t=setup();const resolvers=[];t.c.perform_start_call_for_row=()=>new Promise(r=>resolvers.push(r));
 const old=t.c.start_call_for_row({name:'OLD'});await Promise.resolve();
 t.c.start_call_in_flight=null;
 const next=t.c.start_call_for_row({name:'NEW'});await Promise.resolve();
 const guard=t.c.start_call_in_flight;resolvers[0]({});await old;
 assert.equal(t.c.start_call_in_flight,guard);resolvers[1]({});await next;
 assert.equal(t.c.start_call_in_flight,null);
});
