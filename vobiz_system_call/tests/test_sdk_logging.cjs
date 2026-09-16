const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../public/vendor/vobiz-webrtc-sdk-1.0.3/vobiz-webrtc-sdk.min.js"), "utf8");
const start = source.indexOf("this._sendBatchedLogsToServer=");
const end = source.indexOf(",this.send=n=>", start);
assert.ok(start >= 0 && end > start);
for (const jwt of [false, true]) {
  test(`empty log URL never sends diagnostics to Desk (JWT=${jwt})`, async () => {
    let uploads = 0;
    const context = {s: {getSDKVersion: () => ({version: "1.0.3"}), getOS: () => "test"},
      i: {LOG_COLLECTION: "", LOG_COLLECTION_JWT: ""}, navigator: {onLine: true},
      fetch: () => { uploads++; throw new Error("Unexpected upload"); }};
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    const result = await context._sendBatchedLogsToServer({userName: "test", isAccessToken: jwt}, {}, [["diagnostic"]], 0);
    assert.equal(uploads, 0);
    assert.equal(result, "log upload disabled: no endpoint");
  });
}

function logStore(storage) {
  const begin = source.indexOf('class t{constructor(){this.TAG="VobizLogStorage"');
  const finish = source.indexOf('e.default=t,t.instance=null', begin);
  assert.ok(begin >= 0 && finish > begin);
  const context = {window: {localStorage: storage}};
  vm.createContext(context);
  vm.runInContext(source.slice(begin, finish) + ';this.store = new t();', context);
  return context.store;
}

test('SDK diagnostic history stays bounded and preserves unrelated storage', () => {
  const values = new Map([['desk-session', 'keep']]);
  const store = logStore({getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k)});
  for (let i = 0; i < 100; i++) store.setData('time', 'info', 'x'.repeat(2000));
  assert.equal(JSON.parse(values.get('VobizLogStorage')).length, 65536);
  assert.equal(values.get('desk-session'), 'keep');
});

test('quota-full and blocked storage never throw into call handling', () => {
  let removals = [];
  const store = logStore({getItem() {throw Error('SecurityError');},
    setItem() {throw Error('QuotaExceededError');}, removeItem(k) {removals.push(k);}});
  assert.doesNotThrow(() => store.setData('time', 'info', 'call event'));
  assert.deepEqual(removals, ['VobizLogStorage']);
  assert.equal(store.getData(), '');
});

test('invalid previous log JSON is replaced by a valid bounded entry', () => {
  let value = '{broken-json';
  const store = logStore({getItem: () => value, setItem: (k, v) => {value = v;}});
  store.setData('time', 'info', 'new-event');
  assert.match(JSON.parse(value), /new-event/);
});
