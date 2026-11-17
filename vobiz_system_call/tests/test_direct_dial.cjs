const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
function setup() {
    const requests = [], timers = [];
    const ctx = {frappe: {pages: {'vobiz-agent-console': {}}, show_alert() {},
        call(args) {requests.push(args); return Promise.resolve({message: {}});}}, __: x => x,
        setTimeout: fn => timers.push(fn)};
    vm.createContext(ctx); vm.runInContext(source + '\nthis.Class = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.Class.prototype);
    obj.state = {direct_dial_allowed: true, queue: [], auto_dial: {}, softphone: {config: {call_device: 'Mobile Bridge'}}};
    obj.get_softphone_tab_id = () => 'tab';
    obj.update_workdesk_primary_action = obj.render_workdesk_live_call = obj.load = obj.refresh_workdesk_live_call = () => {};
    return {obj, ctx, requests, timers};
}
const row = {direct_dial: true, phone: '9876543210', doctype: '', name: ''};

test('direct call only submits destination and own browser context', async () => {
    const t = setup();
    await t.obj.start_call_for_row(row);
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0].method, 'vobiz_click_to_call.api.call.start_direct_call');
    assert.deepEqual(JSON.parse(JSON.stringify(t.requests[0].args)), {phone_number: '9876543210', client_context: 'agent_console', tab_id: 'tab'});
});

test('direct and queue clicks cannot create overlapping requests', async () => {
    const t = setup(); let finish;
    t.ctx.frappe.call = args => {t.requests.push(args); return new Promise(resolve => {finish = resolve;});};
    const first = t.obj.start_call_for_row(row);
    await t.obj.start_call_for_row({doctype: 'Patient', name: 'PAT'});
    assert.equal(t.requests.length, 1);
    finish({message: {}}); await first;
    assert.equal(t.obj.start_call_in_flight, null);
});

test('failed start releases the button for a deliberate retry', async () => {
    const t = setup(); t.ctx.frappe.call = () => Promise.reject(Error('blocked'));
    await assert.rejects(t.obj.start_call_for_row(row), /blocked/);
    assert.equal(t.obj.direct_dial_busy(), false);
});

test('live calls and running autodial disable direct dialing', () => {
    const t = setup();
    for (const value of [{active_call: {name:'CALL',status:'Connected'}}, {auto_dial:{running:true}},
                         {softphone:{current_call_log:'CALL'}}, {workdesk_live_call:{name:'CALL',status:'Queued'}}]) {
        const previous = t.obj.state; t.obj.state = value;
        assert.equal(t.obj.direct_dial_busy(), true); t.obj.state = previous;
    }
});

test('NDR permission controls visibility and revocation closes the dialpad', () => {
    const t = setup(), states = {};
    const button = {toggleClass(name, value) {states.hidden=value; return this;}, prop(name,value) {states.disabled=value; return this;}};
    t.obj.page = {main:{find:() => button}};
    t.obj.direct_dial_dialog = {get_primary_btn:() => button, hide:() => {states.closed=true;}};
    t.obj.render_direct_dial_access(); assert.equal(states.hidden, false);
    t.obj.state.direct_dial_allowed = false; t.obj.render_direct_dial_access();
    assert.equal(states.hidden, true); assert.equal(states.closed, true); assert.equal(states.disabled,true);
});

test('standalone outgoing direct call opens disposition without creating a lead', () => {
    const t = setup(), opened = [];
    t.obj.sync_post_call_disposition = () => {};
    t.obj.is_disposition_call_current = () => true;
    t.obj.open_post_call_disposition_dialog = (...args) => opened.push(args);
    t.obj.maybe_prompt_workdesk_disposition({name:'CALL',status:'Completed',direction:'Outgoing',direct_dial:true,reference_doctype:'',reference_name:''});
    assert.equal(t.timers.length, 1); t.timers[0]();
    assert.equal(opened.length, 1); assert.equal(opened[0][1].name, '');
    assert.equal(t.requests.length, 0);
});

test('server-resolved reference and direct marker are kept for mobile call tracking', async () => {
    const t = setup();
    t.ctx.frappe.call = () => Promise.resolve({message: {call_log:'CALL',direct_dial:true,reference_doctype:'Patient',reference_name:'PAT'}});
    await t.obj.start_call_for_row(row);
    assert.equal(t.obj.state.workdesk_live_call.direct_dial, true);
    assert.equal(t.obj.state.workdesk_live_call.reference_name, 'PAT');
});
