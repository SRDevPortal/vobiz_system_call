const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
let tick,finish,stopped,closed,signal,pending;
class Context {
 constructor(){this.state='running';}
 resume(){return Promise.resolve();}
 close(){closed++;return Promise.resolve();}
 createMediaStreamSource(){return {connect(){},disconnect(){}};}
 createAnalyser(){return {fftSize:1024,getFloatTimeDomainData(a){a.fill(signal);},disconnect(){}};}
}
const stream={getTracks:()=>[{stop(){stopped++;}}]};
const ctx={frappe:{pages:{'vobiz-agent-console':{}},msgprint(){}},__:x=>x,window:{AudioContext:Context},navigator:{mediaDevices:{getUserMedia:()=>pending||Promise.resolve(stream)}},console,
 setInterval:fn=>{tick=fn;return 1;},clearInterval(){},setTimeout:fn=>{finish=fn;return 2;},clearTimeout(){}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),'utf8')+';this.Class=VobizAgentConsole;',ctx);
function create(){stopped=0;closed=0;pending=null;const obj=Object.create(ctx.Class.prototype);obj.state={softphone:{diagnostics:{}}};const element={val(){return this;},text(){return this;},addClass(){return this;},removeClass(){return this;}};obj.page={main:{find:()=>element}};obj.render_browser_softphone=()=>{};return obj;}
(async()=>{
 for(const sound of [0,0.04]){const obj=create();signal=sound;await obj.test_browser_microphone();tick();finish();assert.equal(obj.state.softphone.diagnostics.mic,sound?'ok':'error');assert.equal(stopped,1);assert.equal(closed,1);assert.equal(obj.browser_mic_test,null);}
 const obj=create();let release;pending=new Promise(r=>release=r);const work=obj.test_browser_microphone();await new Promise(setImmediate);obj.stop_browser_microphone_test();release(stream);await work;assert.equal(stopped,1);assert.equal(closed,1);assert.equal(obj.browser_mic_test,null);
 console.log('Mic sound/silence detection, completion cleanup and cancelled permission cleanup passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
