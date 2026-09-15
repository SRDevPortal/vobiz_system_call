const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const requests = [], errors = [];
  const ctx = {frappe: {pages: {'vobiz-agent-console': {}},
    call: args => { requests.push(args); return Promise.resolve({message: {name: 'C1', status: 'Completed'}}); },
    msgprint: message => errors.push(message)}, __: s => s, console, window: {}};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8') + ';this.Console = VobizAgentConsole;', ctx);
  const c = Object.create(ctx.Console.prototype);
  c.state = {active_call: {name: 'C1', status: 'Initiated'}, softphone: {}};
  c.browser_request_with_timeout = request => Promise.resolve(request);
  c.render_header_active_call = () => {};
  c.reconcile_browser_softphone_call = () => {};
  c.render_active_call = () => {};
  c.load = () => {};
  return {c, ctx, requests, errors};
}

test('Complete Call updates the selected record and ignores a repeated click', async () => {
  const t = setup();
  const request = t.c.complete_header_active_call();
  t.c.complete_header_active_call();
  assert.equal(t.c.state.completing_call_log, 'C1');
  await request;
  assert.equal(t.requests.length, 1);
  assert.equal(t.requests[0].method, 'vobiz_system_call.api.call.complete_call_log');
  assert.equal(t.requests[0].args.call_log, 'C1');
  assert.equal(t.c.state.active_call.last_call.status, 'Completed');
  assert.equal(t.c.state.completing_call_log, '');
});

test('a delayed manual completion cannot clear a newer active call', async () => {
  const t = setup(); let resolve;
  t.ctx.frappe.call = () => new Promise(r => { resolve = r; });
  const request = t.c.complete_header_active_call();
  await Promise.resolve();
  t.c.state.active_call = {name: 'C2', status: 'Connected'};
  resolve({message: {name: 'C1', status: 'Completed'}});
  await request;
  assert.equal(t.c.state.active_call.name, 'C2');
  assert.equal(t.c.state.active_call.status, 'Connected');
});

test('failure or a mismatched reply leaves the current call intact and permits retry', async () => {
  for (const mode of ['reject', 'throw', 'wrong-call', 'not-terminal']) {
    const t = setup();
    t.ctx.frappe.call = () => {
      if (mode === 'throw') throw Error('request failed');
      if (mode === 'reject') return Promise.reject(Error('request failed'));
      return Promise.resolve({message: {name: mode === 'wrong-call' ? 'C2' : 'C1', status: mode === 'not-terminal' ? 'Connected' : 'Completed'}});
    };
    await t.c.complete_header_active_call();
    assert.equal(t.c.state.active_call.name, 'C1');
    assert.equal(t.c.state.active_call.status, 'Initiated');
    assert.equal(t.c.state.completing_call_log, '');
    assert.equal(t.errors.length, 1);
  }
});

test('an idle or already finished call sends no manual completion request', async () => {
  for (const active of [{}, {name: 'C1', status: 'Completed'}]) {
    const t = setup(); t.c.state.active_call = active;
    await t.c.complete_header_active_call();
    assert.equal(t.requests.length, 0);
  }
});
