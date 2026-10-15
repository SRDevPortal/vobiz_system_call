// Run with node: no browser, provider requests, microphone or real timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timers = new Map();
let nextTimer = 1;
class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.nodes = []; }
    resume() { return this.state === 'blocked' ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve(); }
    createGain() { return {gain: {value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}}, connect() {}, disconnect() {}}; }
    createOscillator() {
        const node = {frequency: {}, stopped: false, connect() {}, start() {}, stop() { this.stopped = true; }, disconnect() {}};
        this.nodes.push(node);
        return node;
    }
}
const sandbox = {
    frappe: {pages: {'vobiz-agent-console': {}}},
    document: {addEventListener() {}}, window: {AudioContext},
    __: value => value, console,
    setInterval: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id)
};
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
vm.runInNewContext(source + '; globalThis.Console = VobizAgentConsole;', sandbox);
function agent() {
    const c = Object.create(sandbox.Console.prototype);
    c.state = {softphone: {current_call_log: 'CALL-1', direction: 'Outgoing', in_call: true, conference_recovery: true}};
    c.is_terminal_status = status => ['Completed', 'Failed', 'Cancelled', 'No Answer', 'Busy'].includes(status);
    c.browser_softphone_audio_blocked = () => { c.blocked = true; };
    return c;
}
const ringing = {name: 'CALL-1', status: 'Ringing', call_status: 'conference-customer-ringing'};
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
    const c = agent();
    c.update_browser_ringback({name: 'CALL-1', status: 'Initiated'});
    assert(!c.browser_ringback, 'No tone merely because browser dialing started');
    c.update_browser_ringback({...ringing, call_status: 'browser-ringing'});
    assert(!c.browser_ringback, 'Conference requires customer-leg ringing evidence');
    c.update_browser_ringback(ringing); await flush();
    assert.equal(c.browser_ringback.nodes.length, 2);
    assert.equal(timers.size, 1);
    c.update_browser_ringback(ringing); await flush();
    assert.equal(timers.size, 1, 'Repeated polling must not create overlapping tones');
    c.update_browser_ringback({name: 'OLD-CALL', status: 'Completed'});
    assert(c.browser_ringback, 'An old call cannot stop the current call tone');
    const nodes = [...c.browser_ringback.nodes];
    c.update_browser_ringback({name: 'CALL-1', status: 'Connected'});
    assert(!c.browser_ringback); assert(nodes.every(node => node.stopped));
    c.update_browser_ringback(ringing); await flush();
    assert(!c.browser_ringback, 'Late ringing cannot restart after confirmed customer answer');
    assert.equal(timers.size, 0);

    for (const status of ['Completed', 'Failed', 'Cancelled', 'No Answer', 'Busy']) {
        const c = agent(); c.update_browser_ringback(ringing); await flush();
        c.update_browser_ringback({name: 'CALL-1', status});
        assert(!c.browser_ringback, status);
    }
    for (const state of [{direction: 'Incoming'}, {pending_end_call: 'CALL-1'}, {recovery_verification: {}}, {in_call: false}]) {
        const c = agent(); Object.assign(c.state.softphone, state);
        c.update_browser_ringback(ringing); await flush(); assert(!c.browser_ringback);
    }
    const media = agent(); media.update_browser_ringback(ringing); await flush();
    const report = energy => new Map([['inbound', {id: 'inbound', type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, totalAudioEnergy: energy}]]);
    media.observe_browser_ringback_media(report(0));
    assert(media.browser_ringback, 'Silent RTP must not suppress local ringback');
    media.observe_browser_ringback_media(report(0.1));
    assert(!media.browser_ringback, 'Provider audio stops fallback');
    media.update_browser_ringback(ringing); await flush();
    assert(!media.browser_ringback, 'Do not restart local tone over provider ringback');

    const blocked = agent(); blocked.browser_ringback_context = new AudioContext(); blocked.browser_ringback_context.state = 'blocked';
    blocked.update_browser_ringback(ringing); await flush();
    assert(blocked.blocked); assert(!blocked.browser_ringback);
    blocked.browser_ringback_context.state = 'running'; blocked.start_browser_ringback(); await flush();
    assert(blocked.browser_ringback, 'Enable audio can retry after autoplay is unlocked');
    blocked.stop_browser_ringback();
    const race = agent(); race.update_browser_ringback(ringing);
    race.update_browser_ringback({name: 'CALL-1', status: 'Completed'}); await flush();
    assert(!race.browser_ringback, 'Delayed AudioContext resume cannot recreate a stopped tone');
    assert.equal(timers.size, 0, 'All tone timers cleaned up');
    console.log('Ringback checks passed: customer leg, answer/end cleanup, stale events, silence/media, autoplay and resume races.');
})().catch(error => { console.error(error); process.exitCode = 1; });
