// FILE: desktop-handler.js
// Purpose: Handles manual desktop-only RPC methods that should stay on the Mac bridge.
// Layer: Bridge handler
// Exports: createDesktopRequestHandler
// Depends on: none

function createDesktopRequestHandler({ desktopRefresher }) {
  return function handleDesktopRequest(rawMessage, sendResponse) {
    let parsed;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (method !== "desktop/refreshApp") {
      return false;
    }

    const id = parsed.id;
    const params = parsed.params || {};
    const threadId = typeof params?.threadId === "string" && params.threadId.trim()
      ? params.threadId.trim()
      : "";

    Promise.resolve()
      .then(() => desktopRefresher.runManualRefresh({ threadId }))
      .then((result) => {
        if (id == null) {
          return;
        }

        sendResponse(JSON.stringify({
          id,
          result,
        }));
      })
      .catch((error) => {
        if (id == null) {
          return;
        }

        sendResponse(JSON.stringify({
          id,
          error: {
            code: -32000,
            message: error?.message || "Desktop refresh failed.",
            data: {
              errorCode: "desktop_refresh_failed",
            },
          },
        }));
      });

    return true;
  };
}

module.exports = {
  createDesktopRequestHandler,
};
