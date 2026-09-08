const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
let dialog, saves = 0;
const button = {prop(){return this;},text(){return this;}};
const ctx = {console, __: s => s, window: {}, clearInterval(){}, frappe: {
 pages: {'vobiz-agent-console': {}}, utils: {escape_html:s=>s}, msgprint(){}, show_alert(){},
 ui: {Dialog: function(config){
  dialog = this; this.config = config; this.values = {}; this.fields_dict = {};
  for(const f of config.fields){this.values[f.fieldname]=f.default || '';this.fields_dict[f.fieldname]={df:f,$input:{on(event,fn){this.change=fn;}}};}
  this.$wrapper={on(){}}; this.show=()=>{}; this.hide=()=>{};
  this.get_close_btn=()=>({hide(){}}); this.get_primary_btn=()=>button;
  this.get_value=n=>this.values[n]; this.set_value=(n,v)=>{this.values[n]=v;};
  this.set_df_property=(n,k,v)=>{this.fields_dict[n].df[k]=v;};
 }},
 call(method,args){
  if(typeof method==='object'){args=method.args;method=method.method;}
  let message;
  if(method.endsWith('prepare_incoming_disposition')) message={reference_doctype:'CRM Lead',reference_name:'LEAD1'};
  else if(method.endsWith('get_lead_disposition_context_api')) message={status:'Fresh',status_options:['Fresh','Interested'],options:[{name:'Follow Up'}]};
  else {saves++;assert.equal(args.lead_status,'Interested');assert.equal(args.disposition,'Follow Up');assert.equal(args.notes,'Customer requested callback');}
  const result=Promise.resolve({message});const then=result.then.bind(result);
  result.then=(...a)=>{const next=then(...a);next.always=fn=>next.finally(fn);return next;};return result;
 }
}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),'utf8')+';this.Class=VobizAgentConsole;',ctx);
(async()=>{
 const obj=Object.create(ctx.Class.prototype);obj.state={};obj.is_patient_disposition_reference=()=>false;obj.patient_followup_status_options=()=>[];obj.load=()=>{};
 obj.open_post_call_disposition_dialog({name:'IN1',direction:'Incoming',status:'Completed'}, {}, null, {generic_dispositions:[]});
 assert.equal(dialog.config.title,'Complete Call Disposition');
 assert.equal(dialog.fields_dict.lead_status.df.hidden,false);
 assert.equal(dialog.fields_dict.disposition.df.label,'Lead Disposition');
 dialog.config.primary_action({});assert.equal(saves,0);
 dialog.values.notes='Customer requested callback';dialog.values.incoming_lead='LEAD1';
 await dialog.fields_dict.incoming_lead.df.onchange();
 assert.equal(dialog.values.lead_status,'Fresh');assert.equal(dialog.values.notes,'Customer requested callback');
 assert.equal(dialog.fields_dict.incoming_lead.df.read_only,1);
 dialog.config.primary_action({lead_status:'Interested',disposition:'Follow Up',notes:dialog.values.notes});
 await new Promise(setImmediate);assert.equal(saves,1);
 const matched=Object.create(ctx.Class.prototype);
 matched.state={lead_disposition_context:{status:'Fresh',status_options:['Fresh','Financial Issue'],options:[]},dispositions:['Want Discount']};
 matched.is_patient_disposition_reference=()=>false;matched.patient_followup_status_options=()=>[];
 matched.open_post_call_disposition_dialog({name:'IN2',direction:'Incoming',status:'Completed',reference_doctype:'CRM Lead',reference_name:'LEAD2'}, {doctype:'CRM Lead',name:'LEAD2'}, null, {disposition_context_refreshed:true});
 assert.equal(dialog.fields_dict.disposition.df.options,'', 'Fresh must not inherit stale dispositions');
 const requests=[];ctx.frappe.call=()=>new Promise(resolve=>requests.push(resolve));
 dialog.values.lead_status='Financial Issue';const old=dialog.fields_dict.lead_status.$input.change();
 dialog.values.lead_status='Fresh';const latest=dialog.fields_dict.lead_status.$input.change();
 requests[1]({message:{options:[]}});await latest;
 requests[0]({message:{options:[{name:'Want Discount'}]}});await old;
 assert.equal(dialog.fields_dict.disposition.df.options,'', 'Late responses cannot overwrite current status options');
 dialog.values.lead_status='';await dialog.fields_dict.lead_status.$input.change();
 assert.equal(requests.length,2,'Blank status must not request saved lead status options');
 assert.equal(dialog.fields_dict.disposition.df.options,'');
 const work=Object.create(ctx.Class.prototype);let selectedStatus='Financial Issue';
 work.state={lead_disposition_context:{},dispositions:['stale']};
 work.page={main:{find(){return {val:()=>selectedStatus};}}};
 work.active_disposition_reference=()=>({reference_doctype:'CRM Lead',reference_name:'L1'});
 work.render_dispositions=()=>{};
 const first=work.refresh_lead_disposition_options();assert.equal(work.state.dispositions.length,0);
 selectedStatus='Fresh';const second=work.refresh_lead_disposition_options();
 requests[3]({message:{status:'Fresh',options:[]}});await second;
 requests[2]({message:{status:'Financial Issue',options:[{name:'Want Discount'}]}});await first;
 assert.equal(work.state.dispositions.length,0,'Workdesk ignores stale status responses');
 selectedStatus='';await work.refresh_lead_disposition_options();assert.equal(requests.length,4);
 console.log('Incoming shared modal loads CRM fields, preserves notes and saves all three values');
})().catch(e=>{console.error(e);process.exitCode=1;});
