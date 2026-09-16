const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const completed = {name: 'C1', status: 'Completed', direction: 'Outgoing', reference_doctype: 'CRM Lead', reference_name: 'LEAD1'};
class Request extends Promise {always(fn) {return this.finally(fn);}}
const flush = () => new Promise(setImmediate);

function setup() {
    const timers = [], opened = [], requests = [];
    const ctx = {frappe: {pages: {'vobiz-agent-console': {}}, call(method) {
        const name = typeof method === 'string' ? method : method.method;
        requests.push(name);
        return Request.resolve({message: name.endsWith('get_agent_console_data')
            ? {active_call: {mapping: 'agent', availability_status: 'Available'}, queue: [], ai_disposition_enabled: false}
            : completed});
    }}, __: x => x, console, window: {},
        setTimeout(fn) {timers.push(fn); return fn;}, clearTimeout() {}, clearInterval() {}, setInterval() {}};
    vm.createContext(ctx); vm.runInContext(source + '\nthis.Class = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.Class.prototype);
    const client = {client: {getCallUUID: () => ''}};
    obj.state = {softphone: {client, current_call_log: 'C1', registered: true, in_call: true,
        recovery_verification: {call_log: 'C1'}, network_issues: {}}, active_call: {...completed, status: 'Connected'},
        auto_dial: {}, queue: [], queue_filters: [], ai_disposition_enabled: false};
    obj.page = {main: {find: () => ({val: () => ''})}};
    obj.agent_console_targets = () => ({text() {}});
    obj.browser_request_with_timeout = p => p;
    obj.is_console_visible = () => true;
    obj.default_queue_meta = () => ({});
    obj.set_browser_network_issue = () => {};
    for (const name of ['stop_browser_softphone_audio', 'stop_timer', 'render_browser_softphone', 'render_queue',
        'render_workdesk_live_call', 'update_workdesk_primary_action', 'render_header_active_call', 'render_call_assets',
        'prune_selected_queue_keys', 'reset_filter_group_if_doctype_changed', 'render_availability', 'render_filter_button',
        'render_dispositions', 'render_manual_disposition_visibility', 'refresh_workdesk_live_call', 'render_auto_toggle',
        'refresh_auto_dial_current', 'render_auto_live', 'maybe_continue_auto_dial', 'restore_workdesk_dialog']) obj[name] = () => {};
    obj.open_post_call_disposition_dialog = (...args) => opened.push(args);
    return {obj, ctx, client, timers, opened, requests};
}

test('reconnect opens disposition once even when console reload omits the finished call', async () => {
    const t = setup();
    await t.obj.verify_recovered_browser_call(t.client);
    await flush();
    assert.equal(t.obj.state.softphone.current_call_log, '');
    assert.equal(t.obj.state.active_call.last_call, undefined, 'server has already released its mapping');
    assert.equal(t.timers.length, 1, 'recovery must request disposition before the finished call is lost');
    t.obj.maybe_prompt_workdesk_disposition(completed);
    assert.equal(t.timers.length, 1, 'recovery and duplicate notifications share one prompt');
    t.timers.shift()();
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0][0].name, 'C1');
    assert.equal(t.opened[0][1].name, 'LEAD1');
});

test('status polling also opens disposition for a finished call omitted from the console', async () => {
    const t = setup();
    t.obj.state.active_call = {mapping: 'agent', availability_status: 'Available'};
    await t.obj.refresh_browser_softphone_call(t.obj.state.active_call);
    assert.equal(t.timers.length, 1);
    t.timers.shift()();
    assert.equal(t.opened[0][0].name, 'C1');
});

test('active, uncertain and failed verification responses never open disposition', async () => {
    for (const result of [{name: 'C1', status: 'Connected'}, {name: 'C1', provider_state: 'unknown'}, null]) {
        const t = setup();
        t.ctx.frappe.call = () => result ? Request.resolve({message: result}) : Request.reject(Error('offline'));
        await t.obj.verify_recovered_browser_call(t.client);
        assert.equal(t.timers.length, 0);
        assert.equal(t.obj.state.softphone.current_call_log, 'C1');
    }
});

test('a late recovered status cannot interrupt a newer call', async () => {
    const t = setup(); let resolve;
    t.ctx.frappe.call = () => new Request(done => {resolve = done;});
    const pending = t.obj.verify_recovered_browser_call(t.client);
    t.obj.state.softphone.current_call_log = 'C2';
    t.obj.state.active_call = {name: 'C2', status: 'Connected'};
    resolve({message: completed}); await pending;
    assert.equal(t.timers.length, 0);
    assert.equal(t.obj.state.softphone.current_call_log, 'C2');
});

test('automatic prompt scheduled before a newer call starts is cancelled', () => {
    const t = setup();
    t.obj.maybe_prompt_workdesk_disposition(completed);
    t.obj.state.softphone.current_call_log = 'C2';
    t.obj.state.active_call = {name: 'C2', status: 'Connected'};
    t.timers.shift()();
    assert.equal(t.opened.length, 0);
});

test('delayed disposition context cannot open the old automatic dialog during a newer call', () => {
    const t = setup();
    t.obj.state.softphone.current_call_log = 'C2';
    t.obj.state.active_call = {name: 'C2', status: 'Connected'};
    Object.getPrototypeOf(t.obj).open_post_call_disposition_dialog.call(t.obj, completed,
        {doctype: 'CRM Lead', name: 'LEAD1'}, null, {check_current_call: true});
    assert.equal(t.requests.length, 0);
});

test('automatic reconciliation preserves AI, auto-dial and excluded-reference disposition rules', () => {
    for (const scenario of ['ai', 'auto-dial', 'Issue', 'Patient Encounter']) {
        const t = setup(); let call = {...completed};
        if (scenario === 'ai') t.obj.state.ai_disposition_enabled = true;
        else if (scenario === 'auto-dial') t.obj.state.auto_dial = {running: true, current: {call_log: 'C1'}};
        else call.reference_doctype = scenario;
        t.obj.reconcile_browser_softphone_call(call);
        assert.equal(t.obj.state.softphone.current_call_log, '');
        assert.equal(t.timers.length, 0, scenario);
    }
});

test('Bharat sparse completion followed by full completion opens disposition exactly once', () => {
    const t = setup();
    t.obj.handle_call_disconnected({name: 'C1', status: 'Completed'});
    assert.equal(t.obj.state.softphone.current_call_log, '');
    t.obj.handle_call_disconnected(completed);
    t.obj.handle_call_disconnected(completed);
    assert.equal(t.timers.length, 1);
    t.timers.shift()();
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0][0].reference_name, 'LEAD1');
});

test('missing context is recovered by exact ID after the SDK has already been cleared', async () => {
    const t = setup();
    t.obj.state.active_call = {name: 'C1', status: 'Connected'};
    t.obj.handle_call_disconnected({name: 'C1', status: 'Completed'});
    assert.equal(t.opened.length, 0);
    await t.timers.shift()();
    await flush();
    t.timers.shift()();
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0][0].name, 'C1');
    assert.equal(t.opened[0][1].name, 'LEAD1');
});

test('full update still works after cleanup and a console refresh without last_call', () => {
    const t = setup();
    t.obj.state.active_call = {name: 'C1', status: 'Connected'};
    t.obj.handle_call_disconnected({name: 'C1', status: 'Completed'});
    t.obj.state.active_call = {mapping: 'agent'};
    t.obj.handle_call_disconnected(completed);
    // First timer is status recovery, second is the independently delivered full event.
    t.timers.pop()();
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0][0].reference_name, 'LEAD1');
});

test('a late terminal notification cannot clear or interrupt a newer active call', () => {
    const t = setup();
    t.obj.completed_call_contexts = new Map([['C1', completed]]);
    t.obj.state.softphone.current_call_log = 'C2';
    t.obj.state.active_call = {name: 'C2', status: 'Connected', last_call: completed};
    t.obj.handle_call_disconnected(completed);
    assert.equal(t.obj.state.active_call.name, 'C2');
    assert.equal(t.obj.state.softphone.current_call_log, 'C2');
    assert.equal(t.timers.length, 0);
    // Once idle, rendering drains the preserved completion independently of call cleanup.
    t.obj.state.softphone.current_call_log = '';
    t.obj.state.softphone.in_call = false;
    t.obj.state.active_call = {};
    t.obj.render_active_call();
    t.timers.shift()();
    assert.equal(t.opened.length, 1);
});

test('transient status failure retries instead of losing disposition', async () => {
    const t = setup(); let requests = 0;
    t.obj.load = () => {};
    t.ctx.frappe.call = () => ++requests === 1 ? Request.reject(Error('offline')) : Request.resolve({message: completed});
    t.obj.watch_browser_call_disposition('C1');
    await t.timers.shift()();
    assert.equal(t.obj.browser_disposition_watchers.has('C1'), true);
    await t.timers.shift()();
    t.timers.shift()();
    assert.equal(t.opened.length, 1);
});
