const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readThreadTail } = require("../src/thread-tail-handler");

function createSessionsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-thread-tail-"));
  const datedDirectory = path.join(root, "2026", "03", "19");
  fs.mkdirSync(datedDirectory, { recursive: true });
  return { root, datedDirectory };
}

function writeRolloutFile(directory, name, lines) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

function sessionMetaLine(threadId) {
  return JSON.stringify({
    timestamp: "2026-03-19T04:17:25.491Z",
    type: "session_meta",
    payload: {
      id: threadId,
      cwd: "/repo",
    },
  });
}

function assistantMessageLine(text, timestamp = "2026-03-19T04:17:40.922Z") {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
      phase: "final_answer",
    },
  });
}

function userMessageLine(text, timestamp = "2026-03-19T04:17:26.207Z") {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function execCommandLine(cmd, timestamp = "2026-03-19T04:17:30.000Z") {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd }),
    },
  });
}

test("readThreadTail returns recent user and assistant chat tail", async () => {
  const { root, datedDirectory } = createSessionsRoot();
  writeRolloutFile(
    datedDirectory,
    "rollout-2026-03-19T13-17-25-child-thread.jsonl",
    [
      sessionMetaLine("child-thread"),
      userMessageLine("Inspect README"),
      assistantMessageLine("The top heading is Remodex."),
    ]
  );

  const result = await readThreadTail({
    threadId: "child-thread",
    sessionsRoot: root,
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].text, "Inspect README");
  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.messages[1].text, "The top heading is Remodex.");
});

test("readThreadTail converts exec_command function calls into command rows", async () => {
  const { root, datedDirectory } = createSessionsRoot();
  writeRolloutFile(
    datedDirectory,
    "rollout-2026-03-19T13-17-25-child-thread.jsonl",
    [
      sessionMetaLine("child-thread"),
      execCommandLine("git diff --check"),
      assistantMessageLine("Looks clean."),
    ]
  );

  const result = await readThreadTail({
    threadId: "child-thread",
    sessionsRoot: root,
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].kind, "commandExecution");
  assert.equal(result.messages[0].text, "git diff --check");
  assert.equal(result.messages[1].text, "Looks clean.");
});

test("readThreadTail keeps only the newest limited tail messages", async () => {
  const { root, datedDirectory } = createSessionsRoot();
  writeRolloutFile(
    datedDirectory,
    "rollout-2026-03-19T13-17-25-child-thread.jsonl",
    [
      sessionMetaLine("child-thread"),
      assistantMessageLine("one", "2026-03-19T04:17:01.000Z"),
      assistantMessageLine("two", "2026-03-19T04:17:02.000Z"),
      assistantMessageLine("three", "2026-03-19T04:17:03.000Z"),
    ]
  );

  const result = await readThreadTail({
    threadId: "child-thread",
    sessionsRoot: root,
    limit: 2,
  });

  assert.deepEqual(
    result.messages.map((message) => message.text),
    ["two", "three"]
  );
});
