const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let contexts=0, resumes=0, cleanups=0;
const tones=[];
class AudioContext {
 constructor(){contexts++;this.state='suspended';this.currentTime=10;this.destination={};}
 async resume(){resumes++;await Promise.resolve();this.state='running';}
 createOscillator(){assert.equal(this.state,'running');const tone={frequency:{},connect(){},disconnect(){cleanups++;},start(t){this.startTime=t;},stop(t){this.stopTime=t;setImmediate(()=>this.onended());}};tones.push(tone);return tone;}
 createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},disconnect(){cleanups++;}};}
}
const ctx={frappe:{pages:{'vobiz-agent-console':{}},show_alert(){},msgprint(message){throw new Error(message);}},__:x=>x,window:{AudioContext},console};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'),'utf8')+';this.Class=VobizAgentConsole;',ctx);
(async()=>{
 const obj=Object.create(ctx.Class.prototype);obj.state={softphone:{}};obj.render_browser_softphone=()=>{};
 const first=obj.test_browser_audio();await obj.test_browser_audio();await first;
 assert.equal(tones.length,1,'rapid clicks must not overlap');
 await obj.test_browser_audio();
 assert.equal(contexts,1,'reuse the same output context');assert.equal(resumes,2);
 assert.equal(tones.length,2);assert.equal(cleanups,4);
 for(const tone of tones){assert.ok(Math.abs(tone.stopTime-tone.startTime-0.65)<1e-8);assert.equal(tone.frequency.value,720);}
 assert.equal(obj.browser_audio_test_running,false);
 console.log('Repeated tone duration, context readiness/reuse, overlap prevention and cleanup passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
