const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');

function setup() {
  const requests = [];
  const ctx = {frappe: {pages: {'vobiz-agent-console': {}}, show_alert() {},
    call(args) {requests.push(args); return Promise.resolve({message: {}});}}, __: x => x,
    navigator: {mediaDevices: {getUserMedia: async () => ({getTracks: () => []})}}};
  vm.createContext(ctx);
  vm.runInContext(source + '\nthis.ConsoleClass = VobizAgentConsole;', ctx);
  const obj = Object.create(ctx.ConsoleClass.prototype);
  obj.state = {softphone: {registered: true, config: {call_device: 'Browser Softphone'}}};
  obj.connect_browser_softphone = () => Promise.resolve();
  obj.browser_softphone_reconnecting = () => false;
  obj.get_softphone_tab_id = () => 'owner-tab';
  obj.render_browser_softphone = obj.load = () => {};
  obj.browser_request_with_timeout = p => p;
  return {obj, ctx, requests};
}
const row = {doctype: 'CRM Lead', name: 'LEAD', phone: 'test'};

test('denied microphone prevents backend call creation', async () => {
  const t = setup();
  t.ctx.navigator.mediaDevices.getUserMedia = async () => {throw Error('NotAllowedError');};
  await assert.rejects(t.obj.start_call_for_row(row), /microphone/);
  assert.equal(t.requests.length, 0);
});

test('disconnected registration after permission check prevents dialing', async () => {
  const t = setup();
  t.obj.state.softphone.registered = false;
  await assert.rejects(t.obj.start_call_for_row(row), /reconnect/);
  assert.equal(t.requests.length, 0);
});

test('ready microphone releases its test track before creating exactly one call', async () => {
  const t = setup();
  let stopped = false;
  t.ctx.navigator.mediaDevices.getUserMedia = async () => ({getTracks: () => [{stop() {stopped = true;}}]});
  await t.obj.start_call_for_row(row);
  assert.equal(stopped, true);
  assert.equal(t.requests.length, 1);
  assert.equal(t.requests[0].method, 'vobiz_click_to_call.api.call.start_call');
});

test('only healthy media heartbeat includes the active call identity', async () => {
  const t = setup(), phone = t.obj.state.softphone;
  Object.assign(phone, {in_call: true, recovery_media_connected: true, current_call_log: 'CALL'});
  await t.obj.send_browser_window_presence(true);
  assert.equal(t.requests.at(-1).args.call_log, 'CALL');
  for (const values of [{network_issues: {audio: true}}, {pending_end_call: true},
    {recovery_verification: true}, {recovery_media_connected: false}]) {
    Object.assign(phone, {network_issues: {}, pending_end_call: false, recovery_verification: false,
      recovery_media_connected: true}, values);
    await t.obj.send_browser_window_presence(true);
    assert.equal(t.requests.at(-1).args.call_log, '');
  }
});
