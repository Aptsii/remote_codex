// FILE: local-relay-server.js
// Purpose: Starts an in-process local relay so `remodex up` works without any hosted service.
// Layer: CLI helper
// Exports: startLocalRelayServer
// Depends on: http, ws, ./relay-core, ./relay-config

const http = require("http");
const { WebSocketServer } = require("ws");
const { getRelayStats, setupRelay } = require("./relay-core");
const { buildRelayBaseUrl } = require("./relay-config");

const DEFAULT_RELAY_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

function startLocalRelayServer({
  bindHost,
  port,
  advertisedHost,
  logPrefix = "[remodex]",
  allowPortReuse = true,
  maxPayloadBytes = DEFAULT_RELAY_MAX_PAYLOAD_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        const body = JSON.stringify({
          ok: true,
          ...getRelayStats(),
        });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body, "utf8"),
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

    const wss = new WebSocketServer({
      server,
      maxPayload: maxPayloadBytes,
    });
    setupRelay(wss);

    let settled = false;
    const relayUrl = buildRelayBaseUrl({ host: advertisedHost, port });

    server.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;

      wss.close();

      if (allowPortReuse && error?.code === "EADDRINUSE") {
        resolve({
          relayUrl,
          reusedExisting: true,
          async close() {},
        });
        return;
      }

      reject(error);
    });

    server.listen(port, bindHost, () => {
      if (settled) {
        return;
      }
      settled = true;

      const address = server.address();
      const actualPort = typeof address === "object" && address?.port ? address.port : port;
      const actualRelayUrl = buildRelayBaseUrl({ host: advertisedHost, port: actualPort });

      resolve({
        relayUrl: actualRelayUrl,
        reusedExisting: false,
        async close() {
          await new Promise((closeResolve) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(() => {
              server.close(() => closeResolve());
              server.closeAllConnections?.();
            });
          });
        },
      });
    });
  }).catch((error) => {
    error.message = `${logPrefix} Failed to start local relay: ${error.message}`;
    throw error;
  });
}

module.exports = {
  startLocalRelayServer,
};
