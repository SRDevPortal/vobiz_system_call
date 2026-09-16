const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const flush = () => new Promise(setImmediate);

function setup() {
    const requests = [], messages = [], opened = [], renders = [];
    const ctx = {
        console, window: {}, setTimeout, clearTimeout, __: x => x,
        frappe: {
            pages: { 'vobiz-agent-console': {} },
            utils: { escape_html: value => String(value || '').replace(/[&<>"']/g, x => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[x])) },
            msgprint: value => messages.push(value),
            call: request => {
                requests.push(request);
                return Promise.resolve({message: request.method.endsWith('get_call_status')
                    ? {name: 'C1', reference_doctype: 'CRM Lead', reference_name: 'LEAD1'}
                    : {reference: {name: 'LEAD1'}, workdesk: {}}});
            },
        },
    };
    vm.createContext(ctx);
    vm.runInContext(source + '\nthis.Console = VobizAgentConsole;', ctx);
    const c = Object.create(ctx.Console.prototype);
    let answers = 0;
    c.state = {queue: [], active_call: {}, softphone: {
        current_call_log: 'C1', incoming_call_uuid: 'SDK1', incoming_caller: '+919876543210',
        current_destination: '+919876543210', current_customer: 'Incoming customer',
        incoming_pending: true, incoming_answering: false, incoming_answered: false,
        client: {client: {answer() { answers++; return true; }}},
    }};
    c.stop_browser_microphone_test = () => {};
    c.attach_browser_softphone_audio = () => {};
    c.enable_browser_softphone_audio = () => {};
    c.apply_context_dispositions = () => {};
    c.render_browser_softphone = () => renders.push(c.workdesk_incoming_controls_html());
    c.open_detail_dialog = (row, context) => opened.push({row, context});
    return {c, ctx, requests, messages, opened, renders, answers: () => answers};
}

test('workdesk Pickup uses the existing answer flow and suppresses duplicate clicks', () => {
    const t = setup();
    t.c.state.active_workdesk_row = {doctype: 'CRM Lead', name: 'OTHER'};
    const html = t.c.workdesk_incoming_controls_html();
    assert.match(html, /Incoming customer/);
    assert.match(html, /data-incoming-answer data-call-log="C1"/);
    t.c.answer_browser_softphone('C1');
    t.c.answer_browser_softphone('C1');
    assert.equal(t.answers(), 1);
    assert.match(t.c.workdesk_incoming_controls_html(), /data-incoming-answer[^>]*disabled/);
    assert.match(t.c.workdesk_incoming_controls_html(), /Connecting…/);
    t.c.state.softphone.incoming_answered = true;
    assert.equal(t.c.workdesk_incoming_controls_html(), '');
});

test('rejected Pickup returns to an enabled button inside Workdesk', async () => {
    const t = setup();
    t.c.state.softphone.client.client.answer = () => Promise.resolve(false);
    t.c.answer_browser_softphone('C1');
    await flush();
    const html = t.c.workdesk_incoming_controls_html();
    assert.match(html, /Pick Call/);
    assert.doesNotMatch(html, /data-incoming-answer[^>]*disabled/);
});

test('stale Workdesk buttons cannot answer or open a newer call', async () => {
    const t = setup();
    t.c.answer_browser_softphone('OLD');
    await t.c.open_softphone_workdesk('OLD');
    assert.equal(t.answers(), 0);
    assert.equal(t.requests.length, 0);
});

test('caller details in the workdesk banner are escaped', () => {
    const t = setup();
    t.c.state.softphone.current_customer = '<img src=x onerror=alert(1)>';
    assert.doesNotMatch(t.c.workdesk_incoming_controls_html(), /<img/);
    assert.match(t.c.workdesk_incoming_controls_html(), /&lt;img/);
});

test('Open Workdesk resolves the exact call reference even when the customer is absent from the queue', async () => {
    const t = setup();
    t.c.state.queue = [{doctype: 'CRM Lead', name: 'WRONG', phone: '+919876543210'}];
    t.c.state.selected = t.c.state.queue[0];
    await t.c.open_softphone_workdesk('C1');
    assert.equal(t.requests[0].args.call_log, 'C1');
    assert.equal(t.requests[0].args.sync_provider, 0);
    assert.equal(t.requests[1].args.reference_name, 'LEAD1');
    assert.equal(t.opened.length, 1);
    assert.equal(t.opened[0].row.name, 'LEAD1');
    assert.equal(t.answers(), 0, 'Opening the record does not answer the call');
    assert.equal(t.c.softphone_workdesk_request, null);
});

test('opening the current customer reuses the existing Workdesk', async () => {
    const t = setup();
    let shown = 0;
    t.c.state.active_workdesk_key = 'CRM Lead::LEAD1';
    t.c.state.active_workdesk_dialog = {show() { shown++; }};
    await t.c.open_softphone_workdesk('C1');
    assert.equal(shown, 1);
    assert.equal(t.requests.length, 1);
    assert.equal(t.opened.length, 0);
});

test('switching customers waits for the old modal to close', async () => {
    const t = setup();
    let afterHidden, hidden = false;
    t.c.state.active_workdesk_dialog = {
        $wrapper: {is: () => true, one(event, fn) { afterHidden = fn; }},
        hide() { hidden = true; },
    };
    await t.c.open_softphone_workdesk('C1');
    assert.equal(hidden, true);
    assert.equal(t.opened.length, 0);
    t.c.state.active_workdesk_dialog = null;
    afterHidden();
    assert.equal(t.opened.length, 1);
});

test('unlinked callers remain answerable without opening an arbitrary customer', async () => {
    const t = setup();
    t.ctx.frappe.call = () => Promise.resolve({message: {name: 'C1'}});
    await t.c.open_softphone_workdesk('C1');
    assert.equal(t.opened.length, 0);
    assert.match(t.messages[0], /not linked/);
    assert.match(t.c.workdesk_incoming_controls_html(), /Pick Call/);
});

test('duplicate Open clicks share the request and a late result cannot open a newer call', async () => {
    const t = setup();
    let resolve, count = 0;
    t.ctx.frappe.call = () => { count++; return new Promise(r => { resolve = r; }); };
    const pending = t.c.open_softphone_workdesk('C1');
    await t.c.open_softphone_workdesk('C1');
    assert.equal(count, 1);
    t.c.state.softphone.current_call_log = 'C2';
    resolve({message: {name: 'C1', reference_doctype: 'CRM Lead', reference_name: 'LEAD1'}});
    await pending;
    assert.equal(t.opened.length, 0);
    assert.equal(t.c.softphone_workdesk_request, null);
});

test('a delayed customer lookup cannot replace a workdesk the agent opened meanwhile', async () => {
    const t = setup();
    let resolve;
    const originalCall = t.ctx.frappe.call;
    t.ctx.frappe.call = request => request.method.endsWith('get_reference_context')
        ? new Promise(r => { resolve = r; }) : originalCall(request);
    const pending = t.c.open_softphone_workdesk('C1');
    await flush();
    t.c.state.active_workdesk_dialog = {id: 'OTHER'};
    resolve({message: {workdesk: {}}});
    await pending;
    assert.equal(t.opened.length, 0);
});

test('failed and timed-out lookups restore Open Workdesk for retry', async () => {
    for (const timeout of [false, true]) {
        const t = setup();
        let aborted = false;
        if (timeout) {
            const request = new Promise(() => {});
            request.abort = () => { aborted = true; };
            t.ctx.frappe.call = () => request;
            const original = t.c.browser_request_with_timeout;
            t.c.browser_request_with_timeout = request => original.call(t.c, request, 5);
        } else {
            t.ctx.frappe.call = () => Promise.reject(Error('Offline'));
        }
        await t.c.open_softphone_workdesk('C1');
        assert.equal(t.c.softphone_workdesk_request, null);
        assert.equal(t.opened.length, 0);
        assert.equal(t.messages.length, 1);
        if (timeout) assert.equal(aborted, true);
    }
});
