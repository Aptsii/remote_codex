// FILE: relay-config.js
// Purpose: Centralizes local-first relay defaults and host detection for bridge startup.
// Layer: CLI helper
// Exports: buildRelayBaseUrl, readRelayConfig
// Depends on: os

const os = require("os");

const DEFAULT_RELAY_PORT = 8787;
const DEFAULT_RELAY_BIND_HOST = "0.0.0.0";
const DEFAULT_RELAY_FALLBACK_HOST = "127.0.0.1";

function readRelayConfig({ env = process.env, networkInterfaces = os.networkInterfaces } = {}) {
  const explicitRelayUrl = readFirstDefinedEnv(
    ["REMODEX_RELAY", "PHODEX_RELAY"],
    "",
    env
  );
  if (explicitRelayUrl) {
    return {
      managedRelay: false,
      relayUrl: explicitRelayUrl,
      relayPort: null,
      relayBindHost: null,
      relayAdvertiseHost: null,
    };
  }

  const relayPort = parseIntegerEnv(
    readFirstDefinedEnv(
      ["REMODEX_RELAY_PORT", "PHODEX_RELAY_PORT"],
      String(DEFAULT_RELAY_PORT),
      env
    ),
    DEFAULT_RELAY_PORT
  );
  const relayBindHost = readFirstDefinedEnv(
    ["REMODEX_RELAY_BIND_HOST", "PHODEX_RELAY_BIND_HOST"],
    DEFAULT_RELAY_BIND_HOST,
    env
  );
  const relayAdvertiseHost = resolveRelayAdvertiseHost({ env, networkInterfaces });

  return {
    managedRelay: true,
    relayUrl: buildRelayBaseUrl({ host: relayAdvertiseHost, port: relayPort }),
    relayPort,
    relayBindHost,
    relayAdvertiseHost,
  };
}

function buildRelayBaseUrl({ host, port }) {
  return `ws://${formatHostForUrl(host)}:${port}/relay`;
}

function resolveRelayAdvertiseHost({ env = process.env, networkInterfaces = os.networkInterfaces } = {}) {
  const explicitHost = readFirstDefinedEnv(
    ["REMODEX_RELAY_HOST", "PHODEX_RELAY_HOST"],
    "",
    env
  );
  if (explicitHost) {
    return explicitHost;
  }

  const interfaces = typeof networkInterfaces === "function"
    ? networkInterfaces()
    : networkInterfaces;
  const candidates = [];

  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const address of addresses || []) {
      const family = typeof address?.family === "string" ? address.family : String(address?.family || "");
      if (family !== "IPv4" || address?.internal !== false || !address?.address) {
        continue;
      }
      if (String(address.address).startsWith("169.254.")) {
        continue;
      }
      candidates.push({
        name,
        address: String(address.address),
      });
    }
  }

  if (candidates.length === 0) {
    return DEFAULT_RELAY_FALLBACK_HOST;
  }

  candidates.sort((left, right) => preferredInterfaceRank(left.name) - preferredInterfaceRank(right.name));
  return candidates[0].address;
}

function preferredInterfaceRank(name) {
  if (/^(en|eth|wlan|wifi|wl)/i.test(name)) {
    return 0;
  }
  if (/^(bridge|br-|docker|vboxnet|vmnet)/i.test(name)) {
    return 2;
  }
  return 1;
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

function readFirstDefinedEnv(keys, fallback, env = process.env) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return fallback;
}

function parseIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

module.exports = {
  DEFAULT_RELAY_BIND_HOST,
  DEFAULT_RELAY_FALLBACK_HOST,
  DEFAULT_RELAY_PORT,
  buildRelayBaseUrl,
  readRelayConfig,
};
