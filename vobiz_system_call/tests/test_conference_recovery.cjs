const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');

function setup() {
    const calls = [], hangups = [], requests = [], events = {}, completed = [], logins = [];
    const ctx = {frappe: {pages: {'vobiz-agent-console': {}}, show_alert() {}}, __: x => x,
        console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
        window: {navigator: {onLine: true}, addEventListener() {}, removeEventListener() {}}};
    vm.createContext(ctx);
    vm.runInContext(source + '\nthis.ConsoleClass = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.ConsoleClass.prototype);
    const sdk = {on: (name, fn) => {events[name] = fn;}, getCallUUID: () => '',
        getPeerConnection: () => ({pc: {iceConnectionState: 'connected'}}),
        call: destination => {calls.push(destination);}, hangup: () => {hangups.push('hangup');},
        login: (...args) => logins.push(args), mute() {}};
    const client = {client: sdk};
    obj.state = {softphone: {client, registered: true, current_call_log: 'C1', sdk_call_uuid: '',
        conference_recovery: true, conference_generation: 1, in_call: true,
        config: {username: 'test-endpoint', password: 'test-only'}}, active_call: {name: 'C1', status: 'Connected'}};
    for (const name of ['render_browser_softphone', 'render_active_call', 'render_queue',
        'render_workdesk_live_call', 'update_workdesk_primary_action', 'load', 'clear_tracked_live_call',
        'maybe_prompt_workdesk_disposition', 'attach_browser_softphone_audio',
        'enable_browser_softphone_audio', 'disable_browser_outgoing_tones', 'watch_browser_call_disposition']) obj[name] = () => {};
    obj.get_softphone_tab_id = () => 'TAB';
    obj.browser_request_with_timeout = promise => promise;
    obj.reconcile_browser_softphone_call = call => completed.push(call.name);
    obj.bind_browser_softphone_events(client);
    ctx.frappe.call = arg => {requests.push(arg); return Promise.resolve({message: {name: 'C1', status: 'Connected', destination: 'sip:vsc-room@registrar.invalid', conference_generation: 2}});};
    return {obj, ctx, sdk, client, calls, hangups, requests, events, completed, logins, s: obj.state.softphone};
}

test('rejoin dials only the conference route and retains the logical call', async () => {
    const t = setup();
    await t.obj.recover_conference_call(t.client);
    assert.deepEqual(t.calls, ['sip:vsc-room@registrar.invalid']);
    assert.equal(t.s.current_call_log, 'C1');
    assert.equal(t.s.conference_generation, 2);
    assert.equal(t.requests[0].args.generation, 1);
    assert.equal(t.completed.length, 0);
});

test('a surviving SDK session must be retired before replacement', async () => {
    const t = setup();
    t.sdk.getCallUUID = () => 'old-sdk';
    t.ctx.frappe.call = () => Promise.resolve({message: {name: 'C1', status: 'Connected', retire_session: true}});
    await t.obj.recover_conference_call(t.client);
    assert.equal(t.hangups.length, 1);
    assert.equal(t.calls.length, 0);
    assert.equal(t.s.current_call_log, 'C1');
});

test('late recovery response cannot join after End Call intent', async () => {
    const t = setup();
    let finish;
    t.ctx.frappe.call = () => new Promise(resolve => {finish = resolve;});
    const pending = t.obj.recover_conference_call(t.client);
    t.s.conference_end_requested = 'C1';
    finish({message: {name: 'C1', status: 'Connected', destination: 'sip:vsc-old@invalid'}});
    await pending;
    assert.equal(t.calls.length, 0);
});

test('late recovery response cannot change a newer call', async () => {
    const t = setup();
    let finish;
    t.ctx.frappe.call = () => new Promise(resolve => {finish = resolve;});
    const pending = t.obj.recover_conference_call(t.client);
    t.s.current_call_log = 'C2';
    finish({message: {name: 'C1', status: 'Completed'}});
    await pending;
    assert.deepEqual(t.completed, []);
    assert.equal(t.s.current_call_log, 'C2');
});

test('simultaneous recovery checks cannot duplicate a SIP join', async () => {
    const t = setup();
    await Promise.all([t.obj.recover_conference_call(t.client), t.obj.recover_conference_call(t.client)]);
    assert.equal(t.calls.length, 1);
    assert.equal(t.requests.length, 1);
});

test('an API error neither clears the call nor redials the customer', async () => {
    const t = setup();
    t.ctx.frappe.call = () => Promise.reject(new Error('offline'));
    await t.obj.recover_conference_call(t.client);
    assert.equal(t.s.current_call_log, 'C1');
    assert.equal(t.calls.length + t.completed.length, 0);
});

test('confirmed customer completion uses existing disposition reconciliation', async () => {
    const t = setup();
    t.ctx.frappe.call = () => Promise.resolve({message: {name: 'C1', status: 'Completed'}});
    await t.obj.recover_conference_call(t.client);
    assert.deepEqual(t.completed, ['C1']);
    assert.equal(t.calls.length, 0);
});

test('SDK termination keeps customer logical state and cannot open disposition', () => {
    const t = setup();
    t.events.onCallTerminated({call_uuid: 'sdk-old'});
    assert.equal(t.s.current_call_log, 'C1');
    assert.equal(t.s.in_call, true);
    assert.equal(t.s.conference_session_ended, true);
    assert.equal(t.completed.length, 0);
    assert.equal(t.requests[0].args.conference_generation, 1);
});

test('late termination from retired SDK generation is ignored', () => {
    const t = setup();
    t.s.conference_retired_uuids = ['sdk-old'];
    t.events.onCallTerminated({call_uuid: 'sdk-old'});
    assert.equal(t.s.conference_session_ended, undefined);
    assert.equal(t.requests.length, 0);
});

test('joining the browser room alone does not claim the customer answered', () => {
    const t = setup();
    t.obj.state.workdesk_live_call = t.obj.state.active_call;
    t.obj.state.active_call.status = 'Ringing';
    t.events.onCallAnswered({call_uuid: 'sdk-new'});
    assert.equal(t.s.status, 'Connecting customer');
    assert.equal(t.s.incoming_answered, false);
    assert.equal(t.obj.state.active_call.status, 'Ringing');
});

test('a rejoined browser leg restores the user mute selection', () => {
    const t = setup();
    t.s.muted = true;
    let mutes = 0;
    t.sdk.mute = () => mutes++;
    t.events.onCallAnswered({call_uuid: 'sdk-new'});
    assert.equal(mutes, 1);
    assert.equal(t.s.muted, true);
});

test('an actual logout during recovery preserves the logical call for registration retry', async () => {
    const t = setup();
    t.events.onLogout();
    assert.equal(t.s.current_call_log, 'C1');
    assert.equal(t.s.in_call, true);
    await t.obj.recover_conference_call(t.client);
    assert.equal(t.logins.length, 1);
    assert.equal(t.calls.length, 0); // Wait for onLogin before rejoining.
});

test('End Call records intent before SDK hangup can emit its termination event', async () => {
    const t = setup();
    t.sdk.getCallUUID = () => 'sdk-current';
    t.s.sdk_call_uuid = 'sdk-current';
    let observed;
    t.sdk.hangup = () => {observed = t.s.conference_end_requested; t.events.onCallTerminated({call_uuid: 'sdk-current'});};
    t.ctx.frappe.call = () => Promise.resolve({message: {name: 'C1', status: 'Connected'}});
    await t.obj.cancel_call_log('C1');
    assert.equal(observed, 'C1');
    assert.equal(t.s.pending_end_call, 'C1');
    assert.equal(t.calls.length, 0);
});

test('long browser offline period does not apply the old direct-call timeout', async () => {
    const t = setup();
    t.ctx.window.navigator.onLine = false;
    t.s.network_issues = {offline: Date.now() - 180000};
    let cancelled = false;
    t.obj.cancel_call_log = () => {cancelled = true; return Promise.resolve();};
    await t.obj.check_browser_network(t.client, true);
    assert.equal(cancelled, false); // Server conference deadline owns this decision.
});
