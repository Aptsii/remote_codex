// FILE: load-env.js
// Purpose: Loads local .env files for bridge runs without requiring shell-exported variables.
// Layer: CLI helper
// Exports: loadLocalEnvFiles
// Depends on: fs, path

const fs = require("fs");
const path = require("path");

const DEFAULT_ENV_FILENAMES = [".env.local", ".env"];

function loadLocalEnvFiles({
  cwd = process.cwd(),
  projectRoot = path.resolve(__dirname, ".."),
  filenames = DEFAULT_ENV_FILENAMES,
  env = process.env,
} = {}) {
  const candidateDirs = dedupePaths([cwd, projectRoot]);

  for (const directory of candidateDirs) {
    for (const filename of filenames) {
      const filePath = path.join(directory, filename);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const contents = fs.readFileSync(filePath, "utf8");
      applyEnvFile(contents, env);
    }
  }

  return env;
}

function applyEnvFile(contents, env) {
  const lines = String(contents || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] != null) {
      continue;
    }

    const rawValue = normalizedLine.slice(separatorIndex + 1).trim();
    env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue) {
  if (!rawValue) {
    return "";
  }

  const firstChar = rawValue[0];
  const lastChar = rawValue[rawValue.length - 1];
  if ((firstChar === "\"" && lastChar === "\"") || (firstChar === "'" && lastChar === "'")) {
    const inner = rawValue.slice(1, -1);
    return firstChar === "\"" ? unescapeDoubleQuotedValue(inner) : inner;
  }

  const commentIndex = rawValue.indexOf(" #");
  const valueWithoutInlineComment = commentIndex >= 0
    ? rawValue.slice(0, commentIndex).trimEnd()
    : rawValue;
  return valueWithoutInlineComment;
}

function unescapeDoubleQuotedValue(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function dedupePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean).map((value) => path.resolve(value))));
}

module.exports = {
  loadLocalEnvFiles,
};
