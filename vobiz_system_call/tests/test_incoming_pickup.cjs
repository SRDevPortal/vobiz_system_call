const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),'utf8');
class Request extends Promise{always(fn){return this.finally(fn);}}
const flush=()=>new Promise(setImmediate);
function setup(){
 const timers=[],intervals=[],dialogs=[],requests=[],handlers={},hidden={};
 const ctx={console,window:{},__:x=>x,setTimeout(fn){timers.push(fn);return fn;},clearTimeout(){},setInterval(fn){intervals.push(fn);return fn;},clearInterval(){},
 frappe:{pages:{'vobiz-agent-console':{}},utils:{escape_html:x=>x},msgprint(){},show_alert(){},
 call(method,args){requests.push({method:typeof method==='string'?method:method.method,args:args||method.args});return Request.resolve({message:{}});},
 ui:{Dialog:function(config){
  const d=this;d.config=config;d.values={};d.fields_dict={};d.visible=false;d.shows=0;d.hides=0;d.events={};
  const button={prop(){return button;},text(){return button;}};
  for(const f of config.fields){d.values[f.fieldname]=f.default||'';d.fields_dict[f.fieldname]={df:f,$input:{on(event,fn){this.change=fn;}}};}
  d.$wrapper={on(event,fn){d.events[event]=fn;},find(){return {text(value){d.countdown=value;}};}};
  d.show=()=>{d.visible=true;d.shows++;};d.hide=()=>{d.visible=false;d.hides++;d.events['hidden.bs.modal']?.();};
  d.get_close_btn=()=>({hide(){}});d.get_primary_btn=()=>button;d.get_value=k=>d.values[k];d.set_value=(k,v)=>{d.values[k]=v;};
  d.set_df_property=(k,prop,v)=>{d.fields_dict[k].df[prop]=v;};dialogs.push(d);
 }}}};
 vm.createContext(ctx);vm.runInContext(source+'\nthis.Class=VobizAgentConsole;',ctx);
 const c=Object.create(ctx.Class.prototype),sdk={on(event,fn){handlers[event]=fn;},answer:()=>true},client={client:sdk};
 c.state={softphone:{client,registered:true,config:{call_device:'Browser Softphone'},network_issues:{}},active_call:null,auto_dial:{},queue:[],lead_disposition_context:{status:'Fresh',status_options:['Fresh','Agent Not Available'],options:[]}};
 c.page={main:{find(selector){const el={toggleClass(cls,value){if(cls==='hidden')hidden[selector]=value;return el;},attr(){return el;},text(){return el;},prop(){return el;},html(){return el;}};return el;}}};
 for(const method of ['stop_browser_microphone_test','attach_browser_softphone_audio','render_queue','start_timer','start_browser_network_monitor','load','render_dispositions'])c[method]=()=>{};
 for(const method of ['browser_softphone_network_message','browser_softphone_diagnostics_html','browser_softphone_live_html'])c[method]=()=>'';
 c.browser_softphone_reconnecting=()=>false;c.show_softphone_use_here=()=>false;c.sync_browser_softphone_event=()=>Promise.resolve();c.get_softphone_tab_id=()=> 'tab';
 c.bind_browser_softphone_events(client);
 const ring=(id='C1')=>Object.assign(c.state.softphone,{current_call_log:id,incoming_call_uuid:'SDK-'+id,sdk_call_uuid:'SDK-'+id,incoming_caller:'caller',incoming_pending:true,incoming_answering:false,incoming_answered:false,in_call:true,status:'Incoming Call'});
 const ended=()=>{Object.assign(c.state.softphone,{current_call_log:'',in_call:false,incoming_pending:false,incoming_call_uuid:'',incoming_caller:''});c.state.active_call=null;};
 const call=(name='OLD')=>({name,status:'Completed',direction:'Outgoing',reference_doctype:'CRM Lead',reference_name:'LEAD-'+name});
 const open=(name='OLD',done)=>c.open_post_call_disposition_dialog(call(name),{doctype:'CRM Lead',name:'LEAD-'+name},done,{disposition_context_refreshed:true,force_timer:true});
 return {c,ctx,sdk,handlers,hidden,ring,ended,call,open,timers,intervals,dialogs,requests};
}
test('Pickup waits for the incoming invite to be linked to its server call',()=>{
 const t=setup();Object.assign(t.c.state.softphone,{incoming_call_uuid:'SDK-UNLINKED',incoming_pending:true});let answers=0;t.sdk.answer=()=>answers++;
 t.c.answer_browser_softphone();assert.equal(answers,0);assert.equal(t.c.browser_incoming_waiting(),false);
});
test('incoming call during the disposition opening animation hides the form after shown',()=>{
 const t=setup();t.open();const d=t.dialogs[0];let hides=0;
 d.hide=()=>{hides++;if(hides===1)return;d.visible=false;d.events['hidden.bs.modal']();};
 t.ring();t.c.render_browser_softphone();assert.equal(d.visible,true);
 d.events['shown.bs.modal']();assert.equal(d.visible,false);assert.equal(t.c.post_call_disposition.hiding,false);
});
test('SDK false leaves Pickup available without displaying a connected call',()=>{
 const t=setup();t.ring();t.sdk.answer=()=>false;t.c.answer_browser_softphone();
 assert.equal(t.c.state.softphone.status,'Incoming Call');assert.equal(t.c.state.softphone.incoming_call_uuid,'SDK-C1');
 assert.equal(t.c.state.softphone.incoming_answering,false);assert.equal(t.hidden['[data-action="softphone-answer"]'],false);
});
test('one answer request waits for matching confirmation and suppresses repeated clicks',()=>{
 const t=setup();t.ring();let calls=0;t.sdk.answer=()=>{calls++;return true;};
 t.c.answer_browser_softphone();t.c.answer_browser_softphone();
 assert.equal(calls,1);assert.equal(t.c.state.softphone.status,'Connecting…');assert.equal(t.c.state.softphone.incoming_call_uuid,'SDK-C1');
 t.handlers.onCallAnswered({callUUID:'OTHER'});assert.equal(t.c.state.softphone.status,'Connecting…');
 t.handlers.onCallAnswered({callUUID:'SDK-C1'});assert.equal(t.c.state.softphone.status,'In Call');assert.equal(t.hidden['[data-action="softphone-answer"]'],true);
});
test('thrown and rejected answer failures restore Pickup',async()=>{
 for(const mode of ['throw','reject','false']){
  const t=setup();t.ring();t.sdk.answer=()=>{if(mode==='throw')throw Error('answer failed');return mode==='reject'?Promise.reject(Error('answer failed')):Promise.resolve(false);};
  t.c.answer_browser_softphone();await flush();assert.equal(t.c.state.softphone.incoming_answering,false);assert.equal(t.c.state.softphone.status,'Incoming Call');
 }
});
test('late answer rejection cannot change a newer call',async()=>{
 const t=setup();t.ring();let reject;t.sdk.answer=()=>new Promise((_,r)=>{reject=r;});t.c.answer_browser_softphone();t.ring('C2');
 reject(Error('old failure'));await flush();assert.equal(t.c.state.softphone.current_call_log,'C2');assert.equal(t.c.state.softphone.error,'');
});
test('registration during ringing or answering does not hide Pickup or overwrite call status',()=>{
 for(const answering of [false,true]){
  const t=setup();t.ring();if(answering)t.c.answer_browser_softphone();
  t.handlers.onLogin();assert.equal(t.c.state.softphone.status,answering?'Connecting…':'Incoming Call');assert.equal(t.hidden['[data-action="softphone-answer"]'],false);
 }
});
test('an older incoming cancellation cannot clear the current invite',()=>{
 const t=setup();t.ring('C2');t.handlers.onIncomingCallCanceled({callUUID:'SDK-C1'});
 assert.equal(t.c.state.softphone.incoming_call_uuid,'SDK-C2');assert.equal(t.c.state.softphone.incoming_pending,true);
});
test('out-of-order incoming lookup responses cannot attach the older invite to a newer call',async()=>{
 const t=setup(),resolvers=[];t.ctx.frappe.call=()=>new Request(resolve=>resolvers.push(resolve));
 t.c.browser_softphone_incoming('caller',{}, {callUUID:'OLD'});t.c.browser_softphone_incoming('caller',{}, {callUUID:'NEW'});
 resolvers[1]({message:{call_log:'C2',customer_number:'caller'}});await flush();
 resolvers[0]({message:{call_log:'C1',customer_number:'caller'}});await flush();
 assert.equal(t.c.state.softphone.current_call_log,'C2');assert.equal(t.c.state.softphone.incoming_call_uuid,'NEW');
});
test('disposition keeps values and pauses timer while another call is active, then resumes after confirmed end',()=>{
 const t=setup();let done=0;t.open('OLD',()=>done++);const d=t.dialogs[0];d.values.notes='Keep my notes';d.values.lead_status='Fresh';
 t.intervals[0]();assert.equal(d.countdown,'59');
 t.ring();t.c.render_browser_softphone();assert.equal(d.visible,false);assert.equal(done,0);
 t.intervals[0]();assert.equal(d.countdown,'59');d.config.primary_action(d.values);assert.equal(t.requests.length,0);
 t.ended();t.c.render_browser_softphone();assert.equal(d.visible,false,'SDK reset alone is not verified termination');
 t.c.maybe_prompt_workdesk_disposition(t.call('C1'));
 assert.equal(d.visible,true);assert.equal(d.values.notes,'Keep my notes');assert.equal(d.values.lead_status,'Fresh');
 t.intervals[0]();assert.equal(d.countdown,'58');
});
test('successive completed calls queue once instead of stacking forms',async()=>{
 const t=setup();t.open('OLD');const first=t.dialogs[0];
 t.open('NEXT');t.open('NEXT');assert.equal(t.dialogs.length,1);assert.equal(t.c.pending_post_call_dispositions.size,1);
 first.config.primary_action({lead_status:'Fresh',notes:'saved'});await flush();
 assert.equal(t.requests.filter(r=>r.method.endsWith('save_disposition')).length,1);
 t.timers.shift()();await flush();
 assert.equal(t.dialogs.length,2);assert.equal(first.visible,false);assert.equal(t.dialogs[1].visible,true);
 assert.equal(t.c.state.active_disposition_call_log,'NEXT');
});
test('a disposition save already in flight completes without resuming the form over a new call',async()=>{
 const t=setup();t.open();let resolve;
 t.ctx.frappe.call=()=>new Request(r=>{resolve=r;});
 const d=t.dialogs[0];d.config.primary_action({lead_status:'Fresh'});
 t.ring();t.c.render_browser_softphone();resolve({message:{}});await flush();
 assert.equal(d.visible,false);assert.equal(t.c.post_call_disposition,null);assert.equal(t.c.state.softphone.current_call_log,'C1');
});
