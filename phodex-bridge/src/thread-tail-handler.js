// FILE: thread-tail-handler.js
// Purpose: Serves lightweight recent-tail reads for large local child threads.
// Layer: Bridge handler
// Exports: handleThreadTailRequest, readThreadTail
// Depends on: fs, ./rollout-watch

const fs = require("fs");
const { resolveSessionsRoot, findRolloutFileForThread } = require("./rollout-watch");

const DEFAULT_MESSAGE_LIMIT = 24;
const DEFAULT_INITIAL_SCAN_BYTES = 64 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 1024 * 1024;

function handleThreadTailRequest(rawMessage, sendResponse) {
  let parsed;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }

  const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
  if (method !== "thread/readTail") {
    return false;
  }

  const id = parsed.id;
  const params = parsed.params || {};

  readThreadTail({
    threadId: readString(params.threadId) || readString(params.thread_id),
    limit: readPositiveInteger(params.limit) || DEFAULT_MESSAGE_LIMIT,
  })
    .then((result) => {
      sendResponse(JSON.stringify({ id, result }));
    })
    .catch((error) => {
      const errorCode = error.errorCode || "thread_tail_error";
      const message = error.userMessage || error.message || "Unknown thread tail error";
      sendResponse(
        JSON.stringify({
          id,
          error: {
            code: -32000,
            message,
            data: { errorCode },
          },
        })
      );
    });

  return true;
}

async function readThreadTail({
  threadId,
  limit = DEFAULT_MESSAGE_LIMIT,
  sessionsRoot = resolveSessionsRoot(),
  fsModule = fs,
  initialScanBytes = DEFAULT_INITIAL_SCAN_BYTES,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
} = {}) {
  if (!threadId) {
    throw threadTailError("missing_thread_id", "thread/readTail requires a threadId.");
  }

  const rolloutPath = findRolloutFileForThread(sessionsRoot, threadId, { fsModule });
  if (!rolloutPath) {
    return {
      threadId,
      messages: [],
      hasEarlierHistory: false,
      rolloutPath: null,
    };
  }

  const stat = fsModule.statSync(rolloutPath);
  const fileSize = stat.size;
  if (fileSize <= 0) {
    return {
      threadId,
      messages: [],
      hasEarlierHistory: false,
      rolloutPath,
    };
  }

  let scanBytes = Math.min(initialScanBytes, fileSize);
  let messages = [];
  let didScanFullFile = false;

  while (true) {
    const start = Math.max(0, fileSize - scanBytes);
    const chunk = readFileSlice(rolloutPath, start, fileSize, fsModule);
    if (!chunk) {
      break;
    }

    const lines = chunk.split("\n");
    if (start > 0 && lines.length > 0) {
      lines.shift();
    }

    messages = extractTailMessages(lines, {
      threadId,
      limit,
    });

    if (messages.length >= limit || start === 0 || scanBytes >= maxScanBytes) {
      didScanFullFile = start === 0;
      break;
    }

    scanBytes = Math.min(scanBytes * 2, maxScanBytes, fileSize);
  }

  return {
    threadId,
    messages,
    hasEarlierHistory: didScanFullFile ? false : messages.length > 0,
    rolloutPath,
  };
}

function extractTailMessages(lines, { threadId, limit }) {
  const messages = [];

  for (let index = 0; index < lines.length; index += 1) {
    const message = decodeTailLine(lines[index], {
      threadId,
      sequence: index,
    });
    if (message) {
      messages.push(message);
    }
  }

  return messages.slice(-limit);
}

function decodeTailLine(rawLine, { threadId, sequence }) {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const createdAt = readString(parsed.timestamp);
  if (!createdAt) {
    return null;
  }

  if (parsed.type === "response_item") {
    return decodeResponseItemTailMessage(parsed.payload, { threadId, sequence, createdAt });
  }

  if (parsed.type === "event_msg") {
    return decodeEventTailMessage(parsed.payload, { threadId, sequence, createdAt });
  }

  return null;
}

function decodeResponseItemTailMessage(payload, { threadId, sequence, createdAt }) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const type = normalizeString(payload.type);
  if (type === "message") {
    const role = normalizeString(payload.role);
    if (role !== "user" && role !== "assistant") {
      return null;
    }

    const text = extractMessageText(payload);
    if (!text) {
      return null;
    }

    return buildTailMessage({
      threadId,
      role,
      kind: "chat",
      text,
      createdAt,
      sequence,
    });
  }

  if (type === "function_call") {
    const name = normalizeString(payload.name);
    const text = previewFunctionCall(name, payload.arguments);
    if (!text) {
      return null;
    }

    return buildTailMessage({
      threadId,
      role: "system",
      kind: "commandExecution",
      text,
      createdAt,
      sequence,
    });
  }

  if (type === "custom_tool_call") {
    const name = normalizeString(payload.name);
    const text = previewCustomToolCall(name, payload.input);
    if (!text) {
      return null;
    }

    return buildTailMessage({
      threadId,
      role: "system",
      kind: "commandExecution",
      text,
      createdAt,
      sequence,
    });
  }

  return null;
}

function decodeEventTailMessage(payload, { threadId, sequence, createdAt }) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const eventType = normalizeString(payload.type);

  if (eventType === "task_complete") {
    const text = readString(payload.last_agent_message);
    if (!text) {
      return null;
    }

    return buildTailMessage({
      threadId,
      role: "assistant",
      kind: "chat",
      text,
      createdAt,
      sequence,
    });
  }

  if (eventType === "agent_message") {
    const text = readString(payload.message);
    if (!text) {
      return null;
    }

    return buildTailMessage({
      threadId,
      role: "assistant",
      kind: "chat",
      text,
      createdAt,
      sequence,
    });
  }

  if (eventType === "user_message") {
    const text = readString(payload.message);
    if (!text) {
      return null;
    }

    return buildTailMessage({
      threadId,
      role: "user",
      kind: "chat",
      text,
      createdAt,
      sequence,
    });
  }

  return null;
}

function extractMessageText(payload) {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const type = normalizeString(item.type);
    if ((type === "output_text" || type === "input_text" || type === "text")
      && readString(item.text)) {
      parts.push(item.text.trim());
    }
  }

  if (parts.length > 0) {
    return parts.join("\n").trim();
  }

  return readString(payload.text) || null;
}

function previewFunctionCall(name, rawArguments) {
  if (!name) {
    return null;
  }

  if (name === "exec_command") {
    const parsed = tryParseJSONObject(rawArguments);
    const command = readString(parsed?.cmd);
    if (command) {
      return command;
    }
  }

  if (name === "send_input") {
    return "send_input";
  }

  if (name === "spawn_agent") {
    return "spawn_agent";
  }

  if (name === "apply_patch") {
    return "apply_patch";
  }

  return name;
}

function previewCustomToolCall(name, rawInput) {
  if (!name) {
    return null;
  }

  if (name === "apply_patch") {
    return "apply_patch";
  }

  return readString(rawInput) || name;
}

function buildTailMessage({ threadId, role, kind, text, createdAt, sequence }) {
  return {
    id: `tail:${threadId}:${createdAt}:${sequence}:${role}`,
    threadId,
    role,
    kind,
    text,
    createdAt,
    isStreaming: false,
    deliveryState: "confirmed",
  };
}

function readFileSlice(filePath, start, endExclusive, fsModule = fs) {
  const length = Math.max(0, endExclusive - start);
  if (length === 0) {
    return "";
  }

  const fileHandle = fsModule.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fsModule.readSync(fileHandle, buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fsModule.closeSync(fileHandle);
  }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return null;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function tryParseJSONObject(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function threadTailError(errorCode, userMessage) {
  const error = new Error(userMessage);
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

module.exports = {
  handleThreadTailRequest,
  readThreadTail,
};
