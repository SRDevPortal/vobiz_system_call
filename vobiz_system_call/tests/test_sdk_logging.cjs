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
