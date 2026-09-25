const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');

function setup() {
    const timers = [], calls = [];
    let ids = 0;
    const ctx = {frappe: {pages: {'vobiz-agent-console': {}}, ui: {}, call: arg => {
        calls.push(arg); return Promise.resolve({message: {registered: true}});
    }}, __: x => x, window: {crypto: {randomUUID: () => `window-${++ids}`},
        sessionStorage: {getItem: () => 'copied-attendance-id'}}, console,
        setTimeout(fn, ms) {const t = {fn, ms}; timers.push(t); return t;},
        clearTimeout(t) {const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1);},
        clearInterval() {}, setInterval() {}};
    vm.createContext(ctx);
    vm.runInContext(source + '\nthis.Class = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.Class.prototype);
    obj.state = {softphone: {config: {enabled: true, call_device: 'Browser Softphone'},
        registered: false, current_call_log: '', ownership_blocked: false}, active_call: {}, auto_dial: {}};
    obj.render_browser_softphone = () => {};
    obj.stop_browser_network_monitor = () => {};
    obj.browser_request_with_timeout = p => Promise.resolve(p);
    return {ctx, obj, timers, calls};
}
const flush = () => new Promise(setImmediate);

test('duplicated tabs receive distinct softphone IDs while attendance is untouched', () => {
    const {obj, ctx} = setup();
    const other = Object.create(ctx.Class.prototype);
    obj.attendance_tab_id = other.attendance_tab_id = 'copied-attendance-id';
    assert.notEqual(obj.get_softphone_tab_id(), other.get_softphone_tab_id());
    assert.equal(obj.get_softphone_tab_id(), obj.get_softphone_tab_id());
    assert.equal(obj.attendance_tab_id, other.attendance_tab_id);
});

test('Use here is hidden during startup, registration and a registered session', () => {
    const {obj} = setup();
    assert.equal(obj.show_softphone_use_here(), false);
    obj.state.softphone.ownership_blocked = true;
    assert.equal(obj.show_softphone_use_here(), true);
    obj.state.softphone.registering = true;
    assert.equal(obj.show_softphone_use_here(), false);
    obj.state.softphone.registering = false;
    obj.state.softphone.registered = true;
    assert.equal(obj.show_softphone_use_here(), false);
    obj.state.softphone.registered = false;
    obj.state.softphone.ownership_blocked = false;
    obj.state.softphone.connection_attempted = true;
    assert.equal(obj.show_softphone_use_here(), true, 'failed registration can be retried explicitly');
});

test('blocked windows do not reconnect automatically', async () => {
    const {obj} = setup();
    obj.state.softphone.ownership_blocked = true;
    let logins = 0;
    obj.connect_browser_softphone = () => {logins++; return Promise.resolve();};
    await obj.auto_connect_browser_softphone();
    assert.equal(logins, 0);
});

test('initial ownership conflict shows the button without opening a popup', async () => {
    const {obj, ctx} = setup();
    let prompts = 0;
    obj.connect_browser_softphone = () => {
        obj.state.softphone.ownership_blocked = true;
        return Promise.reject(obj.softphone_ownership_error());
    };
    ctx.frappe.ui.Dialog = function() {prompts++;};
    await obj.auto_connect_browser_softphone();
    await obj.auto_connect_browser_softphone();
    assert.equal(prompts, 0);
    assert.equal(obj.show_softphone_use_here(), true);
});

test('new SDK login waits for a server-granted handoff', async () => {
    const {obj, ctx, timers} = setup();
    const requests = [];
    let logins = 0;
    ctx.frappe.call = arg => {requests.push(arg); return Promise.resolve({message: requests.length === 1
        ? {ownership: 'waiting', transfer_token: 'switch-token'} : {ownership: 'granted'}});};
    obj.state.softphone.ownership_blocked = true;
    obj.connect_browser_softphone = async () => {assert.equal(obj.state.softphone.ownership_blocked, false); logins++;};
    const pending = obj.use_softphone_here();
    await flush();
    assert.equal(logins, 0);
    assert.equal(timers.length, 1);
    timers.shift().fn();
    await pending;
    assert.equal(logins, 1);
    assert.equal(requests[1].args.transfer_token, 'switch-token');
    assert.equal(requests[1].args.tab_id, obj.get_softphone_tab_id());
});

test('local live or pending call blocks a switch before any request', async () => {
    const {obj, calls} = setup();
    for (const state of [{current_call_log: 'C1'}, {pending_end_call: 'C1'}, {in_call: true}, {incoming_pending: true}]) {
        obj.state.softphone = state;
        await obj.use_softphone_here();
        assert.match(obj.state.softphone.error, /Finish the current call/);
    }
    assert.equal(calls.length, 0);
});

test('fast handoff polling still waits for a late server grant after the old lease', async () => {
    const {obj, ctx, timers} = setup();
    let waited = 0, logins = 0;
    ctx.frappe.call = () => Promise.resolve({message: waited >= 66000
        ? {ownership: 'granted'} : {ownership: 'waiting', transfer_token: 'late-grant'}});
    obj.connect_browser_softphone = async () => {assert.ok(waited >= 66000); logins++;};
    const pending = obj.use_softphone_here();
    await flush();
    assert.ok(timers[0].ms <= 250, 'prompt logout should be checked within 250ms');
    while (timers.length) {
        assert.equal(logins, 0);
        const timer = timers.shift();
        if (waited >= 1000) assert.equal(timer.ms, 1000, 'long waits must back off');
        waited += timer.ms;
        timer.fn();
        await flush();
    }
    await pending;
    assert.equal(logins, 1);
    assert.equal(obj.state.softphone.switching_window, false);
});

test('fast polling preserves the full fallback wait and never logs in on timeout', async () => {
    const {obj, ctx, timers} = setup();
    let waited = 0, polls = 0, logins = 0;
    ctx.frappe.call = () => {polls++; return Promise.resolve({message: {ownership:'waiting', transfer_token:'no-grant'}});};
    obj.connect_browser_softphone = async () => {logins++;};
    const pending = obj.use_softphone_here();
    await flush();
    while (timers.length) {
        const timer = timers.shift();
        waited += timer.ms;
        timer.fn();
        await flush();
    }
    await pending;
    assert.equal(waited, 75000);
    assert.ok(polls <= 80, 'faster startup must not cause sustained aggressive polling');
    assert.equal(logins, 0);
    assert.equal(obj.state.softphone.ownership_blocked, true);
    assert.match(obj.state.softphone.error, /timed out/);
});

test('server active-call refusal preserves the old window and prevents new SDK login', async () => {
    const {obj, ctx} = setup();
    let logins = 0;
    ctx.frappe.call = () => Promise.resolve({message: {ownership: 'active_call'}});
    obj.connect_browser_softphone = async () => logins++;
    await obj.use_softphone_here();
    assert.equal(logins, 0);
    assert.match(obj.state.softphone.error, /Use End Call/);
    assert.equal(obj.state.softphone.switching_window, false);
});

test('old window acknowledges only after SDK logout, with late SDK events fenced', async () => {
    const {obj, ctx} = setup();
    const events = [], requests = [];
    let loggedOut;
    const sdk = {getCallUUID: () => '', on(event, callback) {loggedOut = callback;}, logout() {events.push('logout');}};
    obj.state.softphone.client = {client: sdk};
    obj.state.softphone.registered = true;
    ctx.frappe.call = arg => {
        requests.push(arg);
        if (arg.method.endsWith('release_for_switch')) events.push('ack');
        return Promise.resolve({message: {ownership: 'release_requested'}});
    };
    obj.mark_softphone_other_window = () => events.push('inactive');
    const pending = obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'token'});
    await flush();
    assert.deepEqual(events, ['logout']);
    assert.equal(obj.state.softphone.client, null);
    loggedOut();
    await pending;
    assert.deepEqual(events, ['logout', 'ack', 'inactive']);
    assert.equal(requests[1].args.busy, 0);
});

test('stale release messages cannot log out the current SDK', async () => {
    const {obj, ctx} = setup();
    let logouts = 0;
    obj.state.softphone.client = {client: {getCallUUID: () => '', logout() {logouts++;}}};
    ctx.frappe.call = () => Promise.resolve({message: {ownership: 'expired'}});
    await obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'old-token'});
    assert.equal(logouts, 0);
    assert.ok(obj.state.softphone.client);
});

test('old SDK reporting a live session refuses handoff without logout', async () => {
    const {obj, ctx} = setup();
    let logouts = 0, ack;
    obj.state.softphone.client = {client: {getCallUUID: () => 'live-uuid', logout() {logouts++;}}};
    ctx.frappe.call = arg => {
        if (arg.method.endsWith('release_for_switch')) ack = arg.args;
        return Promise.resolve({message: {ownership: 'release_requested'}});
    };
    await obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'token'});
    assert.equal(logouts, 0);
    assert.equal(ack.busy, 1);
});

test('an auto-dial session between calls refuses handoff without losing its queue', async () => {
    const {obj, ctx} = setup();
    let logouts = 0, ack;
    obj.state.auto_dial = {running: true, queue: ['LEAD-1', 'LEAD-2']};
    obj.state.softphone.client = {client: {getCallUUID: () => '', logout() {logouts++;}}};
    ctx.frappe.call = arg => {
        if (arg.method.endsWith('release_for_switch')) ack = arg.args;
        return Promise.resolve({message: {ownership: 'release_requested'}});
    };
    await obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'token'});
    assert.equal(logouts, 0);
    assert.equal(ack.busy, 1);
    assert.deepEqual(obj.state.auto_dial.queue, ['LEAD-1', 'LEAD-2']);
});

test('missing SDK logout confirmation never acknowledges a completed handoff', async () => {
    const {obj, ctx, timers} = setup();
    let acknowledgements = 0;
    obj.state.softphone.client = {client: {getCallUUID: () => '', on() {}, logout() {}}};
    ctx.frappe.call = arg => {
        if (arg.method.endsWith('release_for_switch')) acknowledgements++;
        return Promise.resolve({message: {ownership: 'release_requested'}});
    };
    obj.mark_softphone_other_window = () => {};
    const pending = obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'token'});
    await flush();
    const assertion = assert.rejects(pending, /old softphone/);
    timers.shift().fn();
    await assertion;
    assert.equal(acknowledgements, 0);
});

test('late grant notifications verify ownership before changing a healthy window', async () => {
    const {obj, calls} = setup();
    obj.state.softphone.registered = true;
    obj.handle_softphone_ownership({state: 'granted', tab_id: 'old-other-window'});
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(obj.state.softphone.registered, true);
    assert.equal(obj.state.softphone.ownership_blocked, false);
});

test('registration cannot continue after the handoff revoked a pending presence claim', async () => {
    const {obj} = setup();
    let resolvePresence;
    obj.load_browser_softphone_sdk = () => Promise.resolve();
    obj.send_browser_presence = registered => registered === false ? Promise.resolve() : new Promise(r => {resolvePresence = r;});
    const pending = obj.connect_browser_softphone();
    await flush();
    obj.state.softphone.ownership_blocked = true;
    resolvePresence({});
    await assert.rejects(pending, /softphone registration/);
    assert.equal(obj.state.softphone.client, null);
});

test('two browser windows complete handoff without realtime or waiting for the presence heartbeat', async () => {
    const old = setup(), next = setup();
    old.obj.softphone_tab_id = 'old-window';
    next.obj.softphone_tab_id = 'new-window';
    const channels = [];
    class Channel {
        constructor(name) {this.name = name; channels.push(this);}
        postMessage(data) {for (const c of channels) if (c !== this && c.name === this.name) c.onmessage({data});}
    }
    old.ctx.window.BroadcastChannel = next.ctx.window.BroadcastChannel = Channel;
    let granted = false, logoutEvent, logins = 0, heartbeatRequests = 0;
    old.obj.state.softphone.client = {client: {
        getCallUUID: () => '', on(event, fn) {logoutEvent = fn;}, logout() {logoutEvent();}
    }};
    old.obj.state.softphone.registered = true;
    old.obj.mark_softphone_other_window = () => {old.obj.state.softphone.ownership_blocked = true;};
    old.ctx.frappe.call = arg => {
        if (arg.method.endsWith('browser_presence')) heartbeatRequests++;
        if (arg.method.endsWith('release_for_switch')) granted = true;
        return Promise.resolve({message: {ownership: 'release_requested'}});
    };
    next.ctx.frappe.call = () => Promise.resolve({message: granted ? {ownership: 'granted'} :
        {ownership: 'waiting', old_tab: 'old-window', transfer_token: 'token'}});
    next.obj.connect_browser_softphone = async () => {assert.equal(granted, true); logins++;};
    old.obj.bind_softphone_window_channel();
    const pending = next.obj.use_softphone_here();
    await flush();
    assert.equal(granted, true);
    assert.equal(heartbeatRequests, 0);
    assert.equal(logins, 0);
    next.timers.shift().fn();
    await pending;
    assert.equal(logins, 1);
    assert.equal(old.obj.state.softphone.ownership_blocked, true);
});

test('storage fallback signals the exact window and removes the temporary value', () => {
    const {obj, ctx} = setup();
    const actions = [];
    ctx.window.localStorage = {
        setItem(key, value) {actions.push(['set', key, JSON.parse(value)]);},
        removeItem(key) {actions.push(['remove', key]);}
    };
    obj.signal_softphone_window({state: 'release_requested', tab_id: 'old-window', transfer_token: 'token'});
    assert.equal(actions[0][2].tab_id, 'old-window');
    assert.equal(actions[1][0], 'remove');
    assert.equal(actions[1][1], actions[0][1]);
});

test('superseded and expired switch results explain what happened', () => {
    const {obj} = setup();
    assert.match(obj.softphone_ownership_error('superseded').message, /selected in another window/);
    assert.match(obj.softphone_ownership_error('expired').message, /expired/);
});

test('a replacement token is acknowledged after the older SDK logout finishes', async () => {
    const {obj, ctx} = setup();
    let loggedOut;
    const acknowledgements = [];
    obj.state.softphone.client = {client: {
        getCallUUID: () => '', on(event, fn) {loggedOut = fn;}, logout() {}
    }};
    obj.mark_softphone_other_window = () => {};
    ctx.frappe.call = arg => {
        if (arg.method.endsWith('release_for_switch')) acknowledgements.push(arg.args.transfer_token);
        return Promise.resolve({message: {ownership: 'release_requested'}});
    };
    const first = obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'first'});
    await flush();
    const replacement = obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'replacement'});
    loggedOut();
    await Promise.all([first, replacement]);
    assert.deepEqual(acknowledgements, ['first', 'replacement']);
});

test('old logout completion cannot disable a window that explicitly reclaimed ownership', async () => {
    const {obj, ctx} = setup();
    let loggedOut, incorrectlyDisabled = 0;
    obj.state.softphone.client = {client: {
        getCallUUID: () => '', on(event, fn) {loggedOut = fn;}, logout() {}
    }};
    obj.mark_softphone_other_window = () => incorrectlyDisabled++;
    ctx.frappe.call = arg => Promise.resolve({message: {ownership:
        arg.method.endsWith('use_here') ? 'granted' : 'release_requested'}});
    obj.connect_browser_softphone = async () => {obj.state.softphone.registered = true;};
    const oldRelease = obj.release_softphone_for_switch({tab_id: obj.get_softphone_tab_id(), transfer_token: 'old'});
    await flush();
    const reclaim = obj.use_softphone_here();
    await flush();
    assert.equal(obj.state.softphone.registered, false);
    loggedOut();
    await Promise.all([oldRelease, reclaim]);
    assert.equal(incorrectlyDisabled, 0);
    assert.equal(obj.state.softphone.registered, true);
    assert.equal(obj.state.softphone.ownership_blocked, false);
});
