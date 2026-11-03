// Windows Node + Playwright: 30 real isolated browser sessions, bounded live calls.
const fs=require('fs'), path=require('path');
const ROOT='\\\\wsl.localhost\\Ubuntu-22.04';
const {chromium}=require(ROOT+'\\tmp\\sriaas-browser-investigation\\node_modules\\playwright-core');
const ORIGIN='https://tables-valuables-galvanize.ngrok-free.dev';
const OUT=ROOT+'\\home\\mit\\frappe-bench\\test-results\\vobiz-load-30';
const PRIVATE=ROOT+'\\tmp\\vobiz-load-private.json';
const COMMAND=ROOT+'\\tmp\\vobiz-load-command.json';
const agents=JSON.parse(fs.readFileSync(PRIVATE,'utf8')).agents;
const report={started:new Date().toISOString(),phase:'opening',agents:[],http:[],errors:[],rounds:[],start_requests:0};
if(fs.existsSync(path.join(OUT,'browser-monitor.json'))){let previous=JSON.parse(fs.readFileSync(path.join(OUT,'browser-monitor.json'),'utf8'));report.start_requests=previous.start_requests;report.http=previous.http;report.errors=previous.errors.concat([{type:'harness_restart',message:'Dialog acceptance raced with reload; browser process ended. Interrupted round is not a passed refresh test.'}]);}
const sessions=[];let lastCommand='',busy=false,closing=false;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const scrub=s=>String(s).replace(/https?:\/\/[^\s]+/g,'[URL]').replace(/\+?\d{10,15}/g,'[NUMBER]').slice(0,250);
function save(){fs.writeFileSync(path.join(OUT,'browser-monitor.json'),JSON.stringify(report,null,2));}
async function snapshot(s){return s.page.evaluate(()=>{let c=document.getElementById('page-vobiz-agent-console')?.vobiz_agent_console;if(!c)return {ready:false};let p=c.state.softphone;return {ready:true,registered:!!p.registered,status:p.status,error:p.error||'',in_call:!!p.in_call,call_log:p.current_call_log||'',pending_end:p.pending_end_call||'',mic:p.diagnostics?.mic,queue_count:c.state.queue.length};});}
async function prepare(browser,a,index){
 let context=await browser.newContext({viewport:{width:1100,height:850},permissions:['microphone'],extraHTTPHeaders:{'ngrok-skip-browser-warning':'1'}});
 let s={context,index,user:a.user,lead:a.lead};sessions[index]=s;
 await context.route('**/api/method/vobiz_click_to_call.api.call.start_call',async route=>{
  if(index>=3 || report.start_requests>=9){report.errors.push({agent:index+1,type:'call_budget_guard'});return route.abort();}
  report.start_requests++;save();return route.continue();
 });
 let login=await context.request.post(ORIGIN+'/api/method/login',{form:{usr:a.user,pwd:a.password}});
 if(login.status()!=200)throw Error('Login HTTP '+login.status());
 let p=await context.newPage();s.page=p;
 p.on('pageerror',e=>report.errors.push({agent:index+1,type:'pageerror',message:scrub(e.message)}));
 p.on('response',async r=>{let u=new URL(r.url());if(u.origin!==ORIGIN)return;let item={agent:index+1,at:new Date().toISOString(),path:u.pathname,status:r.status()};if(u.pathname.includes('/api/')){report.http.push(item);if(report.http.length>20000)report.http.shift();}if(u.pathname.endsWith('/api.call.start_call')){try{let j=await r.json();item.call_log=j.message?.call_log;item.error=j.exc_type;}catch{}}});
 p.on('dialog',d=>d.accept().catch(()=>{}));
 await p.goto(ORIGIN+'/app/vobiz-agent-console',{waitUntil:'domcontentloaded',timeout:60000});
 await p.waitForFunction(()=>document.getElementById('page-vobiz-agent-console')?.vobiz_agent_console?.state.softphone.config,{timeout:45000});
 await p.evaluate(async()=>{let c=document.getElementById('page-vobiz-agent-console').vobiz_agent_console;await c.connect_browser_softphone();});
 report.agents[index]={agent:index+1,user:a.user,...await snapshot(s)};save();console.log('BROWSER_READY',index+1,report.agents[index].registered);
}
async function round(mode){
 if(report.rounds.length>=3)throw Error('Three-round budget exhausted');
 const selected=sessions.slice(0,3);if(selected.some(s=>!s?.page))throw Error('Missing browser');
 for(const s of selected){let st=await snapshot(s);if(st.in_call||st.call_log||st.pending_end)throw Error('Existing call not finished for agent '+(s.index+1));if(!st.registered)throw Error('Agent not registered');}
 const r={mode,started:new Date().toISOString(),agents:[]};report.rounds.push(r);report.phase='live_'+mode;save();
 await Promise.all(selected.map(async s=>{
  await s.page.evaluate(async()=>{await frappe.call({method:'vobiz_click_to_call.api.call.set_my_availability',args:{status:'Available'}});});
  await s.page.getByPlaceholder('Search',{exact:true}).fill(s.lead);
  await s.page.waitForTimeout(1000);
  await s.page.locator('[data-action="call-row"]').click({timeout:15000});
 }));
 await Promise.all(selected.map(async s=>{
  const start=Date.now();let row={agent:s.index+1};r.agents.push(row);
  try{
   // Invoke the same UI start handler twice in the duplicate scenario; its in-flight guard must deduplicate.
   await s.page.evaluate(async mode=>{let c=document.getElementById('page-vobiz-agent-console').vobiz_agent_console;let row=c.state.active_workdesk_row;if(!row)throw Error('No selected test lead');if(mode==='duplicate_refresh'){await Promise.all([c.start_call_for_row(row),c.start_call_for_row(row)]);}else await c.start_call_for_row(row);},mode);
   row.start_ms=Date.now()-start;row.after_start=await snapshot(s);
   let close=s.page.locator('.vobiz-workdesk-modal .btn-modal-close');if(await close.isVisible())await close.click();
  }catch(e){row.error=scrub(e.message);}
 }));save();
 if(mode==='cancel'){await delay(1500);await Promise.all(selected.map(async s=>{try{await s.page.evaluate(()=>document.getElementById('page-vobiz-agent-console').vobiz_agent_console.hangup_browser_softphone());}catch(e){r.agents.find(x=>x.agent===s.index+1).cancel_error=scrub(e.message);}}));}
 if(mode==='duplicate_refresh'){await delay(4000);await selected[0].page.reload({waitUntil:'domcontentloaded'});r.refreshed_agent=1;}
 for(let i=0;i<10;i++){await delay(3000);const states=await Promise.all(selected.map(s=>snapshot(s).catch(()=>({ready:false}))));r.last_states=states;save();if(states.every(x=>x.ready&&!x.in_call&&!x.call_log&&!x.pending_end))break;}
 for(const s of selected){let st=await snapshot(s).catch(()=>({}));if(st.call_log||st.in_call){try{await s.page.evaluate(()=>document.getElementById('page-vobiz-agent-console').vobiz_agent_console.end_header_active_call());r.forced_end_requested=true;}catch(e){r.end_error=scrub(e.message);}}}
 r.finished=new Date().toISOString();report.phase='monitoring';save();console.log('ROUND_FINISHED',mode,report.start_requests);
}
(async()=>{
 const b=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:false,args:['--remote-debugging-port=9225','--remote-debugging-address=127.0.0.1','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 for(let n=0;n<30;n+=6){await Promise.all(agents.slice(n,n+6).map((a,i)=>prepare(b,a,n+i).catch(e=>{report.agents[n+i]={agent:n+i+1,ready:false,error:scrub(e.message)};console.log('BROWSER_FAILED',n+i+1,scrub(e.message));save();})));}
 report.phase='monitoring';save();console.log('ALL_BROWSERS_PREPARED');
 while(!closing){
  for(let n=0;n<sessions.length;n+=5){await Promise.all(sessions.slice(n,n+5).filter(s=>s?.page).map(async s=>{try{report.agents[s.index]={agent:s.index+1,user:s.user,...await snapshot(s)};}catch(e){report.agents[s.index]={agent:s.index+1,error:scrub(e.message)}}}));}
  save();
  if(fs.existsSync(COMMAND)){let cmd=JSON.parse(fs.readFileSync(COMMAND,'utf8').replace(/^\uFEFF/,''));if(cmd.id!==lastCommand){lastCommand=cmd.id;try{if(cmd.action==='round')await round(cmd.mode);else if(cmd.action==='refresh_all'){report.phase='refreshing_30';save();await Promise.all(sessions.filter(s=>s?.page).map(s=>s.page.evaluate(()=>document.getElementById('page-vobiz-agent-console').vobiz_agent_console.load()).catch(e=>report.errors.push({agent:s.index+1,type:'refresh',message:scrub(e.message)}))));report.phase='monitoring';}else if(cmd.action==='stop')closing=true;}catch(e){report.errors.push({type:'command',message:scrub(e.message)});console.log('COMMAND_ERROR',scrub(e.message));}save();}}
  await delay(3000);
 }
 report.phase='closed';save();await b.close();
})().catch(e=>{report.errors.push({type:'fatal',message:scrub(e.message)});save();console.log('FATAL',scrub(e.message));process.exit(1)});
