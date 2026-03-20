// FILE: thread-list-enricher.js
// Purpose: Enriches thread/list responses with local subagent child threads derived from session metadata.
// Layer: CLI helper
// Exports: enrichThreadListResponse, enrichThreadListResultObject
// Depends on: fs, path, ./rollout-watch

const fs = require("fs");
const path = require("path");
const { resolveSessionsRoot } = require("./rollout-watch");

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CANDIDATE_LIMIT = 1024;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_HEADER_SCAN_BYTES = 8 * 1024;
const DEFAULT_MAX_HEADER_SCAN_BYTES = 256 * 1024;

let cachedEntries = [];
let cachedAt = 0;
let cachedRoot = "";

function enrichThreadListResponse(
  parsedMessage,
  {
    requestParams = null,
    sessionsRoot = resolveSessionsRoot(),
    fsModule = fs,
    now = () => Date.now(),
    lookbackMs = DEFAULT_LOOKBACK_MS,
    candidateLimit = DEFAULT_CANDIDATE_LIMIT,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  } = {}
) {
  if (!parsedMessage || typeof parsedMessage !== "object" || Array.isArray(parsedMessage)) {
    return parsedMessage;
  }

  if (requestParams?.archived === true) {
    return parsedMessage;
  }

  if (!parsedMessage.result || typeof parsedMessage.result !== "object" || Array.isArray(parsedMessage.result)) {
    return parsedMessage;
  }

  enrichThreadListResultObject(parsedMessage.result, {
    sessionsRoot,
    fsModule,
    now,
    lookbackMs,
    candidateLimit,
    cacheTtlMs,
  });
  return parsedMessage;
}

function enrichThreadListResultObject(
  resultObject,
  {
    sessionsRoot = resolveSessionsRoot(),
    fsModule = fs,
    now = () => Date.now(),
    lookbackMs = DEFAULT_LOOKBACK_MS,
    candidateLimit = DEFAULT_CANDIDATE_LIMIT,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  } = {}
) {
  if (!resultObject || typeof resultObject !== "object") {
    return false;
  }

  const pageKey = ["data", "items", "threads"].find((key) => Array.isArray(resultObject[key]));
  if (!pageKey) {
    return false;
  }

  const page = resultObject[pageKey];
  const pageObjects = page.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  if (pageObjects.length === 0) {
    return false;
  }

  const visibleThreadIds = new Set(pageObjects.map(readThreadId).filter(Boolean));
  if (visibleThreadIds.size === 0) {
    return false;
  }

  const recentChildThreads = readRecentSubagentChildThreads({
    sessionsRoot,
    fsModule,
    now,
    lookbackMs,
    candidateLimit,
    cacheTtlMs,
  });
  if (recentChildThreads.length === 0) {
    return false;
  }

  const existingById = new Map();
  for (const entry of pageObjects) {
    const threadId = readThreadId(entry);
    if (threadId) {
      existingById.set(threadId, entry);
    }
  }

  let didChange = false;
  let didAddNestedChildren = true;
  while (didAddNestedChildren) {
    didAddNestedChildren = false;

    for (const childThread of recentChildThreads) {
      if (!visibleThreadIds.has(childThread.parentThreadId)) {
        continue;
      }

      const existingEntry = existingById.get(childThread.id);
      if (existingEntry) {
        if (mergeSubagentThreadMetadata(existingEntry, childThread)) {
          didChange = true;
        }
        continue;
      }

      const syntheticThread = createSyntheticThreadEntry(childThread);
      page.push(syntheticThread);
      existingById.set(childThread.id, syntheticThread);
      visibleThreadIds.add(childThread.id);
      didChange = true;
      didAddNestedChildren = true;
    }
  }

  return didChange;
}

function readRecentSubagentChildThreads({
  sessionsRoot,
  fsModule,
  now,
  lookbackMs,
  candidateLimit,
  cacheTtlMs,
}) {
  const currentTime = now();
  if (
    cachedRoot === sessionsRoot
    && (currentTime - cachedAt) < cacheTtlMs
  ) {
    return cachedEntries;
  }

  const entries = [];
  const candidateFiles = collectRecentSessionFiles(sessionsRoot, {
    fsModule,
    modifiedAfterMs: Math.max(0, currentTime - lookbackMs),
    candidateLimit,
  });

  for (const candidateFile of candidateFiles) {
    const childThread = readSubagentChildThreadFromSessionMeta(candidateFile, { fsModule });
    if (childThread) {
      entries.push(childThread);
    }
  }

  entries.sort((lhs, rhs) => rhs.updatedAtMs - lhs.updatedAtMs);
  cachedEntries = dedupeSubagentChildThreads(entries);
  cachedAt = currentTime;
  cachedRoot = sessionsRoot;
  return cachedEntries;
}

function collectRecentSessionFiles(
  sessionsRoot,
  {
    fsModule = fs,
    modifiedAfterMs = 0,
    candidateLimit = DEFAULT_CANDIDATE_LIMIT,
  } = {}
) {
  if (!sessionsRoot || !fsModule.existsSync(sessionsRoot)) {
    return [];
  }

  const stack = [sessionsRoot];
  const candidates = [];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fsModule.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()
        || !entry.name.startsWith("rollout-")
        || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const stat = fsModule.statSync(fullPath);
      if (modifiedAfterMs > 0 && stat.mtimeMs < modifiedAfterMs) {
        continue;
      }

      candidates.push({
        filePath: fullPath,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  candidates.sort((lhs, rhs) => rhs.mtimeMs - lhs.mtimeMs);
  return candidates.slice(0, candidateLimit).map((entry) => entry.filePath);
}

function readSubagentChildThreadFromSessionMeta(filePath, { fsModule = fs } = {}) {
  const header = readFileHeader(filePath, {
    fsModule,
    scanBytes: DEFAULT_HEADER_SCAN_BYTES,
    maxScanBytes: DEFAULT_MAX_HEADER_SCAN_BYTES,
  });
  if (!header) {
    return null;
  }

  const firstLine = header.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }

  if (parsed?.type !== "session_meta" || !parsed?.payload || typeof parsed.payload !== "object") {
    return null;
  }

  const payload = parsed.payload;
  const source = objectValue(payload.source);
  const subagent = objectValue(source?.subagent);
  const threadSpawn = objectValue(subagent?.thread_spawn);

  const childThreadId = readString(payload.id);
  const parentThreadId = readString(
    threadSpawn?.parent_thread_id,
    payload.parent_thread_id,
    payload.forked_from_id
  );
  if (!childThreadId || !parentThreadId || childThreadId === parentThreadId) {
    return null;
  }

  return {
    id: childThreadId,
    parentThreadId,
    timestamp: readString(payload.timestamp, parsed.timestamp),
    updatedAtMs: Date.parse(readString(payload.timestamp, parsed.timestamp) || "") || 0,
    cwd: readString(payload.cwd, payload.working_directory, payload.current_working_directory),
    agentId: readString(threadSpawn?.agent_id, payload.agent_id),
    agentNickname: readString(threadSpawn?.agent_nickname, payload.agent_nickname),
    agentRole: readString(threadSpawn?.agent_role, payload.agent_role),
    model: readString(payload.model),
    modelProvider: readString(payload.model_provider),
  };
}

function dedupeSubagentChildThreads(entries) {
  const byThreadId = new Map();
  for (const entry of entries) {
    if (!byThreadId.has(entry.id)) {
      byThreadId.set(entry.id, entry);
      continue;
    }

    const existing = byThreadId.get(entry.id);
    if (entry.updatedAtMs > existing.updatedAtMs) {
      byThreadId.set(entry.id, entry);
    }
  }

  return Array.from(byThreadId.values());
}

function readFileHeader(
  filePath,
  {
    fsModule = fs,
    scanBytes = DEFAULT_HEADER_SCAN_BYTES,
    maxScanBytes = DEFAULT_MAX_HEADER_SCAN_BYTES,
  } = {}
) {
  try {
    const stat = fsModule.statSync(filePath);
    const maxReadableBytes = Math.min(stat.size, maxScanBytes);
    if (maxReadableBytes <= 0) {
      return "";
    }

    const descriptor = fsModule.openSync(filePath, "r");
    try {
      let offset = 0;
      let chunkSize = Math.max(1, scanBytes);
      let header = "";

      while (offset < maxReadableBytes) {
        const readLength = Math.min(chunkSize, maxReadableBytes - offset);
        const buffer = Buffer.alloc(readLength);
        const bytesRead = fsModule.readSync(descriptor, buffer, 0, readLength, offset);
        if (bytesRead <= 0) {
          break;
        }

        header += buffer.toString("utf8", 0, bytesRead);
        if (header.includes("\n")) {
          break;
        }

        offset += bytesRead;
      }

      return header;
    } finally {
      fsModule.closeSync(descriptor);
    }
  } catch {
    return "";
  }
}

function createSyntheticThreadEntry(childThread) {
  const source = {
    subagent: {
      thread_spawn: {
        parent_thread_id: childThread.parentThreadId,
      },
    },
  };

  if (childThread.agentId) {
    source.subagent.thread_spawn.agent_id = childThread.agentId;
  }
  if (childThread.agentNickname) {
    source.subagent.thread_spawn.agent_nickname = childThread.agentNickname;
  }
  if (childThread.agentRole) {
    source.subagent.thread_spawn.agent_role = childThread.agentRole;
  }

  const entry = {
    id: childThread.id,
    createdAt: childThread.timestamp,
    updatedAt: childThread.timestamp,
    parent_thread_id: childThread.parentThreadId,
    source,
  };

  if (childThread.cwd) {
    entry.cwd = childThread.cwd;
  }
  if (childThread.agentId) {
    entry.agent_id = childThread.agentId;
  }
  if (childThread.agentNickname) {
    entry.agent_nickname = childThread.agentNickname;
  }
  if (childThread.agentRole) {
    entry.agent_role = childThread.agentRole;
  }
  if (childThread.model) {
    entry.model = childThread.model;
  }
  if (childThread.modelProvider) {
    entry.model_provider = childThread.modelProvider;
  }

  return entry;
}

function mergeSubagentThreadMetadata(target, childThread) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }

  let didChange = false;

  if (!readString(target.parent_thread_id, target.parentThreadId)) {
    target.parent_thread_id = childThread.parentThreadId;
    didChange = true;
  }
  if (!readString(target.agent_id, target.agentId) && childThread.agentId) {
    target.agent_id = childThread.agentId;
    didChange = true;
  }
  if (!readString(target.agent_nickname, target.agentNickname) && childThread.agentNickname) {
    target.agent_nickname = childThread.agentNickname;
    didChange = true;
  }
  if (!readString(target.agent_role, target.agentRole) && childThread.agentRole) {
    target.agent_role = childThread.agentRole;
    didChange = true;
  }
  if (!readString(target.model_provider, target.modelProvider) && childThread.modelProvider) {
    target.model_provider = childThread.modelProvider;
    didChange = true;
  }
  if (!readString(target.model) && childThread.model) {
    target.model = childThread.model;
    didChange = true;
  }
  if (!readString(target.cwd, target.current_working_directory, target.working_directory) && childThread.cwd) {
    target.cwd = childThread.cwd;
    didChange = true;
  }
  if (!readString(target.updatedAt, target.updated_at) && childThread.timestamp) {
    target.updatedAt = childThread.timestamp;
    didChange = true;
  }
  if (!readString(target.createdAt, target.created_at) && childThread.timestamp) {
    target.createdAt = childThread.timestamp;
    didChange = true;
  }

  const source = ensureObject(target, "source");
  const subagent = ensureObject(source, "subagent");
  const threadSpawn = ensureObject(subagent, "thread_spawn");
  if (!readString(threadSpawn.parent_thread_id)) {
    threadSpawn.parent_thread_id = childThread.parentThreadId;
    didChange = true;
  }
  if (!readString(threadSpawn.agent_id) && childThread.agentId) {
    threadSpawn.agent_id = childThread.agentId;
    didChange = true;
  }
  if (!readString(threadSpawn.agent_nickname) && childThread.agentNickname) {
    threadSpawn.agent_nickname = childThread.agentNickname;
    didChange = true;
  }
  if (!readString(threadSpawn.agent_role) && childThread.agentRole) {
    threadSpawn.agent_role = childThread.agentRole;
    didChange = true;
  }

  return didChange;
}

function ensureObject(parent, key) {
  const existing = objectValue(parent[key]);
  if (existing) {
    return existing;
  }

  const created = {};
  parent[key] = created;
  return created;
}

function objectValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function readThreadId(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }
  return readString(entry.id, entry.threadId, entry.thread_id);
}

function readString(...values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

module.exports = {
  enrichThreadListResponse,
  enrichThreadListResultObject,
};
