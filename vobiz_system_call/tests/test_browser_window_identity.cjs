const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const asset = fs.readFileSync(path.join(__dirname, '../public/js/vobiz_system_call.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../vobiz_system_call/page/vobiz_agent_console/vobiz_agent_console.js'), 'utf8');
const flush = () => new Promise(setImmediate);
let sequence = 0;

function locks() {
    const held = new Set();
    return {request(name, options, callback) {
        assert.equal(options.ifAvailable, true);
        return Promise.resolve().then(async () => {
            if (held.has(name)) return callback(null);
            held.add(name);
            try {return await callback({name});} finally {held.delete(name);}
        });
    }};
}

function page({storage = new Map(), lockManager = locks(), type = 'navigate', user = 'agent@example.test', blockedStorage = false} = {}) {
    const listeners = {};
    const ctx = {vobiz_system_call: {}, frappe: {provide() {}, session: {user}, pages: {'vobiz-agent-console': {}}},
        __: x => x, console, window: {
            crypto: {randomUUID: () => `document-${String(++sequence).padStart(6, '0')}`},
            navigator: {locks: lockManager}, performance: {getEntriesByType: () => [{type}]},
            addEventListener(name, cb) {(listeners[name] ||= []).push(cb);},
            sessionStorage: {
                getItem(k) {if (blockedStorage) throw Error('blocked'); return storage.get(k) || null;},
                setItem(k, v) {if (blockedStorage) throw Error('blocked'); storage.set(k, v);},
                removeItem(k) {if (blockedStorage) throw Error('blocked'); storage.delete(k);}
            }
        }};
    vm.createContext(ctx);
    vm.runInContext(asset, ctx);
    vm.runInContext(source + '\nthis.Class = VobizAgentConsole;', ctx);
    const obj = Object.create(ctx.Class.prototype);
    obj.state = {softphone: {}, active_call: {}, auto_dial: {}};
    obj.browser_request_with_timeout = p => p;
    return {obj, ctx, storage, id: () => obj.get_softphone_tab_id(),
        ready: () => obj.prepare_softphone_window(),
        emit(event, data = {}) {for (const cb of listeners[event] || []) cb(data);},
        async close() {if (obj.softphone_window?.release) obj.softphone_window.release(); await flush();}
    };
}

test('the same window keeps its ID over repeated reloads', async () => {
    const manager = locks();
    let current = page({lockManager: manager});
    const id = await current.ready();
    for (let n = 0; n < 3; n++) {
        await current.close();
        current = page({storage: current.storage, lockManager: manager, type: 'reload'});
        assert.equal(await current.ready(), id);
    }
    await current.close();
});

test('duplicated sessionStorage gets a distinct ID without changing the original', async () => {
    const manager = locks();
    const first = page({lockManager: manager});
    const firstID = await first.ready();
    const duplicate = page({storage: new Map(first.storage), lockManager: manager, type: 'back_forward'});
    const duplicateID = await duplicate.ready();
    assert.notEqual(duplicateID, firstID);
    assert.equal(first.id(), firstID);
    await duplicate.close();
    const refreshed = page({storage: duplicate.storage, lockManager: manager, type: 'reload'});
    assert.equal(await refreshed.ready(), duplicateID);
    await first.close(); await refreshed.close();
});

test('even a duplicate reported as reload cannot claim another live document ID', async () => {
    const manager = locks();
    const first = page({lockManager: manager});
    await first.ready();
    const duplicate = page({storage: new Map(first.storage), lockManager: manager, type: 'reload'});
    assert.notEqual(await duplicate.ready(), first.id());
    await first.close(); await duplicate.close();
});

test('upgrading a registered legacy window on reload keeps its attendance-based owner ID', async () => {
    const current = page({type: 'reload', storage: new Map([['vobiz_agent_console_tab_id', 'legacy-window-123']])});
    assert.equal(await current.ready(), 'legacy-window-123');
    assert.equal(current.storage.get('vobiz_agent_console_tab_id'), 'legacy-window-123');
    await current.close();
});

test('a new or duplicated page does not inherit the legacy attendance identity', async () => {
    const current = page({type: 'back_forward', storage: new Map([['vobiz_agent_console_tab_id', 'legacy-window-123']])});
    assert.notEqual(await current.ready(), 'legacy-window-123');
    await current.close();
});

test('repeated controller/asset initialization shares the same document identity', async () => {
    const current = page();
    const id = await current.ready();
    vm.runInContext(asset, current.ctx);
    const other = Object.create(current.ctx.Class.prototype);
    assert.equal(await other.prepare_softphone_window(), id);
    await current.close();
});

test('missing storage still permits one safe in-memory document identity', async () => {
    const current = page({blockedStorage: true});
    const id = await current.ready();
    assert.equal(current.id(), id);
    await current.close();
});

test('without Web Locks an exiting document may resume but a live copy cannot', async () => {
    const first = page({lockManager: null});
    const id = await first.ready();
    const copy = page({storage: new Map(first.storage), lockManager: null, type: 'reload'});
    assert.notEqual(await copy.ready(), id);
    first.emit('pagehide', {persisted: false});
    const reload = page({storage: first.storage, lockManager: null, type: 'reload'});
    assert.equal(await reload.ready(), id);
    assert.equal(reload.storage.has('vobiz-softphone-window-id:agent@example.test:reload'), false);
});

test('presence waits for the document lock before sending the final window ID', async () => {
    const current = page();
    const calls = [];
    current.ctx.frappe.call = args => {calls.push(args); return Promise.resolve({message: {registered:true}});};
    const pending = current.obj.send_browser_presence();
    assert.equal(calls.length, 0);
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.tab_id, current.id());
    assert.ok(current.id());
    await current.close();
});

test('a window lock error does not send an unverified ID to the server', async () => {
    const current = page({lockManager:{request: () => Promise.reject(Error('Lock denied'))}});
    let calls = 0;
    current.ctx.frappe.call = () => {calls++;};
    await assert.rejects(current.obj.send_browser_presence(), /Lock denied/);
    assert.equal(calls, 0);
});

test('idle recovery is opt-in for connection startup, not background heartbeats', async () => {
    const current = page();
    const calls = [];
    current.ctx.frappe.call = args => {calls.push(args); return Promise.resolve({message: {registered:true}});};
    await current.obj.send_browser_presence(true, true);
    await current.obj.send_browser_presence();
    await current.obj.send_browser_presence(false);
    assert.deepEqual(calls.map(c => c.args.claim_idle), [1, 0, 0]);
    await current.close();
});
