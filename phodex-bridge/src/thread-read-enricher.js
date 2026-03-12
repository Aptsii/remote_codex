// FILE: thread-read-enricher.js
// Purpose: Backfills thread/read history items with rollout timestamps when the runtime omits them.
// Layer: CLI helper
// Exports: enrichThreadReadResponse
// Depends on: fs, ./rollout-watch

const fs = require("fs");
const {
  findRolloutFileForThread,
  resolveSessionsRoot,
} = require("./rollout-watch");

const rolloutCacheByPath = new Map();

function enrichThreadReadResponse(rawMessage, {
  fsModule = fs,
  sessionsRoot = resolveSessionsRoot(),
} = {}) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return rawMessage;
  }

  const thread = parsed?.result?.thread;
  if (!thread || typeof thread !== "object") {
    return rawMessage;
  }

  const threadId = readNonEmptyString(thread.id);
  if (!threadId || !Array.isArray(thread.turns) || thread.turns.length === 0) {
    return rawMessage;
  }

  const rolloutEntries = loadRolloutEntries(threadId, {
    fsModule,
    sessionsRoot,
  });
  if (!rolloutEntries) {
    return rawMessage;
  }

  const didMutate = applyRolloutTimestamps(thread.turns, rolloutEntries);
  if (!didMutate) {
    return rawMessage;
  }

  return JSON.stringify(parsed);
}

function loadRolloutEntries(threadId, { fsModule, sessionsRoot }) {
  const rolloutPath = findRolloutFileForThread(sessionsRoot, threadId, { fsModule });
  if (!rolloutPath) {
    return null;
  }

  let stat = null;
  try {
    stat = fsModule.statSync(rolloutPath);
  } catch {
    return null;
  }

  const cached = rolloutCacheByPath.get(rolloutPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cloneRolloutEntries(cached.entries);
  }

  let rawFile = "";
  try {
    rawFile = fsModule.readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }

  const entries = buildRolloutEntries(rawFile);
  rolloutCacheByPath.set(rolloutPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    entries,
  });
  return cloneRolloutEntries(entries);
}

function cloneRolloutEntries(entries) {
  return {
    user: entries.user.slice(),
    assistant: entries.assistant.slice(),
    reasoning: entries.reasoning.slice(),
  };
}

function buildRolloutEntries(rawFile) {
  const buckets = {
    user: [],
    assistant: [],
    reasoning: [],
  };

  const lines = rawFile.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed?.type !== "response_item") {
      continue;
    }

    const payload = parsed?.payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }

    const timestampSeconds = parseTimestampSeconds(parsed.timestamp);
    if (timestampSeconds == null) {
      continue;
    }

    const bucketName = rolloutBucketName(payload);
    if (!bucketName) {
      continue;
    }

    buckets[bucketName].push({
      timestampSeconds,
      text: normalizeTimelineText(extractRolloutPayloadText(payload)),
    });
  }

  return buckets;
}

function applyRolloutTimestamps(turns, rolloutEntries) {
  const cursors = {
    user: { index: 0 },
    assistant: { index: 0 },
    reasoning: { index: 0 },
  };

  let didMutate = false;

  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
      continue;
    }

    for (const item of turn.items) {
      if (!item || typeof item !== "object" || itemHasTimestamp(item)) {
        continue;
      }

      const bucketName = historyBucketName(item);
      if (!bucketName) {
        continue;
      }

      const timestampSeconds = consumeMatchingTimestamp(
        rolloutEntries[bucketName],
        cursors[bucketName],
        normalizeTimelineText(extractThreadReadItemText(item))
      );
      if (timestampSeconds == null) {
        continue;
      }

      item.createdAt = timestampSeconds;
      didMutate = true;
    }
  }

  return didMutate;
}

function consumeMatchingTimestamp(entries, cursor, expectedText) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const startIndex = cursor.index || 0;
  if (expectedText) {
    for (let index = startIndex; index < entries.length; index += 1) {
      if (entries[index].text === expectedText) {
        cursor.index = index + 1;
        return entries[index].timestampSeconds;
      }
    }
  }

  if (startIndex >= entries.length) {
    return null;
  }

  const fallbackEntry = entries[startIndex];
  cursor.index = startIndex + 1;
  return fallbackEntry.timestampSeconds;
}

function historyBucketName(item) {
  const itemType = normalizeItemType(item.type);
  const role = readNonEmptyString(item.role)?.toLowerCase() || "";

  if (itemType === "usermessage" || (itemType === "message" && role.includes("user"))) {
    return "user";
  }
  if (itemType === "agentmessage"
    || itemType === "assistantmessage"
    || (itemType === "message" && !role.includes("user"))) {
    return "assistant";
  }
  if (itemType === "reasoning") {
    return "reasoning";
  }

  return null;
}

function rolloutBucketName(payload) {
  const payloadType = normalizeItemType(payload.type);
  const role = readNonEmptyString(payload.role)?.toLowerCase() || "";

  if (payloadType === "message") {
    return role.includes("user") ? "user" : "assistant";
  }
  if (payloadType === "reasoning") {
    return "reasoning";
  }

  return null;
}

function extractThreadReadItemText(item) {
  const directText = readNonEmptyString(item.text) || readNonEmptyString(item.message);
  if (directText) {
    return directText;
  }

  if (!Array.isArray(item.content)) {
    return "";
  }

  const textParts = [];
  for (const part of item.content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const normalizedType = normalizeItemType(part.type);
    if (normalizedType === "text"
      || normalizedType === "inputtext"
      || normalizedType === "outputtext"
      || normalizedType === "message") {
      const text = readNonEmptyString(part.text);
      if (text) {
        textParts.push(text);
      }
    }
  }

  return textParts.join("\n");
}

function extractRolloutPayloadText(payload) {
  const directText = readNonEmptyString(payload.text) || readNonEmptyString(payload.message);
  if (directText) {
    return directText;
  }

  if (!Array.isArray(payload.content)) {
    return "";
  }

  const textParts = [];
  for (const part of payload.content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const normalizedType = normalizeItemType(part.type);
    if (normalizedType === "text"
      || normalizedType === "inputtext"
      || normalizedType === "outputtext"
      || normalizedType === "message") {
      const text = readNonEmptyString(part.text);
      if (text) {
        textParts.push(text);
      }
    }
  }

  return textParts.join("\n");
}

function normalizeItemType(value) {
  const normalized = readNonEmptyString(value);
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/[_-]/g, "")
    .toLowerCase();
}

function normalizeTimelineText(value) {
  const normalized = readNonEmptyString(value);
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimestampSeconds(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return timestamp / 1_000;
}

function itemHasTimestamp(item) {
  return [
    "createdAt",
    "created_at",
    "updatedAt",
    "updated_at",
    "timestamp",
    "time",
    "startedAt",
    "started_at",
  ].some((key) => item[key] != null);
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  enrichThreadReadResponse,
};
