const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let tick;
const context = {frappe: {pages: {'vobiz-agent-console': {}}}, __: x=>x, window: {}, console,
 setInterval: fn => {tick=fn; return 1;}, clearInterval: ()=>{},
 MediaStream: class {constructor(tracks) {this.tracks=tracks;} getAudioTracks(){return this.tracks;}}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8')+';this.Class=VobizAgentConsole;',context);
(async()=>{
 let tracks=[],plays=0,blocked=true;
 const audio={paused:true,srcObject:null,play(){plays++;if(blocked)return Promise.reject(new Error('NotAllowedError'));this.paused=false;return Promise.resolve();},pause(){this.paused=true;}};
 const sdk={remoteView:{srcObject:null},getPeerConnection:()=>({pc:{getReceivers:()=>tracks.map(track=>({track}))}})};
 const obj=Object.create(context.Class.prototype);
 obj.state={softphone:{client:{client:sdk},current_call_log:'C1',in_call:true,diagnostics:{}}};
 obj.page={main:{find:()=>({get:()=>audio})}};obj.render_browser_softphone=()=>{};
 obj.attach_browser_softphone_audio();assert.equal(plays,0);
 tracks=[{kind:'audio',readyState:'live'}];tick();
 await new Promise(setImmediate);
 assert.equal(audio.srcObject.getAudioTracks()[0],tracks[0]);
 assert.equal(obj.state.softphone.diagnostics.audio,'error');
 assert.equal(sdk.remoteView.muted,true);
 blocked=false;obj.enable_browser_softphone_audio();await new Promise(setImmediate);
 assert.equal(audio.paused,false);assert.equal(obj.state.softphone.diagnostics.audio,'ok');
 let toneStops=0;
 sdk.ringBackToneView={pause(){toneStops++;},muted:false};
 sdk.getPeerConnection=()=>({pc:{getReceivers:()=>tracks.map(track=>({track})),getStats:()=>Promise.resolve(new Map([['audio',{type:'inbound-rtp',kind:'audio',packetsReceived:12}]]))}});
 sdk.remoteView.srcObject={getAudioTracks:()=>[{kind:'audio',readyState:'live',id:'stale'}]};
 tick();await new Promise(setImmediate);
 assert.equal(audio.srcObject.getAudioTracks()[0],tracks[0], 'current receiver wins over stale SDK stream');
 assert.equal(obj.state.softphone.received_audio_packets,12);
 assert.ok(toneStops>0);assert.equal(sdk.ringBackToneView.muted,true);
 const toneOptions=[];
 sdk.setRingToneBack=value=>toneOptions.push(['ringback',value]);
 sdk.setConnectTone=value=>toneOptions.push(['connect',value]);
 let replayed=0;
 sdk.ringBackToneView.play=()=>{replayed++;return Promise.resolve();};
 sdk.ringBackToneView.src='ring.mp3';
 obj.disable_browser_outgoing_tones();
 assert.deepEqual(toneOptions,[['ringback',false],['connect',false]]);
 obj.state.softphone.status='Ringing';obj.state.softphone.received_audio_packets=0;
 obj.enable_browser_softphone_audio();await new Promise(setImmediate);
 assert.equal(replayed,0,'Enable audio must not restart local outgoing ringback');
 obj.state.softphone.current_call_log='C2';tick();assert.equal(audio.srcObject,null);
 const reports=new Map([
 ['out',{id:'out',type:'outbound-rtp',kind:'audio',codecId:'codec',remoteId:'feedback'}],
 ['codec',{mimeType:'audio/opus',clockRate:48000}],
 ['feedback',{type:'remote-inbound-rtp',fractionLost:0.025,jitter:0.012}]
 ]);
 obj.update_browser_upload_diagnostics(reports,{});
 assert.match(obj.state.softphone.diagnostics.upload_message,/opus 48 kHz/);
 assert.match(obj.state.softphone.diagnostics.upload_message,/2.5%/);
 reports.delete('feedback');obj.update_browser_upload_diagnostics(reports,{});
 assert.match(obj.state.softphone.diagnostics.upload_message,/loss not reported/);
 console.log('Delayed track, autoplay rejection/retry, single output and stale-call cleanup checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
