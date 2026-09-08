const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
let yes,no,poll,tasks=[];
const ctx={frappe:{pages:{'vobiz-agent-console':{}},confirm(message,y,n){yes=y;no=n;},call:()=>Promise.resolve({message:{}})},__:s=>s,window:{},console,setTimeout(fn){tasks.push(fn);return 1;}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),'utf8')+';this.Class=VobizAgentConsole;',ctx);
function instance(){const obj=Object.create(ctx.Class.prototype);obj.state={softphone:{current_call_log:'C1'},active_call:{name:'C1'},auto_dial:{},queue:[]};obj.render_header_active_call=()=>{};obj.is_terminal_status=s=>s==='Completed';return obj;}
(async()=>{
 const obj=instance();let ended=0;obj.cancel_call_log=()=>{ended++;return Promise.resolve();};
 obj.hangup_browser_softphone();assert.equal(ended,0);no();assert.equal(ended,0);
 obj.hangup_browser_softphone();yes();await new Promise(setImmediate);assert.equal(ended,1);
 obj.hangup_browser_softphone();obj.state.softphone.current_call_log='C2';obj.state.active_call={name:'C2'};yes();assert.equal(ended,1);
 const incoming=instance();incoming.state.selected={doctype:'Issue',name:'unrelated'};let prompts=0;
 incoming.open_post_call_disposition_dialog=(call,row)=>{prompts++;assert.equal(call.name,'IN');assert.equal(row.doctype,undefined);};
 const call={name:'IN',status:'Completed',direction:'Incoming',incoming_reference_checked:true,incoming_reference_skipped:true,customer_number:'test'};
 incoming.maybe_prompt_workdesk_disposition(call);incoming.maybe_prompt_workdesk_disposition(call);tasks.shift()();assert.equal(prompts,1);
 const pending=instance();let reads=0,notices=0;ctx.frappe.call=()=>Promise.resolve({message:{name:'C1',status:++reads===1?'Connected':'Completed'}});pending.maybe_prompt_workdesk_disposition=()=>notices++;
 pending.watch_browser_call_disposition('C1');pending.watch_browser_call_disposition('C1');assert.equal(tasks.length,1);
 await tasks.shift()();assert.equal(notices,0);await tasks.shift()();assert.equal(notices,1);
 const deferred=instance();let prompted=0;
 deferred.open_post_call_disposition_dialog=()=>prompted++;
 // Frappe 15 returns a jQuery thenable, without native Promise.finally.
 ctx.frappe.call=()=>({then(resolve){resolve({message:{}});}});
 deferred.maybe_prompt_workdesk_disposition({name:'IN-JQ',direction:'Incoming',status:'Completed'});
 await new Promise(setImmediate);
 assert.equal(deferred.incoming_disposition_pending.size,0);
 tasks.shift()();assert.equal(prompted,1);
 console.log('Confirmation, rejection, stale-call safety, unlinked incoming prompt and delayed provider confirmation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
