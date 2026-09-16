const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const row = {doctype: 'CRM Lead', name: 'LEAD1', phone: '+123', phone_field: 'phone'};
const flush = () => new Promise(setImmediate);
function setup() {
    const requests = [], cancels = [], renders = [];
    let resolve, reject;
    const ctx = {console, window: {}, __: x => x, setTimeout, clearTimeout,
        frappe: {pages: {'vobiz-agent-console': {}}, show_alert() {},
            call(args) {requests.push(args); return new Promise((a,b) => {resolve=a;reject=b;});}}};
    vm.createContext(ctx); vm.runInContext(source + '\nthis.C = VobizAgentConsole;', ctx);
    const c = Object.create(ctx.C.prototype);
    c.state = {softphone: {config: {call_device: 'Phone'}}, active_call: {}, active_workdesk_row: row};
    c.update_workdesk_primary_action = () => renders.push(Boolean(c.start_call_in_flight));
    c.get_softphone_tab_id = () => 'TAB';
    c.render_workdesk_live_call = c.refresh_workdesk_live_call = c.load = () => {};
    c.cancel_call_log = id => {cancels.push(id); return Promise.resolve();};
    return {c, ctx, requests, cancels, renders, resolve: value => resolve(value), reject: value => reject(value)};
}
test('rapid Starts send one request across async preflight and restore controls', async () => {
    const t = setup();
    const one = t.c.start_call_for_row(row), two = t.c.start_call_for_row(row);
    assert.equal(await two, null);
    assert.equal(t.renders[0], true, 'disable synchronously');
    await flush();
    assert.equal(t.requests.length, 1);
    assert.equal(await t.c.start_call_for_row(row), null);
    t.resolve({message: {call_log: 'C1', status: 'Queued'}});
    assert.equal((await one).call_log, 'C1');
    assert.equal(t.c.start_call_in_flight, null);
    assert.equal(t.renders.at(-1), false);
});
test('failed start releases the guard so an intentional retry works', async () => {
    const t = setup();
    const one = t.c.start_call_for_row(row);
    const failed = assert.rejects(one, /network/);
    await flush(); t.reject(Error('network')); await failed;
    assert.equal(t.c.start_call_in_flight, null);
    const retry = t.c.start_call_for_row(row); await flush();
    assert.equal(t.requests.length, 2);
    t.resolve({message: {}}); await retry;
});
test('patient phone selection stays inside the same guard and cancel releases it', async () => {
    const t = setup(); let finish;
    t.c.select_patient_phone = () => new Promise(r => {finish=r;});
    const p = t.c.start_call_for_row({...row, doctype: 'Patient'});
    await flush();
    t.resolve({message: [{number:'1'}, {number:'2'}]}); await flush();
    assert.equal(await t.c.start_call_for_row(row), null);
    finish(null); await p;
    assert.equal(t.c.start_call_in_flight, null);
});
test('Stop intent cannot redial after that call has ended', async () => {
    const t = setup();
    t.c.state.active_call = {last_call: {name:'OLD', status:'Completed', reference_doctype:row.doctype, reference_name:row.name}};
    await t.c.handle_workdesk_primary_action(row, {call_log:'OLD'});
    assert.equal(t.requests.length, 0); assert.equal(t.cancels.length, 0);
});
test('Stop intent cannot cancel a replacement call for the same customer', async () => {
    const t = setup();
    t.c.state.active_call = {name:'NEW', status:'Connected', reference_doctype:row.doctype, reference_name:row.name};
    await t.c.handle_workdesk_primary_action(row, {call_log:'OLD'});
    assert.equal(t.requests.length, 0); assert.equal(t.cancels.length, 0);
    await t.c.handle_workdesk_primary_action(row, {call_log:'NEW'});
    assert.deepEqual(t.cancels, ['NEW']);
});
test('Start intent cannot hang up an incoming call that arrived during the gesture', async () => {
    const t = setup();
    t.c.state.active_call = {name:'INCOMING', status:'Ringing', reference_doctype:row.doctype, reference_name:row.name};
    await t.c.handle_workdesk_primary_action(row, {call_log:''});
    assert.equal(t.requests.length, 0); assert.equal(t.cancels.length, 0);
});
test('browser microphone preflight is guarded and SDK dialing occurs once', async () => {
    const t = setup(); let microphoneReady, dialed = 0, connected = 0;
    Object.assign(t.c.state.softphone, {config:{call_device:'Browser Softphone'}, registered:true});
    t.c.connect_browser_softphone = () => {connected++; return Promise.resolve();};
    t.c.check_browser_microphone = () => new Promise(r => {microphoneReady=r;});
    t.c.browser_softphone_reconnecting = () => false;
    t.c.start_browser_softphone_call = () => {dialed++; return Promise.resolve();};
    const first = t.c.start_call_for_row(row);
    await flush();
    assert.equal(await t.c.start_call_for_row(row), null);
    assert.equal(connected, 1); assert.equal(t.requests.length, 0);
    microphoneReady(true); await flush();
    assert.equal(t.requests.length, 1);
    t.resolve({message:{browser_softphone:true,call_log:'C1',status:'Initiated'}});
    await first;
    assert.equal(dialed, 1); assert.equal(t.c.start_call_in_flight, null);
});
test('another customer cannot receive the first call result while Start is pending', async () => {
    const t = setup();
    const first = t.c.start_call_for_row(row);
    assert.equal(await t.c.start_call_for_row({...row,name:'LEAD2'}), null);
    await flush();
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0].args.reference_name, 'LEAD1');
    t.resolve({message:{call_log:'C1'}}); await first;
});
test('double submit of Patient number selection starts only the selected number once', async () => {
    const t = setup(); let dialog;
    t.ctx.frappe.ui = {Dialog: class {
        constructor(options) {this.options=options;dialog=this;}
        $wrapper = {on() {}};
        show() {}
        hide() {}
    }};
    const patient = {...row,doctype:'Patient'};
    const first = t.c.start_call_for_row(patient);
    await flush();
    t.resolve({message:[{label:'Mobile',fieldname:'mobile_no',number:'123'}, {label:'Phone',fieldname:'phone',number:'456'}]});
    await flush();
    const values = {patient_number:'Phone: 456'};
    dialog.options.primary_action(values);
    dialog.options.primary_action(values);
    await flush();
    assert.equal(t.requests.length, 2, 'one choice lookup plus one start');
    assert.equal(t.requests[1].args.phone_number, '456');
    t.resolve({message:{call_log:'C1'}}); await first;
    assert.equal(t.c.start_call_in_flight, null);
});
