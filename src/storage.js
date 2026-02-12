const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const LOG_PREFIX = "[storage]";

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name) {
  ensureDir();
  return path.join(DATA_DIR, name);
}

function readJson(name, fallback) {
  const fp = filePath(name);
  try {
    if (!fs.existsSync(fp)) return fallback;
    const raw = fs.readFileSync(fp, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`${LOG_PREFIX} readJson failed for ${fp}: ${String(e.message || e)}`);
    return fallback;
  }
}

function writeJson(name, obj) {
  const fp = filePath(name);
  const tmp = fp + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, fp);
  } catch (e) {
    console.error(`${LOG_PREFIX} writeJson failed for ${fp}: ${String(e.message || e)}`);
    throw e;
  }
}

module.exports = { readJson, writeJson, DATA_DIR };
