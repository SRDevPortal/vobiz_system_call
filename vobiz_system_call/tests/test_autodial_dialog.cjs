const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const app = path.basename(path.resolve(__dirname, '..'));
const source = fs.readFileSync(path.join(__dirname, '..', app, 'page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
function setup() {
 const dialogs=[];
 const ctx={frappe:{pages:{'vobiz-agent-console':{}},datetime:{now_datetime:()=> '2026-09-24 19:00:00'},ui:{Dialog:class {
  constructor(){this.events={};this.removed=false;this.shown=0;const d=this;
   this.$wrapper={is:()=>false,addClass(){},on(event,...args){d.events[event]=args.at(-1);},remove(){d.removed=true;}};
   dialogs.push(this);
  }
  show(){this.shown++;}
  hide(){this.hiding=true;}
  get_close_btn(){return {show(){}};}
 }}},__:s=>s};
 vm.createContext(ctx);vm.runInContext(source+'\nthis.ConsoleClass=VobizAgentConsole;',ctx);
 const obj=Object.create(ctx.ConsoleClass.prototype);
 obj.state={auto_dial:{current:{call_log:'C1',lead:'L1'},results:[]},active_call:{name:'C1',status:'Connected'}};
 for(const m of ['reconcile_browser_softphone_call','render_auto_call_dialog','update_selected_count','render_auto_live','clear_tracked_live_call','stop_timer','add_auto_event'])obj[m]=()=>{};
 obj.auto_call_dialog_html=()=>'';obj.auto_call_outcome=()=>({label:'Completed'});obj.call_duration_label=()=>'00:10';
 return {obj,dialogs};
}
test('opening transitions cannot create overlapping auto dial dialogs',()=>{
 const {obj,dialogs}=setup();obj.show_auto_call_dialog();obj.show_auto_call_dialog();obj.show_auto_call_dialog();
 assert.equal(dialogs.length,1);assert.equal(obj.auto_call_dialog,dialogs[0]);
});
test('closing a call dialog removes it without changing Workdesk',()=>{
 const {obj,dialogs}=setup();const workdesk={};obj.state.active_workdesk_dialog=workdesk;
 obj.stop_whatsapp_sync=()=>assert.fail('unrelated Workdesk must remain intact');
 obj.show_auto_call_dialog();dialogs[0].events['hidden.bs.modal']();
 assert.equal(obj.auto_call_dialog,null);assert.equal(dialogs[0].removed,true);assert.equal(obj.state.active_workdesk_dialog,workdesk);
 obj.show_auto_call_dialog();assert.equal(dialogs.length,2);
});
test('old hide completion cannot discard the next call dialog',()=>{
 const {obj,dialogs}=setup();obj.show_auto_call_dialog();obj.hide_auto_call_dialog();obj.show_auto_call_dialog();
 dialogs[0].events['hidden.bs.modal']();assert.equal(obj.auto_call_dialog,dialogs[1]);assert.equal(dialogs[1].removed,false);
});
test('confirmed completion closes the call window before opening disposition once',()=>{
 const {obj,dialogs}=setup();obj.show_auto_call_dialog();let prompts=0;
 obj.prompt_auto_dial_disposition=(call,current)=>{prompts++;assert.equal(obj.auto_call_dialog,null);assert.equal(dialogs[0].hiding,true);assert.equal(current.call_log,call.name);};
 obj.finish_auto_dial_call({name:'C1',status:'Completed'});obj.finish_auto_dial_call({name:'C1',status:'Completed'});
 assert.equal(prompts,1);assert.equal(obj.state.auto_dial.awaiting_disposition,true);assert.equal(obj.state.auto_dial.results.length,1);
});
test('a different call completion leaves the current dialog alone',()=>{
 const {obj,dialogs}=setup();obj.show_auto_call_dialog();obj.prompt_auto_dial_disposition=()=>assert.fail('unrelated call');
 obj.finish_auto_dial_call({name:'OLD',status:'Completed'});assert.equal(obj.auto_call_dialog,dialogs[0]);assert.equal(obj.state.auto_dial.current.call_log,'C1');
});
