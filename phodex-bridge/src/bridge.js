// FILE: bridge.js
// Purpose: Runs Codex locally, bridges relay traffic, and coordinates desktop refreshes for Codex.app.
// Layer: CLI service
// Exports: startBridge
// Depends on: ws, uuid, ./qr, ./codex-desktop-refresher, ./codex-transport, ./rollout-watch

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const {
  CodexDesktopRefresher,
  readBridgeConfig,
} = require("./codex-desktop-refresher");
const { createCodexTransport } = require("./codex-transport");
const { createThreadRolloutActivityWatcher } = require("./rollout-watch");
const { DEFAULT_RELAY_FALLBACK_HOST } = require("./relay-config");
const { startLocalRelayServer } = require("./local-relay-server");
const { printQR } = require("./qr");
const { rememberActiveThread } = require("./session-state");
const { createDesktopRequestHandler } = require("./desktop-handler");
const { handleGitRequest } = require("./git-handler");
const { handleThreadContextRequest } = require("./thread-context-handler");
const { handleThreadTailRequest } = require("./thread-tail-handler");
const { enrichThreadListResponse } = require("./thread-list-enricher");
const { handleWorkspaceRequest } = require("./workspace-handler");
const { loadOrCreateBridgeDeviceState } = require("./secure-device-state");
const { createBridgeSecureTransport } = require("./secure-transport");

function startBridge() {
  const config = readBridgeConfig();
  let relayServer = null;
  const sessionId = uuidv4();
  const deviceState = loadOrCreateBridgeDeviceState();
  const desktopRefresher = new CodexDesktopRefresher({
    enabled: config.refreshEnabled,
    debounceMs: config.refreshDebounceMs,
    refreshCommand: config.refreshCommand,
    refreshMode: config.refreshMode,
    bundleId: config.codexBundleId,
    appPath: config.codexAppPath,
  });
  const handleDesktopRequest = createDesktopRequestHandler({ desktopRefresher });

  // Keep the local Codex runtime alive across transient relay disconnects.
  let socket = null;
  let isShuttingDown = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let lastConnectionStatus = null;
  let codexHandshakeState = config.codexEndpoint ? "warm" : "cold";
  const forwardedInitializeRequestIds = new Set();
  let relayBaseUrl = "";
  let relaySessionUrl = "";
  let secureTransport = null;
  let contextUsageWatcher = null;
  let watchedContextUsageKey = null;
  const pendingCodexRequests = new Map();

  const codex = createCodexTransport({
    endpoint: config.codexEndpoint,
    env: process.env,
    logPrefix: "[remodex]",
  });

  codex.onError((error) => {
    closeRelayServer();
    if (config.codexEndpoint) {
      console.error(`[remodex] Failed to connect to Codex endpoint: ${config.codexEndpoint}`);
    } else {
      console.error("[remodex] Failed to start `codex app-server`.");
      console.error(`[remodex] Launch command: ${codex.describe()}`);
      console.error("[remodex] Make sure the Codex CLI is installed and that the launcher works on this OS.");
    }
    console.error(error.message);
    process.exit(1);
  });

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Keeps npm start output compact by emitting only high-signal connection states.
  function logConnectionStatus(status) {
    if (lastConnectionStatus === status) {
      return;
    }

    lastConnectionStatus = status;
    console.log(`[remodex] ${status}`);
  }

  // Retries the relay socket while preserving the active Codex process and session id.
  function scheduleRelayReconnect(closeCode) {
    if (isShuttingDown) {
      return;
    }

    if (closeCode === 4000 || closeCode === 4001) {
      logConnectionStatus("disconnected");
      shutdown(codex, () => socket, () => {
        isShuttingDown = true;
        clearReconnectTimer();
      });
      return;
    }

    if (reconnectTimer) {
      return;
    }

    reconnectAttempt += 1;
    const delayMs = Math.min(1_000 * reconnectAttempt, 5_000);
    logConnectionStatus("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRelay();
    }, delayMs);
  }

  function connectRelay() {
    if (isShuttingDown) {
      return;
    }

    logConnectionStatus("connecting");
    const nextSocket = new WebSocket(relaySessionUrl, {
      headers: { "x-role": "mac" },
    });
    socket = nextSocket;

    nextSocket.on("open", () => {
      clearReconnectTimer();
      reconnectAttempt = 0;
      logConnectionStatus("connected");
      secureTransport.bindLiveSendWireMessage((wireMessage) => {
        if (nextSocket.readyState === WebSocket.OPEN) {
          nextSocket.send(wireMessage);
        }
      });
    });

    nextSocket.on("message", (data) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      if (secureTransport.handleIncomingWireMessage(message, {
        sendControlMessage(controlMessage) {
          if (nextSocket.readyState === WebSocket.OPEN) {
            nextSocket.send(JSON.stringify(controlMessage));
          }
        },
        onApplicationMessage(plaintextMessage) {
          handleApplicationMessage(plaintextMessage);
        },
      })) {
        return;
      }
    });

    nextSocket.on("close", (code) => {
      logConnectionStatus("disconnected");
      if (socket === nextSocket) {
        socket = null;
      }
      stopContextUsageWatcher();
      desktopRefresher.handleTransportReset();
      scheduleRelayReconnect(code);
    });

    nextSocket.on("error", () => {
      logConnectionStatus("disconnected");
    });
  }

  initializeRelay()
    .then(() => {
      printQR(secureTransport.createPairingPayload());
      connectRelay();
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });

  codex.onMessage((message) => {
    if (!secureTransport) {
      return;
    }
    let outboundMessage = rewriteCodexResponseIfNeeded(message);
    trackCodexHandshakeState(outboundMessage);
    desktopRefresher.handleOutbound(outboundMessage);
    rememberThreadFromMessage("codex", outboundMessage);
    secureTransport.queueOutboundApplicationMessage(outboundMessage, (wireMessage) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(wireMessage);
      }
    });
  });

  codex.onClose(() => {
    logConnectionStatus("disconnected");
    isShuttingDown = true;
    clearReconnectTimer();
    closeRelayServer();
    stopContextUsageWatcher();
    desktopRefresher.handleTransportReset();
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });

  process.on("SIGINT", () => shutdown(codex, () => socket, () => {
    isShuttingDown = true;
    clearReconnectTimer();
    closeRelayServer();
    stopContextUsageWatcher();
  }));
  process.on("SIGTERM", () => shutdown(codex, () => socket, () => {
    isShuttingDown = true;
    clearReconnectTimer();
    closeRelayServer();
    stopContextUsageWatcher();
  }));

  // Routes decrypted app payloads through the same bridge handlers as before.
  function handleApplicationMessage(rawMessage) {
    if (handleBridgeManagedHandshakeMessage(rawMessage)) {
      return;
    }
    if (handleThreadContextRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleThreadTailRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleDesktopRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleWorkspaceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleGitRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    desktopRefresher.handleInbound(rawMessage);
    rememberThreadFromMessage("phone", rawMessage);
    trackPendingCodexRequest(rawMessage);
    codex.send(rawMessage);
  }

  // Encrypts bridge-generated responses instead of letting the relay see plaintext.
  function sendApplicationResponse(rawMessage) {
    secureTransport.queueOutboundApplicationMessage(rawMessage, (wireMessage) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(wireMessage);
      }
    });
  }

  function rememberThreadFromMessage(source, rawMessage) {
    const context = extractBridgeMessageContext(rawMessage);
    if (!context.threadId) {
      return;
    }

    rememberActiveThread(context.threadId, source);
    if (shouldStartContextUsageWatcher(context)) {
      ensureContextUsageWatcher(context);
    }
  }

  // Mirrors CodexMonitor's persisted token_count fallback so the phone keeps
  // receiving context-window usage even when the runtime omits live thread usage.
  function ensureContextUsageWatcher({ threadId, turnId }) {
    const normalizedThreadId = readString(threadId);
    const normalizedTurnId = readString(turnId);
    if (!normalizedThreadId) {
      return;
    }

    const nextWatcherKey = `${normalizedThreadId}|${normalizedTurnId || "pending-turn"}`;
    if (watchedContextUsageKey === nextWatcherKey && contextUsageWatcher) {
      return;
    }

    stopContextUsageWatcher();
    watchedContextUsageKey = nextWatcherKey;
    contextUsageWatcher = createThreadRolloutActivityWatcher({
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
      onUsage: ({ threadId: usageThreadId, usage }) => {
        sendContextUsageNotification(usageThreadId, usage);
      },
      onIdle: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
      onTimeout: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
      onError: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
    });
  }

  function stopContextUsageWatcher() {
    if (contextUsageWatcher) {
      contextUsageWatcher.stop();
    }

    contextUsageWatcher = null;
    watchedContextUsageKey = null;
  }

  function sendContextUsageNotification(threadId, usage) {
    if (!threadId || !usage) {
      return;
    }

    sendApplicationResponse(JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        usage,
      },
    }));
  }

  // The spawned/shared Codex app-server stays warm across phone reconnects.
  // When iPhone reconnects it sends initialize again, but forwarding that to the
  // already-initialized Codex transport only produces "Already initialized".
  function handleBridgeManagedHandshakeMessage(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!method) {
      return false;
    }

    if (method === "initialize" && parsed.id != null) {
      if (codexHandshakeState !== "warm") {
        forwardedInitializeRequestIds.add(String(parsed.id));
        return false;
      }

      sendApplicationResponse(JSON.stringify({
        id: parsed.id,
        result: {
          bridgeManaged: true,
        },
      }));
      return true;
    }

    if (method === "initialized") {
      return codexHandshakeState === "warm";
    }

    return false;
  }

  // Learns whether the underlying Codex transport has already completed its own MCP handshake.
  function trackCodexHandshakeState(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const responseId = parsed?.id;
    if (responseId == null) {
      return;
    }

    const responseKey = String(responseId);
    if (!forwardedInitializeRequestIds.has(responseKey)) {
      return;
    }

    forwardedInitializeRequestIds.delete(responseKey);

    if (parsed?.result != null) {
      codexHandshakeState = "warm";
      return;
    }

    const errorMessage = typeof parsed?.error?.message === "string"
      ? parsed.error.message.toLowerCase()
      : "";
    if (errorMessage.includes("already initialized")) {
      codexHandshakeState = "warm";
    }
  }

  function trackPendingCodexRequest(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (parsed?.id == null || typeof parsed?.method !== "string") {
      return;
    }

    pendingCodexRequests.set(String(parsed.id), {
      method: parsed.method.trim(),
      params: parsed.params && typeof parsed.params === "object" ? parsed.params : null,
    });
    if (pendingCodexRequests.size > 256) {
      const oldestKey = pendingCodexRequests.keys().next().value;
      if (oldestKey != null) {
        pendingCodexRequests.delete(oldestKey);
      }
    }
  }

  function rewriteCodexResponseIfNeeded(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return rawMessage;
    }

    if (parsed?.id == null) {
      return rawMessage;
    }

    const requestKey = String(parsed.id);
    const pendingRequest = pendingCodexRequests.get(requestKey);
    if (!pendingRequest) {
      return rawMessage;
    }

    pendingCodexRequests.delete(requestKey);

    if (pendingRequest.method !== "thread/list" || parsed?.error != null) {
      return rawMessage;
    }

    try {
      return JSON.stringify(enrichThreadListResponse(parsed, {
        requestParams: pendingRequest.params,
      }));
    } catch {
      return rawMessage;
    }
  }

  async function initializeRelay() {
    if (config.managedRelay) {
      relayServer = await startLocalRelayServer({
        bindHost: config.relayBindHost,
        port: config.relayPort,
        advertisedHost: config.relayAdvertiseHost,
      });
      relayBaseUrl = relayServer.relayUrl.replace(/\/+$/, "");
      if (relayServer.reusedExisting) {
        console.log(`[remodex] using existing local relay at ${relayBaseUrl}`);
      } else {
        console.log(`[remodex] local relay ready at ${relayBaseUrl}`);
      }
      if (config.relayAdvertiseHost === DEFAULT_RELAY_FALLBACK_HOST) {
        console.log(
          "[remodex] no LAN IP was detected; set REMODEX_RELAY_HOST to your Mac's reachable IP if the phone cannot connect."
        );
      }
    } else {
      relayBaseUrl = config.relayUrl.replace(/\/+$/, "");
      console.log(`[remodex] relay endpoint ${relayBaseUrl}`);
    }

    relaySessionUrl = `${relayBaseUrl}/${sessionId}`;
    secureTransport = createBridgeSecureTransport({
      sessionId,
      relayUrl: relayBaseUrl,
      deviceState,
    });
  }

  function closeRelayServer() {
    if (!relayServer) {
      return;
    }
    relayServer.close().catch(() => {});
    relayServer = null;
  }
}

function shutdown(codex, getSocket, beforeExit = () => {}) {
  beforeExit();

  const socket = getSocket();
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    socket.close();
  }

  codex.shutdown();

  setTimeout(() => process.exit(0), 100);
}

function extractBridgeMessageContext(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { method: "", threadId: null, turnId: null };
  }

  const method = parsed?.method;
  const params = parsed?.params;
  const threadId = extractThreadId(method, params);
  const turnId = extractTurnId(method, params);

  return {
    method: typeof method === "string" ? method : "",
    threadId,
    turnId,
  };
}

function shouldStartContextUsageWatcher(context) {
  if (!context?.threadId) {
    return false;
  }

  return context.method === "turn/start"
    || context.method === "turn/started";
}

function extractThreadId(method, params) {
  if (method === "turn/start" || method === "turn/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  if (method === "thread/start" || method === "thread/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.thread?.id)
      || readString(params?.thread?.threadId)
      || readString(params?.thread?.thread_id)
    );
  }

  if (method === "turn/completed") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  return null;
}

function extractTurnId(method, params) {
  if (method === "turn/started" || method === "turn/completed") {
    return (
      readString(params?.turnId)
      || readString(params?.turn_id)
      || readString(params?.id)
      || readString(params?.turn?.id)
      || readString(params?.turn?.turnId)
      || readString(params?.turn?.turn_id)
    );
  }

  return null;
}

function readString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { startBridge };
