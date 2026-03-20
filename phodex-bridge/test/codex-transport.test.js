const test = require("node:test");
const assert = require("node:assert/strict");
const { StringDecoder } = require("node:string_decoder");

test("utf8 decoding across chunk boundaries preserves multibyte characters", () => {
  const message = "한글 mixed text";
  const buffer = Buffer.from(`${message}\n`, "utf8");
  const firstChunk = buffer.subarray(0, 5);
  const secondChunk = buffer.subarray(5);
  const decoder = new StringDecoder("utf8");

  let stdoutBuffer = "";
  const lines = [];

  stdoutBuffer += decoder.write(firstChunk);
  let split = stdoutBuffer.split("\n");
  stdoutBuffer = split.pop() || "";
  lines.push(...split.filter(Boolean));

  stdoutBuffer += decoder.write(secondChunk);
  split = stdoutBuffer.split("\n");
  stdoutBuffer = split.pop() || "";
  lines.push(...split.filter(Boolean));

  const trailing = decoder.end();
  if (trailing) {
    stdoutBuffer += trailing;
  }
  if (stdoutBuffer.trim()) {
    lines.push(stdoutBuffer.trim());
  }

  assert.deepEqual(lines, [message]);
});
