const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadLocalEnvFiles } = require("../src/load-env");

test("loadLocalEnvFiles reads .env from the project root without overriding existing env", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-env-"));
  const projectRoot = path.join(tempRoot, "phodex-bridge");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".env"),
    [
      "# test config",
      "REMODEX_RELAY_HOST=203.0.113.10",
      "REMODEX_RELAY_PORT=9999",
      "UNCHANGED_VALUE=from-file",
      "",
    ].join("\n"),
    "utf8"
  );

  const env = {
    UNCHANGED_VALUE: "already-set",
  };

  loadLocalEnvFiles({
    cwd: projectRoot,
    projectRoot,
    env,
  });

  assert.equal(env.REMODEX_RELAY_HOST, "203.0.113.10");
  assert.equal(env.REMODEX_RELAY_PORT, "9999");
  assert.equal(env.UNCHANGED_VALUE, "already-set");
});

test("loadLocalEnvFiles prefers .env.local over .env", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-env-"));
  const projectRoot = path.join(tempRoot, "phodex-bridge");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".env"), "REMODEX_RELAY_HOST=203.0.113.10\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, ".env.local"), "REMODEX_RELAY_HOST=198.51.100.20\n", "utf8");

  const env = {};
  loadLocalEnvFiles({
    cwd: projectRoot,
    projectRoot,
    env,
  });

  assert.equal(env.REMODEX_RELAY_HOST, "198.51.100.20");
});
