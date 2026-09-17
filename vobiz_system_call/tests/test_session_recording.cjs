const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
function setup() {
    const events = {};
    const context = {frappe: {pages: {'vobiz-agent-console': {}}}, __: x => x,
        console, Date, setTimeout, clearTimeout, setInterval, clearInterval, window: {}};
    vm.createContext(context);
    vm.runInContext(source + '\nthis.ConsoleClass = VobizAgentConsole;', context);
    const obj = Object.create(context.ConsoleClass.prototype);
    const client = {client: {on: (name, fn) => {events[name] = fn;}}};
    obj.state = {softphone: {client, current_call_log: 'C1', provider_session_recording: true, registered: true},
        active_call: {name: 'C1', status: 'Ringing'}, workdesk_live_call: {name: 'C1', status: 'Ringing'}};
    for (const name of ['render_browser_softphone', 'render_workdesk_live_call', 'attach_browser_softphone_audio', 'load']) obj[name] = () => {};
    obj.sync_browser_softphone_event = () => Promise.resolve();
    obj.bind_browser_softphone_events(client);
    return {obj, events, s: obj.state.softphone};
}
test('recording opening the browser audio does not report customer connected', () => {
    const {obj, events, s} = setup();
    events.onCallAnswered({});
    assert.equal(s.status, 'Connecting customer');
    assert.equal(s.incoming_answered, false);
    assert.equal(obj.state.workdesk_live_call.status, 'Ringing');
});
test('the matching provider answer changes session recording UI to In Call', () => {
    const {obj, events, s} = setup();
    events.onCallAnswered({});
    obj.reconcile_browser_softphone_call({name: 'C1', status: 'Connected'});
    assert.equal(s.status, 'In Call');
    assert.equal(s.incoming_answered, true);
});
test('an older provider answer cannot change a newer call', () => {
    const {obj, events, s} = setup();
    events.onCallAnswered({});
    obj.reconcile_browser_softphone_call({name: 'C0', status: 'Connected'});
    assert.equal(s.status, 'Connecting customer');
    assert.equal(s.incoming_answered, false);
});
test('late browser answer does not undo provider-confirmed customer answer', () => {
    const {obj, events, s} = setup();
    obj.reconcile_browser_softphone_call({name: 'C1', status: 'Connected'});
    events.onCallAnswered({});
    assert.equal(s.status, 'In Call');
    assert.equal(s.incoming_answered, true);
});
test('legacy and incoming browser pickup still confirms audio normally', () => {
    const {events, s} = setup();
    s.provider_session_recording = false;
    events.onCallAnswered({});
    assert.equal(s.status, 'In Call');
    assert.equal(s.incoming_answered, true);
});
