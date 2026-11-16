
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),'utf8');
function setup(){
 let dialogs=[];
 const context={frappe:{pages:{'vobiz-agent-console':{}},utils:{escape_html:s=>String(s)},ui:{Dialog:class{
 constructor(options){this.options=options;dialogs.push(this)}
 show(){} hide(){this.onhide?.()} get_primary_btn(){return {prop(){return this}}}
 }}},__:s=>s};
 vm.createContext(context);vm.runInContext(source+';this.Console=VobizAgentConsole',context);
 const obj=Object.create(context.Console.prototype);
 obj.state={console_view:'ndr'};obj.disposition_call_in_progress=()=>false;
 return {obj,dialogs,context};
}
test('NDR outcomes open once and never show clinical status inputs',()=>{
 const {obj,dialogs}=setup();
 const info={terminal:true,encounter:'ENC-1',tags:['Customer Unreachable'],follow_up_at:'2026-11-13 10:15:00'};
 obj.show_ndr_outcome({name:'CALL-1'},info);
 obj.show_ndr_outcome({name:'CALL-1'},info);
 assert.equal(dialogs.length,1);
 const fields=dialogs[0].options.fields.map(f=>f.fieldname).filter(Boolean);
 assert.deepEqual(Array.from(fields),['tag','notes','callback_at','follow_up_at']);
 const tag=dialogs[0].options.fields.find(f=>f.fieldname==='tag');
 assert.equal(tag.fieldtype,'Link');
 assert.equal(tag.options,'NDR Tag');
 const timestamp=dialogs[0].options.fields.find(f=>f.fieldname==='follow_up_at');
 assert.equal(timestamp.default,'2026-11-13 10:15:00');
 assert.equal(timestamp.read_only,1);
});
test('active call and saved outcomes do not open the NDR dialog',()=>{
 const {obj,dialogs}=setup();
 let done=0;
 obj.show_ndr_outcome({name:'CALL-1'},{saved:true},()=>done++);
 assert.equal(done,1);
 obj.disposition_call_in_progress=()=>true;
 obj.show_ndr_outcome({name:'CALL-2'},{terminal:true,tags:[]});
 assert.equal(dialogs.length,0);
});
test('pending recovery routes the exact call log to the outcome handler',async()=>{
 const {obj,context}=setup();
 context.frappe.call=async()=>({message:[{name:'CALL-PENDING'}]});
 let opened;
 obj.open_post_call_disposition_dialog=call=>{opened=call.name};
 await obj.check_pending_ndr_outcomes();
 assert.equal(opened,'CALL-PENDING');
 assert.equal(obj.ndr_pending_check,false);
});
