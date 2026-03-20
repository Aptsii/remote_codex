// FILE: desktop-handler.test.js
// Purpose: Verifies manual desktop refresh RPC handling stays local to the bridge.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/desktop-handler

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDesktopRequestHandler } = require("../src/desktop-handler");

test("desktop/refreshApp forwards a manual relaunch request to the desktop refresher", async () => {
  let receivedThreadId = null;
  const responses = [];
  const handleDesktopRequest = createDesktopRequestHandler({
    desktopRefresher: {
      async runManualRefresh({ threadId }) {
        receivedThreadId = threadId;
        return {
          threadId,
          targetUrl: `codex://threads/${threadId}`,
          mode: "relaunch",
        };
      },
    },
  });

  const handled = handleDesktopRequest(JSON.stringify({
    id: "desktop-refresh-1",
    method: "desktop/refreshApp",
    params: {
      threadId: "thread-bridge-refresh",
    },
  }), (response) => {
    responses.push(JSON.parse(response));
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(handled, true);
  assert.equal(receivedThreadId, "thread-bridge-refresh");
  assert.deepEqual(responses, [{
    id: "desktop-refresh-1",
    result: {
      threadId: "thread-bridge-refresh",
      targetUrl: "codex://threads/thread-bridge-refresh",
      mode: "relaunch",
    },
  }]);
});

test("non-desktop methods fall through without sending a response", async () => {
  const responses = [];
  const handleDesktopRequest = createDesktopRequestHandler({
    desktopRefresher: {
      async runManualRefresh() {
        throw new Error("should not run");
      },
    },
  });

  const handled = handleDesktopRequest(JSON.stringify({
    id: "desktop-refresh-2",
    method: "thread/read",
    params: {},
  }), (response) => {
    responses.push(response);
  });

  assert.equal(handled, false);
  assert.deepEqual(responses, []);
});
