const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const tick = () => new Promise(setImmediate);
const call = (name = 'CALL1') => ({name, status: 'Completed', reference_doctype: 'CRM Lead', reference_name: 'LEAD1', disposition: ''});
class Request extends Promise { always(fn) { return this.then(v => {fn(); return v;}, e => {fn(); return undefined;}); } }
function setup() {
 const dialogs = [], requests = [], timers = [];
 let server = call(), failStatus = false, failSave = false, saveResolve;
 const chain = {prop(){return this;},text(){return this;},hide(){},on(){}};
 const ctx = {console, __: s=>s, window: {}, clearInterval(){}, setTimeout(fn){timers.push(fn); return timers.length;}, frappe: {
  pages: {'vobiz-agent-console': {}}, utils: {escape_html:s=>s}, show_alert(){}, msgprint(){},
  ui: {Dialog: function(config) {
   dialogs.push(this); this.config=config; this.values={}; this.fields_dict={}; const events={};
   for(const f of config.fields) {this.values[f.fieldname]=f.default||''; this.fields_dict[f.fieldname]={df:f,$input:chain};}
   this.$wrapper={on:(event,fn)=>{events[event]=fn;},find:()=>chain};
   this.show=()=>{}; this.hide=()=>events['hidden.bs.modal']?.();
   this.get_primary_btn=()=>chain; this.get_close_btn=()=>chain;
   this.get_value=n=>this.values[n]; this.set_value=(n,v)=>{this.values[n]=v;};
   this.set_df_property=(n,k,v)=>{this.fields_dict[n].df[k]=v;};
  }},
  call(method,args) {
   if(typeof method==='object') {args=method.args;method=method.method;}
   requests.push({method,args});
   return new Request((resolve,reject)=>{
    if(method.endsWith('get_context')) resolve({message:{ndr:false}});
    else if(method.endsWith('get_call_status')) failStatus ? reject(new Error('offline')) : resolve({message:{...server}});
    else if(method.endsWith('save_disposition')) {saveResolve=()=>failSave ? reject(new Error('Save failed')) : resolve({message:{call_log:args.call_log}});}
    else throw new Error('Unexpected request: '+method);
   });
  }
 }};
 vm.createContext(ctx); vm.runInContext(source+';this.Console=VobizAgentConsole;',ctx);
 const obj=Object.create(ctx.Console.prototype);
 obj.state={lead_disposition_context:{status:'Fresh',status_options:['Fresh','Interested'],options:[]}};
 obj.is_patient_disposition_reference=()=>false; obj.patient_followup_status_options=()=>[]; obj.load=()=>{};
 const open=(c=call(),done)=>obj.open_post_call_disposition_dialog(c,{doctype:'CRM Lead',name:'LEAD1'},done,{disposition_context_refreshed:true});
 return {obj,dialogs,requests,timers,open,server:v=>server=v,failStatus:()=>failStatus=true,failSave:()=>failSave=true,resolveSave:()=>saveResolve()};
}
test('saved CRM status with empty disposition is suppressed after refresh', async()=>{
 const h=setup();h.server({...call(),disposition_at:'2026-11-16 12:00:00'});let done=0;
 h.open(call(),()=>done++);await tick();
 assert.equal(h.dialogs.length,0);assert.equal(done,1);
 assert.equal(h.requests.find(r=>r.method.endsWith('get_call_status')).args.sync_provider,0);
});
test('save clears its queued copy and late events cannot reprompt after another call',async()=>{
 const h=setup();h.open();await tick();assert.equal(h.dialogs.length,1);
 h.obj.queue_post_call_disposition(call(),{},null,{});
 h.obj.queue_post_call_disposition(call('CALL2'),{},null,{});
 const d=h.dialogs[0]; d.config.primary_action({lead_status:'Interested',disposition:'',notes:'Saved CRM status'});
 assert.equal(h.obj.has_saved_call_disposition(call()),false,'in-flight save is not success');
 h.resolveSave();await tick();
 assert.equal(h.obj.pending_post_call_dispositions.has('CALL1'),false);
 assert.equal(h.obj.pending_post_call_dispositions.has('CALL2'),true);
 h.obj.state.disposition_prompted_call_log='CALL2';
 h.obj.maybe_prompt_workdesk_disposition(call());h.open();await tick();
 assert.equal(h.dialogs.length,1);assert.equal(h.obj.post_call_disposition,null);
});
test('failed save leaves form retryable and does not mark the call saved',async()=>{
 const h=setup();h.open();await tick();h.failSave();
 h.dialogs[0].config.primary_action({lead_status:'Interested',disposition:''});h.resolveSave();await tick();
 assert.equal(h.obj.has_saved_call_disposition(call()),false);
 assert.ok(h.obj.post_call_disposition);assert.equal(h.obj.post_call_disposition.saved,undefined);
});
test('duplicate async opens fetch status once and create only one unsaved form',async()=>{
 const h=setup();h.open();h.open();await tick();
 assert.equal(h.dialogs.length,1);
 assert.equal(h.requests.filter(r=>r.method.endsWith('get_call_status')).length,1);
});
test('timestamp evidence survives later thin callback payloads',async()=>{
 const h=setup();h.open({...call(),disposition_at:'2026-11-16 12:00:00'});h.open();await tick();
 assert.equal(h.dialogs.length,0);assert.equal(h.requests.length,0);
});
test('unavailable or wrong-call status retains unsaved work for retry',async()=>{
 for(const failure of ['offline','wrong-call']) {
  const h=setup();failure==='offline'?h.failStatus():h.server(call('OTHER'));
  h.open();await tick();assert.equal(h.dialogs.length,0);
  assert.equal(h.obj.pending_post_call_dispositions.has('CALL1'),true);
  assert.equal(h.obj.has_saved_call_disposition(call()),false);
  assert.equal(h.obj.disposition_opening_call,null);
 }
});
test('queued call rechecks status after another tab saves',async()=>{
 const h=setup();h.obj.state.softphone={current_call_log:'OTHER'};h.open();await tick();
 assert.equal(h.obj.pending_post_call_dispositions.size,1);
 h.server({...call(),disposition_at:'2026-11-16 12:00:00'});
 h.obj.state.softphone={};h.obj.sync_post_call_disposition();h.timers.shift()();await tick();
 assert.equal(h.dialogs.length,0);assert.equal(h.obj.pending_post_call_dispositions.size,0);
});
test('main workdesk save also blocks subsequent automatic popup',async()=>{
 const h=setup();h.obj.state.active_call=call();
 h.obj.page={main:{find:selector=>({val:()=>selector.includes('lead-status')?'Interested':''})}};
 h.obj.save_disposition();h.resolveSave();await tick();h.open();await tick();
 assert.equal(h.dialogs.length,0);assert.equal(h.obj.has_saved_call_disposition(call()),true);
});
