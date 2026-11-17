// Run with node. Exercise the real console methods without media/provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let now = 100000;
let handler;
const requests = [];
const sandbox = {
    frappe: {pages: {'vobiz-agent-console': {}}, call(args) {
        requests.push(args);
        return handler(args);
    }},
    document: {addEventListener() {}}, window: {navigator: {onLine: true}},
    __: value => value, console, Date: {now: () => now}, Math,
};
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
vm.runInNewContext(source + '; globalThis.Console = VobizAgentConsole;', sandbox);
function agent() {
    const c = Object.create(sandbox.Console.prototype);
    c.state = {softphone: {registered: true, in_call: true, current_call_log: 'CALL',
        recovery_media_connected: true, network_issues: {}, client: {client: {}}}};
    c.get_softphone_tab_id = () => 'owner-window';
    c.prepare_softphone_window = () => Promise.resolve();
    c.browser_request_with_timeout = promise => promise;
    c.mark_softphone_other_window = () => { c.blocked = true; };
    c.release_softphone_for_switch = async () => { c.released = true; };
    c.set_browser_network_issue = () => {};
    c.refresh_browser_softphone_call = async () => { c.refreshed = true; };
    c.report_browser_diagnostic = () => { c.diagnostic = true; };
    return c;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const busy = () => Promise.reject({status: 503,
    responseJSON: {message: {registered: false, ownership: 'retry', retry_after_ms: 2000}}});
const ok = () => Promise.resolve({message: {registered: true, ownership: 'granted'}});
(async () => {
    let c = agent();
    let resolve;
    handler = () => new Promise(r => { resolve = r; });
    let first = c.send_browser_window_presence(true);
    let second = c.send_browser_window_presence(true);
    assert.equal(first, second, 'Overlapping heartbeats share one request');
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].args.call_log, 'CALL');
    resolve({message: {registered: true, ownership: 'granted'}});
    await first;
    assert.equal(c.browser_presence_request, null);

    requests.length = 0;
    handler = busy;
    await assert.rejects(c.send_browser_window_presence(true), e => e.presence_busy === true);
    assert.equal(c.blocked, undefined);
    assert.equal(c.released, undefined);
    assert.equal(c.state.softphone.current_call_log, 'CALL');
    assert.equal(c.state.softphone.registered, true);
    assert.ok(c.browser_presence_retry_at >= now + 2000 && c.browser_presence_retry_at < now + 3000);
    await assert.rejects(c.send_browser_window_presence(true), e => e.presence_busy === true);
    assert.equal(requests.length, 1, 'Cooldown prevents another server request');
    now += 3000;
    handler = ok;
    await c.send_browser_window_presence(true);
    assert.equal(c.browser_presence_retry_at, 0);

    // A busy claim cannot continue into SDK login as though ownership was granted.
    c = agent();
    handler = busy;
    let started = false;
    await assert.rejects(c.send_browser_window_presence(true, true).then(() => { started = true; }),
        e => e.presence_busy === true);
    assert.equal(started, false);
    assert.equal(c.blocked, undefined);

    // A different operation waits; it must not reuse the preceding registration.
    c = agent();
    requests.length = 0;
    handler = () => new Promise(r => { resolve = r; });
    first = c.send_browser_window_presence(true);
    const logout = c.send_browser_window_presence(false);
    await settle();
    assert.equal(requests.length, 1);
    handler = () => Promise.resolve({message: {registered: false}});
    resolve({message: {registered: true, ownership: 'granted'}});
    await Promise.all([first, logout]);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].args.registered, 0);
    assert.equal(requests[1].args.call_log, '');

    // Network polling retries contention, without spawning diagnostics/recovery.
    c = agent();
    c.browser_presence_checked_at = 0;
    requests.length = 0;
    handler = busy;
    await c.check_browser_network(c.state.softphone.client, true);
    assert.equal(c.diagnostic, undefined);
    assert.equal(c.refreshed, undefined);
    await c.check_browser_network(c.state.softphone.client, true);
    assert.equal(requests.length, 1);
    now += 3000;
    handler = ok;
    await c.check_browser_network(c.state.softphone.client);
    assert.equal(requests.length, 2, 'Busy retry does not wait for the normal 25-second interval');
    assert.equal(c.refreshed, true);

    c = agent();
    handler = () => Promise.resolve({message: {registered: false, ownership: 'other_window'}});
    await assert.rejects(c.send_browser_window_presence(true), e => e.softphone_ownership === true);
    assert.equal(c.blocked, true, 'Real ownership rejection is still enforced');
    assert.equal(c.browser_presence_request, null);

    c = agent();
    handler = () => Promise.reject(new Error('network failure'));
    await assert.rejects(c.send_browser_window_presence(true), /network failure/);
    assert.equal(c.browser_presence_request, null, 'A failed request must not permanently block heartbeats');
    handler = ok;
    await c.send_browser_window_presence(true);
    console.log('Browser presence contention checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
