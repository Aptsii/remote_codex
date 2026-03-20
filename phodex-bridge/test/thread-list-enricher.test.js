const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { enrichThreadListResponse } = require("../src/thread-list-enricher");

function createSessionsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-thread-list-enricher-"));
  const datedDirectory = path.join(root, "2026", "03", "19");
  fs.mkdirSync(datedDirectory, { recursive: true });
  return { root, datedDirectory };
}

function writeRolloutFile(directory, name, payload) {
  const filePath = path.join(directory, name);
  const line = JSON.stringify({
    timestamp: payload.timestamp || "2026-03-19T04:22:12.462Z",
    type: "session_meta",
    payload,
  });
  fs.writeFileSync(filePath, `${line}\n`, "utf8");
}

test("enrichThreadListResponse appends child subagent threads from session metadata", () => {
  const { root, datedDirectory } = createSessionsRoot();
  writeRolloutFile(datedDirectory, "rollout-child.jsonl", {
    id: "child-thread",
    timestamp: "2026-03-19T04:22:12.462Z",
    cwd: "/repo",
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: "parent-thread",
          agent_nickname: "Pauli",
          agent_role: "explorer",
        },
      },
    },
    agent_nickname: "Pauli",
    agent_role: "explorer",
  });

  const parsed = enrichThreadListResponse({
    result: {
      data: [
        {
          id: "parent-thread",
          title: "Parent",
          cwd: "/repo",
        },
      ],
    },
  }, {
    sessionsRoot: root,
    cacheTtlMs: 0,
  });

  assert.equal(parsed.result.data.length, 2);
  const child = parsed.result.data.find((entry) => entry.id === "child-thread");
  assert.ok(child);
  assert.equal(child.parent_thread_id, "parent-thread");
  assert.equal(child.agent_nickname, "Pauli");
  assert.equal(child.agent_role, "explorer");
});

test("enrichThreadListResponse merges missing subagent metadata into existing child entries", () => {
  const { root, datedDirectory } = createSessionsRoot();
  writeRolloutFile(datedDirectory, "rollout-child-merge.jsonl", {
    id: "child-thread",
    forked_from_id: "parent-thread",
    timestamp: "2026-03-19T04:25:12.462Z",
    agent_nickname: "Singer",
    agent_role: "explorer",
  });

  const parsed = enrichThreadListResponse({
    result: {
      data: [
        { id: "parent-thread", title: "Parent", cwd: "/repo" },
        { id: "child-thread", title: "Conversation" },
      ],
    },
  }, {
    sessionsRoot: root,
    cacheTtlMs: 0,
  });

  const child = parsed.result.data.find((entry) => entry.id === "child-thread");
  assert.equal(child.parent_thread_id, "parent-thread");
  assert.equal(child.agent_nickname, "Singer");
  assert.equal(child.agent_role, "explorer");
});

test("enrichThreadListResponse reads long session_meta first lines before parsing", () => {
  const { root, datedDirectory } = createSessionsRoot();
  writeRolloutFile(datedDirectory, "rollout-child-long-meta.jsonl", {
    id: "child-thread",
    forked_from_id: "parent-thread",
    timestamp: "2026-03-19T04:25:12.462Z",
    cwd: "/repo",
    base_instructions: {
      text: "x".repeat(20 * 1024),
    },
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: "parent-thread",
          agent_nickname: "Noether",
          agent_role: "explorer",
        },
      },
    },
    agent_nickname: "Noether",
    agent_role: "explorer",
  });

  const parsed = enrichThreadListResponse({
    result: {
      data: [
        { id: "parent-thread", title: "Parent", cwd: "/repo" },
      ],
    },
  }, {
    sessionsRoot: root,
    cacheTtlMs: 0,
  });

  assert.equal(parsed.result.data.length, 2);
  const child = parsed.result.data.find((entry) => entry.id === "child-thread");
  assert.ok(child);
  assert.equal(child.parent_thread_id, "parent-thread");
  assert.equal(child.agent_nickname, "Noether");
  assert.equal(child.agent_role, "explorer");
});

test("enrichThreadListResponse skips archived thread/list requests", () => {
  const { root, datedDirectory } = createSessionsRoot();
  writeRolloutFile(datedDirectory, "rollout-child-archived.jsonl", {
    id: "child-thread",
    forked_from_id: "parent-thread",
    timestamp: "2026-03-19T04:25:12.462Z",
    agent_nickname: "Schrodinger",
    agent_role: "explorer",
  });

  const parsed = enrichThreadListResponse({
    result: {
      data: [
        { id: "parent-thread", title: "Parent" },
      ],
    },
  }, {
    sessionsRoot: root,
    cacheTtlMs: 0,
    requestParams: { archived: true },
  });

  assert.equal(parsed.result.data.length, 1);
});
