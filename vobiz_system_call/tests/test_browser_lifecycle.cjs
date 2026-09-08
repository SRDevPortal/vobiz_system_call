const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const ctx = {
    frappe: { pages: { 'vobiz-agent-console': {} }, show_alert() {} },
    __: x => x, window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
};
vm.createContext(ctx);
vm.runInContext(script + '\nthis.ConsoleClass = VobizAgentConsole;', ctx);
function instance() {
    const obj = Object.create(ctx.ConsoleClass.prototype);
    obj.state = {softphone: {current_call_log: 'C1', registered: true}, auto_dial: {}};
    for (const name of ['render_browser_softphone', 'render_workdesk_live_call', 'update_workdesk_primary_action',
        'maybe_prompt_workdesk_disposition', 'load', 'clear_tracked_live_call']) obj[name] = () => {};
    obj.is_terminal_status = s => ['Completed', 'Cancelled', 'Failed'].includes(s);
    return obj;
}
(async () => {
    const obj = instance(), order = [];
    obj.state.softphone.client = {client: {hangup() {order.push('sdk');}}};
    obj.reset_browser_softphone_call_state = () => order.push('reset');
    ctx.frappe.call = (method) => {
        if (typeof method === 'string') { order.push(method); return Promise.resolve({}); }
        return Promise.resolve({message: {name: 'C1', status: 'Cancelled'}});
    };
    await obj.cancel_call_log('C1');
    assert.equal(order[0], 'sdk');
    assert.equal(order[1], 'vobiz_system_call.api.webrtc.cancel_browser_call');
    assert.ok(order.includes('reset'));

    const startup = instance();
    startup.connect_browser_softphone = () => Promise.reject(new Error('login failed'));
    let cancelled;
    startup.cancel_call_log = name => {cancelled = name; return Promise.resolve();};
    await assert.rejects(startup.start_browser_softphone_call({call_log: 'C2'}, {}), /login failed/);
    assert.equal(cancelled, 'C2');

    const pending = instance();
    pending.state.softphone.client = {client: {hangup() {}}};
    let reset = false;
    pending.reset_browser_softphone_call_state = () => {reset = true;};
    ctx.frappe.call = method => Promise.resolve(typeof method === 'string' ? {} : {message: {name: 'C1', status: 'Connected'}});
    await pending.cancel_call_log('C1');
    assert.equal(reset, false);
    assert.equal(pending.state.softphone.status, 'Waiting for provider confirmation');

    const late = instance();
    late.state.softphone.sdk_call_uuid = 'new-call';
    assert.equal(late.matches_browser_call_event({call_uuid: 'old-call'}), false);
    assert.equal(late.matches_browser_call_event({call_uuid: 'new-call'}), true);
    const sdk = instance(), timers = [], scripts = [];
    sdk.state.softphone.config = {sdk_url: 'https://example.invalid/sdk.js'};
    ctx.document = {
        createElement() { const element = {remove() {}}; scripts.push(element); return element; },
        head: {appendChild() {}},
    };
    ctx.setTimeout = fn => {timers.push(fn); return timers.length;};
    ctx.clearTimeout = () => {};
    const loading = sdk.load_browser_softphone_sdk();
    timers.pop()();
    await assert.rejects(loading, /failed to load/);
    assert.equal(sdk.state.softphone.sdk_promise, null);
    const retry = sdk.load_browser_softphone_sdk();
    assert.equal(scripts.length, 2);
    ctx.window.Vobiz = function() {};
    scripts[1].onload();
    await retry;

    const registration = instance();
    registration.state.softphone.registered = false;
    registration.state.softphone.config = {enabled: true, call_device: 'Browser Softphone'};
    registration.load_browser_softphone_sdk = () => Promise.resolve();
    registration.send_browser_presence = () => Promise.resolve();
    registration.bind_browser_softphone_events = () => {};
    ctx.window.Vobiz = function() { this.client = {login() {}, logout() {}}; };
    const connecting = registration.connect_browser_softphone();
    for (let n = 0; n < 6; n++) await Promise.resolve();
    timers.pop()();
    await assert.rejects(connecting, /timed out/);
    assert.equal(registration.state.softphone.registered, false);
    assert.equal(registration.state.softphone.client, null);
    assert.equal(registration.state.softphone.register_promise, null);
    console.log('6 browser lifecycle tests passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
