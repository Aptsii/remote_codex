// FILE: thread-read-enricher.test.js
// Purpose: Verifies thread/read history rows inherit rollout timestamps when the runtime omits them.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/thread-read-enricher

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { enrichThreadReadResponse } = require("../src/thread-read-enricher");

test("thread/read enrichment backfills sequential user and assistant timestamps from rollout history", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-thread-read-"));
  const sessionsRoot = path.join(tempRoot, "sessions", "2026", "03", "13");
  fs.mkdirSync(sessionsRoot, { recursive: true });

  const threadId = "thread-rollout-seq";
  const rolloutPath = path.join(
    sessionsRoot,
    `rollout-2026-03-13T10-00-00-${threadId}.jsonl`
  );

  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: "2026-03-13T01:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-13T01:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "first reply" }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-13T01:05:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-13T01:05:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "second reply" }],
      },
    }),
  ].join("\n"));

  const rawResponse = JSON.stringify({
    id: "thread-read-1",
    result: {
      thread: {
        id: threadId,
        createdAt: 1,
        turns: [{
          id: "turn-1",
          items: [
            { type: "userMessage", text: "hello" },
            { type: "agentMessage", text: "first reply" },
            { type: "userMessage", text: "hello" },
            { type: "agentMessage", text: "second reply" },
          ],
        }],
      },
    },
  });

  const enriched = JSON.parse(enrichThreadReadResponse(rawResponse, { sessionsRoot }));
  const items = enriched.result.thread.turns[0].items;

  assert.equal(items[0].createdAt, Date.parse("2026-03-13T01:00:00.000Z") / 1000);
  assert.equal(items[1].createdAt, Date.parse("2026-03-13T01:00:03.000Z") / 1000);
  assert.equal(items[2].createdAt, Date.parse("2026-03-13T01:05:00.000Z") / 1000);
  assert.equal(items[3].createdAt, Date.parse("2026-03-13T01:05:04.000Z") / 1000);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("thread/read enrichment preserves explicit item timestamps", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-thread-read-"));
  const sessionsRoot = path.join(tempRoot, "sessions", "2026", "03", "13");
  fs.mkdirSync(sessionsRoot, { recursive: true });

  const threadId = "thread-rollout-existing";
  const rolloutPath = path.join(
    sessionsRoot,
    `rollout-2026-03-13T10-00-00-${threadId}.jsonl`
  );
  fs.writeFileSync(rolloutPath, JSON.stringify({
    timestamp: "2026-03-13T02:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "existing timestamp" }],
    },
  }));

  const rawResponse = JSON.stringify({
    id: "thread-read-2",
    result: {
      thread: {
        id: threadId,
        turns: [{
          id: "turn-1",
          items: [
            {
              type: "userMessage",
              text: "existing timestamp",
              createdAt: 123,
            },
          ],
        }],
      },
    },
  });

  const enriched = JSON.parse(enrichThreadReadResponse(rawResponse, { sessionsRoot }));
  assert.equal(enriched.result.thread.turns[0].items[0].createdAt, 123);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
