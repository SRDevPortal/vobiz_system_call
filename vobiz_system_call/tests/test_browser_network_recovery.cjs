const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');

function setup() {
    let now = 100000, logouts = 0, hangups = 0;
    const timeouts = new Map(), intervals = new Map(), listeners = new Map(), events = {};
    let timerId = 0;
    const ctx = {
        frappe: {pages: {'vobiz-agent-console': {}}, show_alert() {}}, __: x => x, console,
        Date: {now: () => now},
        window: {navigator: {onLine: true},
            addEventListener: (name, fn) => listeners.set(name, fn),
            removeEventListener: name => listeners.delete(name)},
        setTimeout(fn) {timeouts.set(++timerId, fn); return timerId;},
        clearTimeout: id => timeouts.delete(id),
        setInterval(fn) {intervals.set(++timerId, fn); return timerId;},
        clearInterval: id => intervals.delete(id),
    };
    vm.createContext(ctx);
    vm.runInContext(source + '\nthis.ConsoleClass = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.ConsoleClass.prototype);
    const pc = {iceConnectionState: 'connected'};
    const sdk = {on: (name, fn) => {events[name] = fn;}, logout() {logouts++;},
        hangup() {hangups++;}, isConnected: () => true, getCallUUID: () => 'sdk-1',
        getPeerConnection: () => ({status: 'success', pc})};
    const client = {client: sdk};
    obj.state = {softphone: {client, registered: true, in_call: true,
        current_call_log: 'C1', sdk_call_uuid: 'sdk-1', status: 'In Call'},
        active_call: {name: 'C1', status: 'Connected'}, auto_dial: {}};
    for (const name of ['render_browser_softphone', 'render_active_call', 'render_queue',
        'render_workdesk_live_call', 'update_workdesk_primary_action', 'stop_timer',
        'stop_browser_softphone_audio', 'clear_tracked_live_call', 'load',
        'maybe_prompt_workdesk_disposition', 'attach_browser_softphone_audio',
        'enable_browser_softphone_audio', 'watch_browser_call_disposition']) obj[name] = () => {};
    obj.send_browser_presence = () => Promise.resolve({message: {registered: true}});
    ctx.frappe.call = arg => Promise.resolve(typeof arg === 'string' ? {} : {message: {name: 'C1', status: 'Connected', provider_state: 'active'}});
    obj.bind_browser_softphone_events(client);
    return {obj, ctx, client, sdk, pc, events, timeouts, intervals, listeners,
        advance: ms => {now += ms;}, logouts: () => logouts, hangups: () => hangups};
}
const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};

test('failed presence checks never log out a healthy call, even beyond the grace period', async () => {
    const t = setup();
    t.obj.send_browser_presence = () => Promise.reject({status: 503});
    await t.obj.check_browser_network(t.client, true);
    t.advance(40000);
    await t.obj.check_browser_network(t.client, true);
    assert.equal(t.logouts(), 0);
    assert.equal(t.hangups(), 0);
    assert.equal(t.obj.state.softphone.current_call_log, 'C1');
    assert.match(t.obj.browser_softphone_network_message(), /Server connection interrupted/);
    t.obj.send_browser_presence = () => Promise.resolve({});
    await t.obj.check_browser_network(t.client, true);
    assert.equal(t.obj.browser_softphone_reconnecting(), false);
});

test('short offline interruption resumes the same call and preserves mute and timer', async () => {
    const t = setup(), phone = t.obj.state.softphone;
    phone.started_at = 'original-time'; phone.muted = true;
    t.ctx.window.navigator.onLine = false;
    await t.obj.check_browser_network(t.client);
    assert.match(t.obj.browser_softphone_network_message(), /reconnecting/);
    t.advance(15000);
    t.ctx.window.navigator.onLine = true;
    await t.obj.check_browser_network(t.client, true);
    assert.equal(phone.client, t.client);
    assert.equal(phone.current_call_log, 'C1');
    assert.equal(phone.started_at, 'original-time');
    assert.equal(phone.muted, true);
    assert.equal(phone.status, 'In Call');
    assert.equal(t.obj.browser_softphone_reconnecting(), false);
    assert.equal(t.logouts() + t.hangups(), 0);
});

test('a successful website check does not claim that failed audio recovered', async () => {
    const t = setup();
    t.pc.iceConnectionState = 'disconnected';
    await t.obj.check_browser_network(t.client, true);
    assert.equal(t.obj.browser_softphone_reconnecting(), true);
    t.advance(10000);
    t.pc.iceConnectionState = 'checking';
    await t.obj.check_browser_network(t.client, true);
    assert.equal(t.obj.browser_softphone_reconnecting(), true);
    t.pc.iceConnectionState = 'connected';
    t.events.onMediaConnected({call_uuid: 'sdk-1'});
    await t.obj.check_browser_network(t.client, true);
    assert.equal(t.obj.browser_softphone_reconnecting(), false);
    assert.equal(t.hangups(), 0);
});

test('SDK signaling reconnect does not terminate working media', async () => {
    const t = setup();
    t.sdk.isConnected = () => false;
    t.events.onConnectionChange({state: 'disconnected'});
    await t.obj.check_browser_network(t.client);
    t.advance(40000);
    await t.obj.check_browser_network(t.client);
    assert.equal(t.hangups(), 0);
    t.sdk.isConnected = () => true;
    t.events.onConnectionChange({state: 'connected'});
    await flush();
    assert.equal(t.obj.browser_softphone_reconnecting(), false);
});

test('sustained media loss requests termination only after thirty seconds', async () => {
    const t = setup();
    let stops = 0;
    t.ctx.frappe.call = arg => {
        if (typeof arg === 'string') {stops++; return Promise.resolve({});}
        return Promise.resolve({message: {name: 'C1', status: stops ? 'Completed' : 'Connected'}});
    };
    t.pc.iceConnectionState = 'failed';
    await t.obj.check_browser_network(t.client);
    t.advance(29000);
    await t.obj.check_browser_network(t.client);
    assert.equal(stops, 0);
    t.advance(1000);
    await t.obj.check_browser_network(t.client);
    await flush();
    assert.equal(stops, 1);
    assert.equal(t.obj.state.softphone.current_call_log, '');
    assert.equal(t.obj.state.softphone.pending_end_call, '');
});

test('offline Stop remains pending and is retried when internet returns', async () => {
    const t = setup();
    let stops = 0;
    t.ctx.frappe.call = arg => {
        if (typeof arg === 'string') {
            stops++;
            return t.ctx.window.navigator.onLine ? Promise.resolve({}) : Promise.reject({status: 0});
        }
        return Promise.resolve({message: {name: 'C1', status: stops > 1 ? 'Completed' : 'Connected'}});
    };
    t.ctx.window.navigator.onLine = false;
    await t.obj.check_browser_network(t.client);
    await assert.rejects(t.obj.cancel_call_log('C1'));
    assert.equal(t.obj.state.softphone.pending_end_call, 'C1');
    t.ctx.window.navigator.onLine = true;
    await t.obj.check_browser_network(t.client, true);
    await flush();
    assert.equal(stops, 2);
    assert.equal(t.obj.state.softphone.current_call_log, '');
});

test('overlapping Stop requests share one provider request', async () => {
    const t = setup();
    let resolveStop, stops = 0;
    t.ctx.frappe.call = arg => {
        if (typeof arg === 'string') {stops++; return new Promise(resolve => {resolveStop = resolve;});}
        return Promise.resolve({message: {name: 'C1', status: 'Completed'}});
    };
    const first = t.obj.cancel_call_log('C1');
    const second = t.obj.cancel_call_log('C1');
    assert.equal(first, second);
    resolveStop({});
    await first;
    assert.equal(stops, 1);
});

test('permissions and ownership rejection still disconnect registration', async () => {
    for (const status of [401, 403, 417]) {
        const t = setup();
        t.obj.send_browser_presence = registered => registered === false
            ? Promise.resolve({}) : Promise.reject({status});
        await t.obj.check_browser_network(t.client, true);
        assert.equal(t.logouts(), 1);
        assert.equal(t.obj.state.softphone.client, null);
    }
});

test('late presence rejection from an old client cannot disconnect the new client', async () => {
    const t = setup();
    let reject;
    t.obj.send_browser_presence = () => new Promise((_, fail) => {reject = fail;});
    const checking = t.obj.check_browser_network(t.client, true);
    const next = {client: {logout() {throw new Error('must not log out');}}};
    t.obj.state.softphone.client = next;
    reject({status: 403});
    await checking;
    assert.equal(t.obj.state.softphone.client, next);
    assert.equal(t.logouts(), 0);
});

test('monitor binds once and logout removes timers and browser listeners', async () => {
    const t = setup();
    t.events.onLogin();
    await flush();
    t.events.onLogin();
    await flush();
    assert.equal(t.intervals.size, 1);
    assert.equal(t.listeners.size, 2);
    t.events.onLogout();
    assert.equal(t.intervals.size, 0);
    assert.equal(t.listeners.size, 0);
});

test('a stalled presence request times out and aborts without logging out the SDK', async () => {
    const t = setup();
    let aborted = false;
    const pending = new Promise(() => {});
    pending.abort = () => {aborted = true;};
    t.ctx.frappe.call = () => pending;
    const checking = Object.getPrototypeOf(t.obj).send_browser_presence.call(t.obj);
    const rejected = assert.rejects(checking, /timed out/);
    [...t.timeouts.values()][0]();
    await rejected;
    assert.equal(aborted, true);
    assert.equal(t.logouts(), 0);
});

test('old call media events and SDK sessions cannot change the current call recovery', async () => {
    const t = setup();
    t.obj.set_browser_network_issue('media', true);
    t.events.onMediaConnected({call_uuid: 'old-sdk'});
    assert.equal(t.obj.browser_softphone_reconnecting(), true);
    t.obj.reset_browser_softphone_call_state('Registered', 'C1', 'Completed');
    t.obj.state.softphone.current_call_log = 'C2';
    t.obj.state.softphone.sdk_call_uuid = 'sdk-2';
    t.pc.iceConnectionState = 'failed';
    await t.obj.check_browser_network(t.client, true);
    assert.equal(t.obj.browser_softphone_reconnecting(), false);
    assert.equal(t.obj.state.softphone.current_call_log, 'C2');
});

test('new calls are blocked during recovery without replacing the existing SDK', async () => {
    const t = setup();
    t.obj.set_browser_network_issue('offline', true);
    await assert.rejects(t.obj.connect_browser_softphone(), /reconnecting/);
    assert.equal(t.obj.state.softphone.client, t.client);
    assert.equal(t.logouts(), 0);
});

test('customer hangup during recovery clears the call without waiting for the grace period', () => {
    const t = setup();
    t.obj.set_browser_network_issue('media', true);
    t.obj.state.softphone.pending_end_call = 'C1';
    t.obj.handle_call_disconnected({name: 'C1', status: 'Completed', direction: 'Outgoing'});
    assert.equal(t.obj.state.softphone.current_call_log, '');
    assert.equal(t.obj.state.softphone.pending_end_call, '');
    assert.equal(t.obj.browser_softphone_reconnecting(), false);
    t.advance(40000);
    t.obj.check_browser_network(t.client);
    assert.equal(t.obj.state.softphone.current_call_log, '');
});

test('a timed-out Stop status check remains queued for confirmation', async () => {
    const t = setup();
    let aborted = false;
    const pending = new Promise(() => {});
    pending.abort = () => {aborted = true;};
    t.ctx.frappe.call = arg => typeof arg === 'string' ? Promise.resolve({}) : pending;
    const stopping = t.obj.cancel_call_log('C1');
    const rejected = assert.rejects(stopping, /timed out/);
    await flush();
    assert.equal(t.timeouts.size, 1);
    [...t.timeouts.values()][0]();
    await rejected;
    assert.equal(aborted, true);
    assert.equal(t.obj.state.softphone.pending_end_call, 'C1');
    assert.equal(t.obj.state.softphone.current_call_log, 'C1');
});

test('the workdesk shows recovery only for the affected browser call', () => {
    const t = setup();
    t.ctx.frappe.utils = {escape_html: value => String(value)};
    t.obj.set_browser_network_issue('media', true);
    const current = t.obj.workdesk_phone_surface_html({name: 'C1', status: 'Connected'});
    assert.match(current, /Network issue—reconnecting/);
    assert.doesNotMatch(current, /Audio active/);
    const other = t.obj.workdesk_phone_surface_html({name: 'C2', status: 'Connected'});
    assert.doesNotMatch(other, /reconnecting/);
});

test('reconnection clears a provider-ended call despite stale local Connected data and healthy SDK', async () => {
    const t = setup();
    t.ctx.window.navigator.onLine = false;
    await t.obj.check_browser_network(t.client);
    let verifications = 0;
    t.ctx.frappe.call = arg => {
        assert.equal(arg.method, 'vobiz_system_call.api.webrtc.verify_browser_call');
        assert.equal(arg.args.call_log, 'C1');
        verifications++;
        return Promise.resolve({message: {name: 'C1', status: 'Completed', provider_state: 'ended'}});
    };
    t.ctx.window.navigator.onLine = true;
    await t.obj.check_browser_network(t.client, true);
    assert.equal(verifications, 1);
    assert.equal(t.obj.state.softphone.current_call_log, '');
    assert.equal(t.obj.state.softphone.in_call, false);
    assert.equal(t.obj.state.softphone.recovery_verification, null);
});

test('restored internet alone cannot restore In Call while provider state is unknown', async () => {
    const t = setup();
    t.obj.set_browser_network_issue('offline', true);
    let checks = 0;
    t.ctx.frappe.call = () => {
        checks++;
        return Promise.resolve({message: {name: 'C1', status: 'Connected', provider_state: 'unknown'}});
    };
    await t.obj.check_browser_network(t.client, true);
    assert.match(t.obj.browser_softphone_network_message(), /checking call status/);
    t.advance(3000);
    await t.obj.check_browser_network(t.client, true);
    assert.equal(checks, 1);
    t.advance(7000);
    await t.obj.check_browser_network(t.client, true);
    assert.equal(checks, 2);
    assert.equal(t.hangups(), 0);
});

test('verification failure remains pending rather than claiming that audio recovered', async () => {
    const t = setup();
    t.obj.set_browser_network_issue('offline', true);
    t.ctx.frappe.call = () => Promise.reject({status: 503});
    await t.obj.check_browser_network(t.client, true);
    assert.match(t.obj.browser_softphone_network_message(), /checking call status/);
    assert.equal(t.obj.state.softphone.current_call_log, 'C1');
    assert.equal(t.logouts() + t.hangups(), 0);
});

test('late verification of an old call cannot clear a newer call', async () => {
    const t = setup();
    let resolve;
    t.obj.set_browser_network_issue('offline', true);
    t.ctx.frappe.call = () => new Promise(done => {resolve = done;});
    const checking = t.obj.check_browser_network(t.client, true);
    await flush();
    t.obj.state.softphone.current_call_log = 'C2';
    t.obj.state.softphone.sdk_call_uuid = 'sdk-2';
    resolve({message: {name: 'C1', status: 'Completed', provider_state: 'ended'}});
    await checking;
    assert.equal(t.obj.state.softphone.current_call_log, 'C2');
    assert.equal(t.hangups(), 0);
});

test('a second outage invalidates an earlier active verification', async () => {
    const t = setup();
    let resolve;
    t.obj.set_browser_network_issue('offline', true);
    t.ctx.frappe.call = () => new Promise(done => {resolve = done;});
    const checking = t.obj.check_browser_network(t.client, true);
    await flush();
    t.obj.set_browser_network_issue('offline', true);
    t.obj.set_browser_network_issue('offline', false);
    resolve({message: {name: 'C1', status: 'Connected', provider_state: 'active'}});
    await checking;
    assert.match(t.obj.browser_softphone_network_message(), /checking call status/);
});

test('provider active cannot claim audio resumed when the SDK peer connection is gone', async () => {
    const t = setup();
    t.obj.set_browser_network_issue('offline', true);
    t.sdk.getPeerConnection = () => ({pc: null});
    await t.obj.check_browser_network(t.client, true);
    assert.match(t.obj.browser_softphone_network_message(), /checking call status/);
});
