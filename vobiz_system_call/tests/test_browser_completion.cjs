const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');

function setup() {
    const timers = [];
    const ctx = {
        frappe: {pages: {'vobiz-agent-console': {}}, show_alert() {}},
        __: x => x, window: {}, console,
        setTimeout(fn) {timers.push(fn); return fn;},
        clearTimeout(fn) {const index = timers.indexOf(fn); if (index >= 0) timers.splice(index, 1);},
        setInterval() {}, clearInterval() {},
    };
    vm.createContext(ctx);
    vm.runInContext(source + '\nthis.ConsoleClass = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.ConsoleClass.prototype);
    obj.state = {
        softphone: {current_call_log: 'C1', sdk_call_uuid: 'sdk-1', registered: true,
            in_call: true, status: 'In Call', client: {client: {hangup() {}}}},
        active_call: {name: 'C1', status: 'Connected', direction: 'Outgoing'},
        auto_dial: {},
    };
    for (const name of ['render_active_call', 'render_browser_softphone', 'render_workdesk_live_call',
        'update_workdesk_primary_action', 'maybe_prompt_workdesk_disposition', 'load',
        'stop_browser_softphone_audio', 'stop_timer', 'render_queue']) obj[name] = () => {};
    obj.clear_tracked_live_call = name => {
        if (obj.state.workdesk_live_call_log === name) obj.state.workdesk_live_call_log = '';
    };
    return {obj, ctx, timers};
}
function assertCleared(obj) {
    assert.equal(obj.state.softphone.current_call_log, '');
    assert.equal(obj.state.softphone.in_call, false);
    assert.equal(obj.state.softphone.status, 'Registered');
}
function newCall(obj) {
    obj.state.softphone.current_call_log = 'C2';
    obj.state.softphone.sdk_call_uuid = 'sdk-2';
    obj.state.softphone.status = 'In Call';
    obj.state.active_call = {name: 'C2', status: 'Connected'};
    obj.state.workdesk_live_call_log = 'C2';
}
test('End Call never hangs up a different SDK session but still requests server cancellation', async () => {
    const {obj, ctx} = setup();
    let hangups = 0, cancellations = 0;
    obj.state.softphone.client.client = {getCallUUID: () => 'sdk-NEW', hangup() {hangups++;}};
    obj.browser_request_with_timeout = p => p;
    obj.watch_browser_call_disposition = () => {};
    ctx.frappe.call = arg => {
        if (typeof arg === 'string') {cancellations++; return Promise.resolve({});}
        return Promise.resolve({message: {name: 'C1', status: 'Ringing'}});
    };
    await obj.cancel_call_log('C1');
    assert.equal(hangups, 0);
    assert.equal(cancellations, 1);
    assert.equal(obj.state.softphone.current_call_log, 'C1');
});
test('a restored console cancellation cannot replace a newer active call', async () => {
    const {obj, ctx} = setup();
    obj.state.softphone.current_call_log = '';
    let resolveStatus;
    ctx.frappe.call = arg => typeof arg === 'string' ? Promise.resolve({}) :
        new Promise(resolve => {resolveStatus = resolve;});
    const pending = obj.cancel_call_log('C1');
    await new Promise(resolve => setImmediate(resolve));
    obj.state.active_call = {name: 'C2', status: 'Connected'};
    resolveStatus({message: {name: 'C1', status: 'Completed'}});
    await pending;
    assert.equal(obj.state.active_call.name, 'C2');
});
test('a late old-call watcher cannot open disposition during a new call', async () => {
    const {obj, ctx, timers} = setup();
    let prompts = 0;
    obj.maybe_prompt_workdesk_disposition = () => prompts++;
    ctx.frappe.call = () => Promise.resolve({message: {name: 'C1', status: 'Completed'}});
    obj.watch_browser_call_disposition('C1');
    newCall(obj);
    await timers.shift()();
    assert.equal(prompts, 0);
    assert.equal(obj.state.active_call.name, 'C2');
});
test('provider completion clears incoming and outgoing softphones without an SDK end event', () => {
    for (const direction of ['Incoming', 'Outgoing']) {
        const {obj} = setup();
        let rendered = 0;
        obj.render_active_call = () => rendered++;
        obj.handle_call_disconnected({name: 'C1', status: 'Completed', direction});
        assertCleared(obj);
        assert.equal(obj.state.active_call.last_call.status, 'Completed');
        assert.ok(rendered > 0);
    }
});
test('SDK cleanup runs once and only for the matching SDK session', () => {
    for (const uuid of ['sdk-1', 'sdk-2']) {
        const {obj} = setup();
        let hangups = 0;
        obj.state.softphone.client.client = {getCallUUID: () => uuid, hangup() {
            hangups++;
            assert.equal(obj.state.softphone.current_call_log, '');
        }};
        obj.reconcile_browser_softphone_call({name: 'C1', status: 'Completed'});
        obj.reconcile_browser_softphone_call({name: 'C1', status: 'Completed'});
        assertCleared(obj);
        assert.equal(hangups, uuid === 'sdk-1' ? 1 : 0);
    }
});
test('first Stop pending followed by Completed clears without a second Stop', async () => {
    const {obj, ctx, timers} = setup();
    let status = 'Connected', requests = 0;
    ctx.frappe.call = arg => {
        if (typeof arg === 'string') {requests++; return Promise.resolve({});}
        assert.equal(arg.args.sync_provider, 0);
        return Promise.resolve({message: {name: 'C1', status}});
    };
    await obj.cancel_call_log('C1');
    assert.equal(obj.state.softphone.status, 'Waiting for provider confirmation');
    status = 'Completed';
    await timers.shift()();
    assertCleared(obj);
    assert.equal(requests, 1);
});
test('completion watcher clears after the initial cancellation request fails', async () => {
    const {obj, ctx, timers} = setup();
    ctx.frappe.call = arg => typeof arg === 'string'
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve({message: {name: 'C1', status: 'Completed'}});
    await assert.rejects(obj.cancel_call_log('C1'), /connection lost/);
    await timers.shift()();
    assertCleared(obj);
    assert.equal(obj.state.softphone.error, '');
});
test('late cancellation response does not clear a newer call', async () => {
    const {obj, ctx} = setup();
    let resolveStatus;
    ctx.frappe.call = arg => typeof arg === 'string' ? Promise.resolve({})
        : new Promise(resolve => {resolveStatus = resolve;});
    const stopping = obj.cancel_call_log('C1');
    while (!resolveStatus) await Promise.resolve();
    newCall(obj);
    resolveStatus({message: {name: 'C1', status: 'Completed'}});
    await stopping;
    assert.equal(obj.state.softphone.current_call_log, 'C2');
    assert.equal(obj.state.active_call.name, 'C2');
    assert.equal(obj.state.workdesk_live_call_log, 'C2');
});
test('late realtime, watcher and direct reset do not clear a newer call', async () => {
    const {obj, ctx, timers} = setup();
    obj.watch_browser_call_disposition('C1');
    newCall(obj);
    ctx.frappe.call = () => Promise.resolve({message: {name: 'C1', status: 'Completed'}});
    await timers.shift()();
    obj.handle_call_disconnected({name: 'C1', status: 'Completed', direction: 'Outgoing'});
    obj.reset_browser_softphone_call_state('Registered', 'C1', 'Completed');
    assert.equal(obj.state.softphone.current_call_log, 'C2');
    assert.equal(obj.state.softphone.status, 'In Call');
    assert.equal(obj.state.active_call.name, 'C2');
});
test('normal console polling verifies an omitted call and clears it only when terminal', async () => {
    for (const status of ['Connected', 'Completed']) {
        const {obj, ctx} = setup();
        ctx.frappe.call = arg => {
            assert.equal(arg.args.call_log, 'C1');
            assert.equal(arg.args.sync_provider, 0);
            return Promise.resolve({message: {name: 'C1', status}});
        };
        await obj.refresh_browser_softphone_call({});
        if (status === 'Completed') assertCleared(obj);
        else assert.equal(obj.state.softphone.current_call_log, 'C1');
    }
});
test('console polling handles last_call and ignores delayed results for an older call', async () => {
    const {obj, ctx} = setup();
    await obj.refresh_browser_softphone_call({last_call: {name: 'C1', status: 'Completed'}});
    assertCleared(obj);
    obj.state.softphone.current_call_log = 'C1';
    let resolveStatus;
    ctx.frappe.call = () => new Promise(resolve => {resolveStatus = resolve;});
    const polling = obj.refresh_browser_softphone_call({});
    newCall(obj);
    resolveStatus({message: {name: 'C1', status: 'Completed'}});
    await polling;
    assert.equal(obj.state.softphone.current_call_log, 'C2');
    assert.equal(obj.state.active_call.name, 'C2');
});
test('a fresh console release invalidates the cached page once and tolerates blocked storage', () => {
    const asset = fs.readFileSync(path.join(__dirname, '../public/js/vobiz_system_call.js'), 'utf8');
    const values = new Map([['_page:vobiz-agent-console', 'old page code']]);
    let removals = 0;
    const ctx = {
        frappe: {provide() {}}, vobiz_system_call: {},
        window: {localStorage: {
            getItem: key => values.get(key),
            setItem: (key, value) => values.set(key, value),
            removeItem(key) {removals++; values.delete(key);},
        }},
    };
    vm.createContext(ctx);
    vm.runInContext(asset, ctx);
    assert.equal(values.has('_page:vobiz-agent-console'), false);
    vm.runInContext(asset, ctx);
    assert.equal(removals, 1);
    ctx.window.localStorage = {getItem() {throw new Error('blocked');}};
    assert.doesNotThrow(() => vm.runInContext(asset, ctx));
});
