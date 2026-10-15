const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const sdk = fs.readFileSync(path.join(__dirname, '../public/vendor/vobiz-webrtc-sdk-1.0.3/vobiz-webrtc-sdk.min.js'), 'utf8');
const listeners = new Map();
const ctx = {frappe: {pages: {'vobiz-agent-console': {}}}, __: s => s,
    document: {addEventListener() {}}, window: {
        addEventListener(type, handler) { assert.notEqual(type, 'unload'); listeners.set(type, handler); },
        removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); }
    }, console};
vm.createContext(ctx);
vm.runInContext(source + ';this.Console = VobizAgentConsole;', ctx);
const agent = Object.create(ctx.Console.prototype);
let hungup = 0, stopped = 0;
agent.state = {softphone: {client: {client: {getCallUUID() {return '';}, hangup() {hungup++;}}}}};
agent.stop_browser_softphone_audio = () => {stopped++;};
agent.sync_browser_close_protection();
assert.equal(listeners.size, 0, 'Idle registration does not warn');
agent.state.softphone.current_call_log = 'CALL-1';
agent.sync_browser_close_protection();
const guard = listeners.get('beforeunload');
assert.equal(typeof guard, 'function');
agent.sync_browser_close_protection();
assert.equal(listeners.get('beforeunload'), guard, 'No duplicate close handlers');
let prevented = false;
const event = {preventDefault() {prevented = true;}};
guard(event);
assert(prevented); assert.equal(event.returnValue, true);
assert.equal(hungup, 0, 'Close warning must never hang up a call');
assert.equal(stopped, 0, 'Canceling browser close must preserve media and timers');
agent.cleanup_browser_page_departure();
assert.equal(hungup, 1, 'Actual page departure cleans up browser leg');
assert.equal(stopped, 1); assert(!listeners.has('beforeunload'));
agent.state.softphone.current_call_log = '';
agent.sync_browser_close_protection();
assert.equal(listeners.size, 0);
for (const field of ['in_call', 'incoming_pending', 'pending_end_call']) {
    agent.state.softphone[field] = true;
    agent.sync_browser_close_protection(); assert(listeners.has('beforeunload'), field);
    agent.state.softphone[field] = false;
    agent.sync_browser_close_protection(); assert(!listeners.has('beforeunload'), field);
}
// Execute the bundled SDK option parser and its lifecycle functions themselves.
const optionsEnd = sdk.indexOf('return c}},function', sdk.indexOf('case"managePageLifecycle"'));
const optionsStart = sdk.lastIndexOf('e.default=function(n){', optionsEnd);
assert(optionsStart > 0 && optionsEnd > optionsStart);
const sdkContext = {e: {}, c: {managePageLifecycle: true}, l: (name, value) => typeof value === 'boolean',
    window: new Proxy({}, {set(target, key, value) {
        if (key === 'onunload') throw new Error('Blocked unload registration');
        target[key] = value; return true;
    }})};
vm.createContext(sdkContext);
vm.runInContext(sdk.slice(optionsStart, optionsEnd + 'return c}'.length), sdkContext);
const options = sdkContext.e.default({managePageLifecycle: false});
assert.equal(options.managePageLifecycle, false, 'SDK must retain the new opt-out option');
let start = sdk.indexOf('e.addCloseProtectionListeners=function()');
let end = sdk.indexOf(';const g=', start);
assert(start > 0 && end > start);
vm.runInContext(sdk.slice(start, end), sdkContext);
assert.doesNotThrow(() => sdkContext.e.addCloseProtectionListeners.call({options}));
start = sdk.indexOf('v=function(){!1!==this.options.managePageLifecycle');
end = sdk.indexOf(',y=function', start);
assert(start > 0 && end > start);
vm.runInContext(sdk.slice(start, end), sdkContext);
assert.doesNotThrow(() => sdkContext.v.call({options, incomingInvites: new Map()}));
assert(!('onbeforeunload' in sdkContext.window), 'SDK must not overwrite app-owned warning');
console.log('Close protection passed: idle/active/incoming/pending states, canceled close, pagehide cleanup, SDK option parser and unload-free cleanup.');
