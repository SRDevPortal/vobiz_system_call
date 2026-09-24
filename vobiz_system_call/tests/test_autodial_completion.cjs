const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const completed = {name: 'C1', status: 'Completed', direction: 'Outgoing', reference_doctype: 'CRM Lead', reference_name: 'LEAD1'};
class Request extends Promise {always(fn) {return this.finally(fn);}}
const flush = () => new Promise(setImmediate);

function setup() {
    const timers = [], opened = [], requests = [];
    const ctx = {frappe: {pages: {'vobiz-agent-console': {}}, call(method) {
        const name = typeof method === 'string' ? method : method.method;
        requests.push(name);
        return Request.resolve({message: name.endsWith('get_agent_console_data')
            ? {active_call: {mapping: 'agent', availability_status: 'Available'}, queue: [], ai_disposition_enabled: false}
            : completed});
    }}, __: x => x, console, window: {},
        setTimeout(fn) {timers.push(fn); return fn;}, clearTimeout() {}, clearInterval() {}, setInterval() {}};
    vm.createContext(ctx); vm.runInContext(source + '\nthis.Class = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.Class.prototype);
    const client = {client: {getCallUUID: () => ''}};
    obj.state = {softphone: {client, current_call_log: 'C1', registered: true, in_call: true,
        recovery_verification: {call_log: 'C1'}, network_issues: {}}, active_call: {...completed, status: 'Connected'},
        auto_dial: {}, queue: [], queue_filters: [], ai_disposition_enabled: false};
    obj.page = {main: {find: () => ({val: () => ''})}};
    obj.agent_console_targets = () => ({text() {}});
    obj.browser_request_with_timeout = p => p;
    obj.is_console_visible = () => true;
    obj.default_queue_meta = () => ({});
    obj.set_browser_network_issue = () => {};
    for (const name of ['stop_browser_softphone_audio', 'stop_timer', 'render_browser_softphone', 'render_queue',
        'render_workdesk_live_call', 'update_workdesk_primary_action', 'render_header_active_call', 'render_call_assets',
        'prune_selected_queue_keys', 'reset_filter_group_if_doctype_changed', 'render_availability', 'render_filter_button',
        'render_dispositions', 'render_manual_disposition_visibility', 'refresh_workdesk_live_call', 'render_auto_toggle',
        'refresh_auto_dial_current', 'render_auto_live', 'maybe_continue_auto_dial', 'restore_workdesk_dialog']) obj[name] = () => {};
    obj.open_post_call_disposition_dialog = (...args) => opened.push(args);
    return {obj, ctx, client, timers, opened, requests};
}


function autoSetup() {
 const t=setup();
 t.ctx.frappe.datetime={now_datetime:()=> '2026-09-24 19:00:00'};
 t.obj.state.auto_dial={running:true,in_flight:true,current:{call_log:'C1',lead:'LEAD1',title:'Test',phone:'123'},results:[],queue:[]};
 for(const name of ['update_selected_count','add_auto_event','hide_auto_call_dialog','render_auto_call_dialog'])t.obj[name]=()=>{};
 t.obj.auto_call_outcome=()=>({label:'Completed'});
 t.obj.call_duration_label=()=> '00:10';
 t.obj.prompt_auto_dial_disposition=(call,current)=>t.opened.push({call,current,busy:t.obj.disposition_call_in_progress()});
 return t;
}
test('auto dial consumes confirmed completion even if console reload never returns',()=>{
 const t=autoSetup();
 t.obj.reconcile_browser_softphone_call(completed);
 assert.equal(t.opened.length,1);
 assert.equal(t.opened[0].busy,false);
 assert.equal(t.obj.state.auto_dial.current,null);
 assert.equal(t.obj.state.auto_dial.awaiting_disposition,true);
 t.obj.maybe_prompt_workdesk_disposition(completed);
 assert.equal(t.opened.length,1);
});
test('auto status poll confirmation clears the matching browser before disposition',()=>{
 const t=autoSetup();
 t.obj.finish_auto_dial_call(completed);
 assert.equal(t.obj.state.softphone.current_call_log,'');
 assert.equal(t.opened.length,1);
 assert.equal(t.opened[0].busy,false);
});
test('an old auto completion never clears a newer call or its timer',()=>{
 const t=autoSetup();
 t.obj.state.softphone.current_call_log='C2';
 t.obj.state.active_call={name:'C2',status:'Connected'};
 t.obj.state.call_started_at='new-time';
 t.obj.finish_auto_dial_call(completed);
 assert.equal(t.obj.state.active_call.name,'C2');
 assert.equal(t.obj.state.softphone.current_call_log,'C2');
 assert.equal(t.obj.state.call_started_at,'new-time');
});
test('uncertain auto status cannot open disposition or advance the queue',()=>{
 for(const status of ['Connected','Provider Unconfirmed','']){
  const t=autoSetup();t.obj.finish_auto_dial_call({...completed,status});
  assert.equal(t.obj.state.auto_dial.current.call_log,'C1');
  assert.equal(t.opened.length,0);
 }
});
test('an old disposition save cannot release a newer auto disposition',()=>{
 const t=autoSetup();
 Object.assign(t.obj.state.auto_dial,{current:null,awaiting_disposition:true,awaiting_disposition_call_log:'C2'});
 t.obj.complete_auto_dial_disposition('C1');
 assert.equal(t.obj.state.auto_dial.awaiting_disposition,true);
 assert.equal(t.timers.length,0);
});


test('matching disposition save releases auto queue exactly once',()=>{
 const t=autoSetup();t.obj.finish_auto_dial_call(completed);
 t.obj.complete_auto_dial_disposition('C1');t.obj.complete_auto_dial_disposition('C1');
 assert.equal(t.obj.state.auto_dial.awaiting_disposition,false);
 assert.equal(t.timers.length,1);
});
test('changed visible queue cannot associate auto disposition with another selected lead',async()=>{
 const t=autoSetup();
 t.obj.state.queue=[];
 t.obj.state.selected={doctype:'CRM Lead',name:'OTHER'};
 t.obj.state.auto_dial.queue=[{doctype:'CRM Lead',name:'LEAD1',title:'Original'}];
 t.obj.apply_context_dispositions=()=>{};
 let reference;
 t.ctx.frappe.call=(method,args)=>{reference=args;return Request.resolve({message:{}});};
 Object.getPrototypeOf(t.obj).prompt_auto_dial_disposition.call(t.obj,
  {name:'C1',status:'Completed'},t.obj.state.auto_dial.current);
 await flush();
 assert.equal(reference.reference_doctype,'CRM Lead');
 assert.equal(reference.reference_name,'LEAD1');
 assert.equal(t.opened[0][1].name,'LEAD1');
});
test('a completion arriving during a newer call queues disposition until that call ends',()=>{
 const t=autoSetup();
 t.obj.state.softphone.current_call_log='C2';t.obj.state.active_call={name:'C2',status:'Connected'};
 t.obj.prompt_auto_dial_disposition=(call,current)=>{
  Object.getPrototypeOf(t.obj).open_post_call_disposition_dialog.call(t.obj,call,
    {doctype:'CRM Lead',name:current.lead},()=>t.obj.complete_auto_dial_disposition(call.name),{auto_dial:true});
 };
 t.obj.finish_auto_dial_call(completed);
 assert.equal(t.obj.pending_post_call_dispositions.size,1);
 assert.equal(t.obj.state.softphone.current_call_log,'C2');
 assert.equal(t.obj.state.auto_dial.awaiting_disposition,true);
 assert.equal(t.opened.length,0);
});


test('terminal event recognizes the auto call even after SDK and active snapshot cleared',()=>{
 const t=autoSetup();
 t.obj.state.softphone.current_call_log='';t.obj.state.softphone.in_call=false;t.obj.state.active_call={};
 t.obj.handle_call_disconnected(completed);
 assert.equal(t.opened.length,1);
 assert.equal(t.obj.state.auto_dial.current,null);
});
