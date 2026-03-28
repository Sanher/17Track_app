const express = require("express");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readJson, writeJson, DATA_DIR } = require("./storage");

const STORE_FILE = "store.json";
const APP_LOG_LEVEL = "info";
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const APP_VERSION = `v${String(require("../package.json")?.version || "0.0.0")}`;
const PACKAGE_SOURCES = new Set(["imap"]);
const DEFAULT_PACKAGE_SOURCE = "imap";
const APP_JSON_LIMIT = String(process.env.APP_JSON_LIMIT || "256kb").trim();
const APP_API_KEY = String(process.env.APP_API_KEY || "").trim();
const HA_AUDIT_LOG_ENABLED_RAW = process.env.HA_AUDIT_LOG_ENABLED;
const HA_AUDIT_LOG_ENABLED = boolFromAny(HA_AUDIT_LOG_ENABLED_RAW, false);
const HA_AUDIT_LOG_LEVEL = String(process.env.HA_AUDIT_LOG_LEVEL || "info").trim().toLowerCase();
const HA_AUDIT_LOG_NAME = String(process.env.HA_AUDIT_LOG_NAME || "HA IMAP Tracker").trim();
const HA_AUDIT_LOG_ENTITY_ID = String(process.env.HA_AUDIT_LOG_ENTITY_ID || "").trim();
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const TELEGRAM_PUBLIC_DIR = path.join(PUBLIC_DIR, "telegram");
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_SESSION_SECRET = String(
  process.env.TELEGRAM_SESSION_SECRET || TELEGRAM_BOT_TOKEN || ""
).trim();
const TELEGRAM_ACCESS_FILE = String(process.env.TELEGRAM_ACCESS_FILE || "").trim();
const TELEGRAM_PUBLIC_BASE_URL = String(process.env.TELEGRAM_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
const TELEGRAM_INIT_DATA_MAX_AGE_SEC = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SEC || 3600);
const TELEGRAM_SESSION_TTL_SEC = Number(process.env.TELEGRAM_SESSION_TTL_SEC || 12 * 60 * 60);
const TELEGRAM_SESSION_COOKIE = "tg_paquetes_session";
const HA_USER_OWNERS_FILE = String(process.env.HA_USER_OWNERS_FILE || "/config/ha_user_owners.json").trim();
const RAW_DEBUG_OWNER = String.fromCharCode(100, 97, 118, 105, 100);
const APP_ROOT_DIR = path.join(__dirname, "..");
const IMAP_WORKER_SCRIPT = path.join(APP_ROOT_DIR, "scripts", "imap_ingest_worker.py");

function pad2(n) {
  return String(n).padStart(2, "0");
}

function localIsoWithOffset(d = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offAbs = Math.abs(offsetMin);
  const offH = pad2(Math.floor(offAbs / 60));
  const offM = pad2(offAbs % 60);
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`;
}

/**
 * store.json structure (persisted in DATA_DIR/store.json)
 *
 * {
 *   owners: {
 *     owner_a: {
 *       trackings: ["PH7...", "323..."] ,
 *       // meta holds user-provided metadata per tracking number
 *       meta: {
 *         "PH7...": {
 *           note: "Amazon - regalo",       // free text shown in status lines
 *           delivered_override: false       // OPTIONAL: force delivered true/false. If undefined, use flags from the latest snapshot.
 *         }
 *       },
 *       // last holds the latest normalized status per tracking
 *       last: {
 *         "PH7...": {
 *           number: "PH7...",
 *           carrierKey: 19181,
 *           carrierName: "Correos Spain",
 *           latest: { status, subStatus, description, time, location },
 *           flags: { isOutForDelivery, isDelivered }
 *         }
 *       },
 *       // refresh bookkeeping (ISO timestamps)
 *       last_checked_at: "2026-02-05T10:15:00+01:00",       // last time we attempted a refresh for this owner
 *       last_full_refresh_at: "2026-02-05T08:00:00+01:00"   // last time we refreshed while all were delivered (slow schedule)
 *     }
 *   }
 * }
 */

function loadStore() { return sanitizeStore(readJson(STORE_FILE, { owners: {} })); }
function saveStore(store) { writeJson(STORE_FILE, sanitizeStore(store)); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: APP_JSON_LIMIT }));
app.use(express.static(PUBLIC_DIR));
app.get("/ui", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.use("/telegram/app", express.static(TELEGRAM_PUBLIC_DIR, { index: false, redirect: false }));
app.get(["/telegram/app", "/telegram/app/"], (_req, res) => {
  res.sendFile(path.join(TELEGRAM_PUBLIC_DIR, "index.html"));
});

function extractRequestApiKey(req) {
  const byHeader = String(req.get("x-api-key") || "").trim();
  if (byHeader) return byHeader;
  const auth = String(req.get("authorization") || "").trim();
  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

function sanitizeAuditExtra(extra = {}) {
  const out = {};
  const hidden = ["token", "secret", "password", "authorization", "api_key", "bearer"];
  for (const [k, v] of Object.entries(extra || {})) {
    const lk = String(k || "").toLowerCase();
    if (hidden.some((h) => lk.includes(h))) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string") {
      out[k] = v.length > 180 ? `${v.slice(0, 180)}...` : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function postHaAuditLog(level, message, extra = {}) {
  if (!HA_AUDIT_LOG_ENABLED) return;
  const eventLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const minLevel = LOG_LEVELS[HA_AUDIT_LOG_LEVEL] ?? LOG_LEVELS.warn;
  if (eventLevel < minLevel) return;

  const sanitized = sanitizeAuditExtra(extra);
  const details = Object.keys(sanitized).length ? ` | ${JSON.stringify(sanitized)}` : "";
  const logbookPayload = {
    name: HA_AUDIT_LOG_NAME || "HA IMAP Tracker",
    message: `[${level}] ${message}${details}`.slice(0, 1024)
  };
  if (HA_AUDIT_LOG_ENTITY_ID) logbookPayload.entity_id = HA_AUDIT_LOG_ENTITY_ID;

  try {
    await callHAService("logbook", "log", logbookPayload);
  } catch (e) {
    logAt("warn", "ha_audit_log_failed", {
      error: String(e.message || e),
      audit_message: message
    });
  }
}

function postHaAuditLogSafe(level, message, extra = {}) {
  postHaAuditLog(level, message, extra).catch(() => { });
}

function logAt(level, message, extra = {}) {
  const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const current = LOG_LEVELS[APP_LOG_LEVEL] ?? LOG_LEVELS.info;
  if (target < current) return;
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "local";
  const payload = {
    ts_utc: now.toISOString(),
    ts_local: localIsoWithOffset(now),
    timezone,
    level,
    msg: message,
    ...extra
  };
  const line = `[APP] ${JSON.stringify(payload)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function hasTelegramMiniAppConfig() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_SESSION_SECRET && TELEGRAM_ACCESS_FILE);
}

function normalizeTelegramOwner(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTelegramAccessEntry(entry) {
  const telegramUserId = Number(entry?.telegram_user_id ?? entry?.telegramUserId ?? entry?.user_id ?? entry?.userId);
  if (!Number.isFinite(telegramUserId) || telegramUserId <= 0) return null;

  const ownersRaw = Array.isArray(entry?.owners) ? entry.owners : [entry?.owner];
  const owners = [...new Set(ownersRaw.map((value) => normalizeTelegramOwner(value)).filter(Boolean))];
  if (!owners.length) return null;

  const defaultChatId = String(entry?.default_chat_id ?? entry?.defaultChatId ?? entry?.telegram_chat_id ?? "").trim() || null;
  return {
    telegram_user_id: telegramUserId,
    default_chat_id: defaultChatId,
    owners,
    label: String(entry?.label || entry?.name || "").trim() || null,
    active: maybeBool(entry?.active) !== false
  };
}

function loadTelegramAccessEntries() {
  if (!TELEGRAM_ACCESS_FILE) return [];
  try {
    if (!fs.existsSync(TELEGRAM_ACCESS_FILE)) return [];
    const raw = fs.readFileSync(TELEGRAM_ACCESS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [];
    return items
      .map((entry) => normalizeTelegramAccessEntry(entry))
      .filter((entry) => entry && entry.active);
  } catch (e) {
    logAt("error", "telegram_access_file_invalid", {
      file: TELEGRAM_ACCESS_FILE,
      error: String(e.message || e)
    });
    return [];
  }
}

function telegramAccessForUserId(userIdRaw) {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return loadTelegramAccessEntries().find((entry) => entry.telegram_user_id === userId) || null;
}

function normalizeHaOwnerAccessEntry(entry) {
  const haUserId = String(entry?.ha_user_id ?? entry?.haUserId ?? entry?.user_id ?? entry?.userId ?? "").trim();
  if (!haUserId) return null;

  const ownersRaw = Array.isArray(entry?.owners) ? entry.owners : [entry?.owner];
  const owners = [...new Set(ownersRaw.map((value) => normalizeTelegramOwner(value)).filter(Boolean))];
  if (!owners.length) return null;

  return {
    ha_user_id: haUserId,
    owners,
    label: String(entry?.label || entry?.name || "").trim() || null,
    active: maybeBool(entry?.active) !== false
  };
}

function loadHaOwnerAccessEntries() {
  if (!HA_USER_OWNERS_FILE) return [];
  try {
    if (!fs.existsSync(HA_USER_OWNERS_FILE)) return [];
    const raw = fs.readFileSync(HA_USER_OWNERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [];
    return items
      .map((entry) => normalizeHaOwnerAccessEntry(entry))
      .filter((entry) => entry && entry.active);
  } catch (e) {
    logAt("error", "ha_owner_access_file_invalid", {
      file: HA_USER_OWNERS_FILE,
      error: String(e.message || e)
    });
    return [];
  }
}

function headerValue(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const target = String(key || "").toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name || "").toLowerCase() !== target) continue;
    if (Array.isArray(value)) return String(value[0] || "").trim();
    return String(value || "").trim();
  }
  return "";
}

function haOwnerAccessFromHeaders(headers, entries = loadHaOwnerAccessEntries()) {
  const haUserId = headerValue(headers, "x-remote-user-id");
  if (!haUserId) {
    return {
      via_ingress: false,
      mapped: false,
      ha_user_id: null,
      display_name: null,
      owners: []
    };
  }

  const displayName = headerValue(headers, "x-remote-user-display-name") || headerValue(headers, "x-remote-user-name") || null;
  const access = Array.isArray(entries) ? entries.find((entry) => entry.ha_user_id === haUserId) || null : null;
  return {
    via_ingress: true,
    mapped: !!access,
    ha_user_id: haUserId,
    display_name: displayName,
    owners: access?.owners || [],
    label: access?.label || null
  };
}

function filterOwnersForHaIngress(owners, access) {
  if (!access?.via_ingress || !access?.mapped) return owners;
  const allowedOwners = new Set((access.owners || []).map((owner) => normalizeTelegramOwner(owner)).filter(Boolean));
  return owners.filter((entry) => allowedOwners.has(normalizeTelegramOwner(entry?.owner)));
}

function canViewHaIngressDebug(access, owner = RAW_DEBUG_OWNER) {
  if (!access?.via_ingress || !access?.mapped) return false;
  const target = normalizeTelegramOwner(owner);
  return !!target && (access.owners || []).includes(target);
}

function enforceHaIngressOwnerAccess(req, res, next) {
  const access = haOwnerAccessFromHeaders(req.headers);
  req.haIngressAccess = access;

  if (!access.via_ingress) return next();
  if (!access.mapped) {
    const payload = {
      req_id: req.reqId,
      ha_user_id: access.ha_user_id,
      display_name: access.display_name,
      path: req.originalUrl,
      error: "ha_user_not_allowed"
    };
    logAt("warn", "ha_ingress_user_denied", payload);
    postHaAuditLogSafe("warn", "ha_ingress_user_denied", payload);
    return res.status(403).json({ ok: false, error: "ha_user_not_allowed" });
  }

  const owner = normalizeTelegramOwner(req.params.owner);
  if (!owner || access.owners.includes(owner)) return next();

  const payload = {
    req_id: req.reqId,
    ha_user_id: access.ha_user_id,
    display_name: access.display_name,
    owner,
    path: req.originalUrl,
    error: "ha_owner_not_allowed"
  };
  logAt("warn", "ha_ingress_owner_denied", payload);
  postHaAuditLogSafe("warn", "ha_ingress_owner_denied", payload);
  return res.status(403).json({ ok: false, error: "ha_owner_not_allowed" });
}

function safeCompareHex(a, b) {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");
  if (!left.length || !right.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseTelegramInitData(initDataRaw, opts = {}) {
  const initData = String(initDataRaw || "").trim();
  const botToken = String(opts.botToken || TELEGRAM_BOT_TOKEN || "").trim();
  const maxAgeSec = Number.isFinite(Number(opts.maxAgeSec)) ? Number(opts.maxAgeSec) : TELEGRAM_INIT_DATA_MAX_AGE_SEC;
  if (!initData) return { ok: false, error: "init_data_missing" };
  if (!botToken) return { ok: false, error: "telegram_bot_token_missing" };

  const params = new URLSearchParams(initData);
  const hash = String(params.get("hash") || "").trim().toLowerCase();
  if (!hash) return { ok: false, error: "hash_missing" };

  const authDate = Number(params.get("auth_date") || 0);
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: "auth_date_invalid" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Number.isFinite(maxAgeSec) && maxAgeSec > 0 && nowSec - authDate > maxAgeSec) {
    return { ok: false, error: "init_data_expired" };
  }

  const entries = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    entries.push([key, value]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!safeCompareHex(hash, expectedHash)) return { ok: false, error: "hash_mismatch" };

  let user = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch (_e) {
      return { ok: false, error: "user_payload_invalid" };
    }
  }
  const userId = Number(user?.id);
  if (!Number.isFinite(userId) || userId <= 0) return { ok: false, error: "user_id_missing" };

  return {
    ok: true,
    auth_date: authDate,
    user,
    user_id: userId,
    query_id: String(params.get("query_id") || "").trim() || null,
    chat_type: String(params.get("chat_type") || "").trim() || null,
    start_param: String(params.get("start_param") || "").trim() || null
  };
}

function base64UrlEncode(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function createTelegramSessionToken(payload, secret = TELEGRAM_SESSION_SECRET) {
  const body = base64UrlEncode(JSON.stringify(payload || {}));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyTelegramSessionToken(token, secret = TELEGRAM_SESSION_SECRET) {
  const raw = String(token || "").trim();
  const [body, signature] = raw.split(".");
  if (!body || !signature || !secret) return { ok: false, error: "session_invalid" };

  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { ok: false, error: "session_signature_invalid" };
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body));
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = Number(payload?.exp || 0);
    if (!Number.isFinite(exp) || exp <= nowSec) return { ok: false, error: "session_expired" };
    return { ok: true, payload };
  } catch (_e) {
    return { ok: false, error: "session_payload_invalid" };
  }
}

function parseCookieHeader(req) {
  const raw = String(req.get("cookie") || "");
  const out = {};
  for (const piece of raw.split(/;\s*/)) {
    if (!piece) continue;
    const idx = piece.indexOf("=");
    if (idx <= 0) continue;
    const key = piece.slice(0, idx).trim();
    const value = piece.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }
  const next = Array.isArray(current) ? [...current, cookieValue] : [current, cookieValue];
  res.setHeader("Set-Cookie", next);
}

function requestWantsSecureCookie(req) {
  if (req.secure) return true;
  const forwardedProto = String(req.get("x-forwarded-proto") || "").trim().toLowerCase();
  return forwardedProto === "https";
}

function setTelegramSessionCookie(req, res, token) {
  const parts = [
    `${TELEGRAM_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(60, TELEGRAM_SESSION_TTL_SEC)}`
  ];
  if (requestWantsSecureCookie(req)) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

function clearTelegramSessionCookie(req, res) {
  const parts = [
    `${TELEGRAM_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (requestWantsSecureCookie(req)) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

function readTelegramSession(req) {
  const cookies = parseCookieHeader(req);
  const token = String(cookies[TELEGRAM_SESSION_COOKIE] || "").trim();
  if (!token) return { ok: false, error: "session_missing" };
  return verifyTelegramSessionToken(token);
}

function isTelegramPublicRequest(req) {
  const pathname = String(req.path || "");
  return (
    pathname === "/telegram/app" ||
    pathname.startsWith("/telegram/app/") ||
    pathname.startsWith("/api/telegram/") ||
    pathname === "/api/telegram/session" ||
    pathname === "/api/telegram/logout"
  );
}

function requireTelegramSession(req, res, next) {
  const session = readTelegramSession(req);
  if (!session.ok) {
    return res.status(401).json({ ok: false, error: session.error || "telegram_session_invalid" });
  }

  const payload = session.payload || {};
  const access = telegramAccessForUserId(payload.telegram_user_id);
  if (!access) {
    clearTelegramSessionCookie(req, res);
    return res.status(403).json({ ok: false, error: "telegram_user_not_allowed" });
  }

  req.telegramSession = {
    telegram_user_id: payload.telegram_user_id,
    display_name: payload.display_name || "Telegram",
    username: payload.username || null,
    owners: access.owners,
    default_chat_id: access.default_chat_id || null,
    label: access.label || null
  };
  next();
}

app.use((req, res, next) => {
  const started = Date.now();
  const reqId = `${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req.reqId = reqId;
  res.on("finish", () => {
    const ms = Date.now() - started;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logAt(level, "http_request_end", {
      req_id: reqId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: ms
    });
  });
  next();
});

// Optional API protection: when APP_API_KEY is set, every endpoint except health/build requires it.
app.use((req, res, next) => {
  if (!APP_API_KEY) return next();
  if (req.path === "/health" || req.path === "/api/_build" || isTelegramPublicRequest(req)) return next();

  const provided = extractRequestApiKey(req);
  if (provided && provided === APP_API_KEY) return next();

  const payload = {
    req_id: req.reqId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip
  };
  logAt("warn", "api_auth_failed", payload);
  postHaAuditLogSafe("warn", "api_auth_failed", payload);
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

app.use("/api/owner/:owner", enforceHaIngressOwnerAccess);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/_build", (_req, res) => res.json({ ok: true, build: APP_VERSION, has_trackings: true }));

// La mini app de Telegram valida initData en backend y crea una sesión corta
// firmada propia; no comparte auth con Home Assistant ni con APP_API_KEY.
app.post("/api/telegram/session", express.json({ limit: "32kb" }), (req, res) => {
  if (!hasTelegramMiniAppConfig()) {
    return res.status(503).json({
      ok: false,
      error: "telegram_miniapp_not_configured"
    });
  }

  const initData = String(req.body?.init_data || req.body?.initData || "").trim();
  const parsed = parseTelegramInitData(initData);
  if (!parsed.ok) {
    const payload = {
      req_id: req.reqId,
      error: parsed.error
    };
    logAt("warn", "telegram_session_rejected", payload);
    postHaAuditLogSafe("warn", "telegram_session_rejected", payload);
    return res.status(401).json({ ok: false, error: parsed.error });
  }

  const access = telegramAccessForUserId(parsed.user_id);
  if (!access) {
    const payload = {
      req_id: req.reqId,
      telegram_user_id: parsed.user_id,
      error: "telegram_user_not_allowed"
    };
    logAt("warn", "telegram_session_user_denied", payload);
    postHaAuditLogSafe("warn", "telegram_session_user_denied", payload);
    return res.status(403).json({ ok: false, error: "telegram_user_not_allowed" });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const token = createTelegramSessionToken({
    telegram_user_id: parsed.user_id,
    owners: access.owners,
    username: String(parsed.user?.username || "").trim() || null,
    display_name: telegramDisplayNameFromUser(parsed.user),
    iat: nowSec,
    exp: nowSec + Math.max(300, TELEGRAM_SESSION_TTL_SEC)
  });
  setTelegramSessionCookie(req, res, token);

  const response = {
    ok: true,
    telegram_user_id: parsed.user_id,
    display_name: telegramDisplayNameFromUser(parsed.user),
    owners: access.owners,
    public_base_url: TELEGRAM_PUBLIC_BASE_URL || null
  };
  logAt("info", "telegram_session_created", {
    req_id: req.reqId,
    telegram_user_id: parsed.user_id,
    owners: access.owners
  });
  return res.json(response);
});

app.post("/api/telegram/logout", (req, res) => {
  clearTelegramSessionCookie(req, res);
  return res.json({ ok: true });
});

app.use("/api/telegram", (req, res, next) => {
  if (req.path === "/session" || req.path === "/logout") return next();
  return requireTelegramSession(req, res, next);
});

app.get("/api/telegram/me", (req, res) => {
  return res.json({
    ok: true,
    telegram_user_id: req.telegramSession.telegram_user_id,
    display_name: req.telegramSession.display_name,
    username: req.telegramSession.username,
    owners: req.telegramSession.owners,
    default_chat_id: req.telegramSession.default_chat_id,
    public_base_url: TELEGRAM_PUBLIC_BASE_URL || null
  });
});

app.get("/api/telegram/trackings", (req, res) => {
  const store = loadStore();
  let removed = 0;
  for (const owner of req.telegramSession.owners) {
    removed += applyDeliveredRetentionForOwner(store, owner, new Date()).removed;
  }
  if (removed > 0) saveStore(store);

  const result = listTelegramTrackings(store, req.telegramSession.owners, {
    status: req.query?.status,
    courier: req.query?.courier,
    alias: req.query?.alias,
    sort: req.query?.sort
  });

  return res.json({
    ok: true,
    owners: req.telegramSession.owners,
    count: result.items.length,
    couriers: result.couriers,
    items: result.items
  });
});

app.get("/api/telegram/imap/status", (req, res) => {
  return res.json({
    ok: true,
    running: imapManualRefreshState.running,
    pid: imapManualRefreshState.pid,
    last_started_at: imapManualRefreshState.last_started_at,
    last_finished_at: imapManualRefreshState.last_finished_at,
    last_exit_code: imapManualRefreshState.last_exit_code,
    last_error: imapManualRefreshState.last_error
  });
});

app.get("/api/ui/imap/status", (req, res) => {
  const access = haOwnerAccessFromHeaders(req.headers);
  if (access.via_ingress && !access.mapped) {
    return res.status(403).json({ ok: false, error: "ha_user_not_allowed" });
  }
  return res.json({
    ok: true,
    running: imapManualRefreshState.running,
    pid: imapManualRefreshState.pid,
    last_started_at: imapManualRefreshState.last_started_at,
    last_finished_at: imapManualRefreshState.last_finished_at,
    last_exit_code: imapManualRefreshState.last_exit_code,
    last_error: imapManualRefreshState.last_error
  });
});

app.get("/api/ui/raw", (req, res) => {
  const access = haOwnerAccessFromHeaders(req.headers);
  if (!canViewHaIngressDebug(access, RAW_DEBUG_OWNER)) {
    const payload = {
      req_id: req.reqId,
      ha_user_id: access.ha_user_id,
      display_name: access.display_name,
      path: req.originalUrl,
      error: "ha_debug_not_allowed"
    };
    logAt("warn", "ha_ingress_raw_debug_denied", payload);
    postHaAuditLogSafe("warn", "ha_ingress_raw_debug_denied", payload);
    return res.status(403).json({ ok: false, error: "ha_debug_not_allowed" });
  }

  const store = loadStore();
  applyDeliveredRetentionForAllOwnersAndPersist(store, { reqId: req.reqId });
  const owner = RAW_DEBUG_OWNER;
  const rawOwner = getOwner(store, owner);
  const allowedPayload = {
    req_id: req.reqId,
    ha_user_id: access.ha_user_id,
    display_name: access.display_name,
    owner
  };
  logAt("info", "ha_ingress_raw_debug_opened", allowedPayload);
  postHaAuditLogSafe("info", "ha_ingress_raw_debug_opened", allowedPayload);
  return res.json({
    ok: true,
    owner,
    data: rawOwner || {
      trackings: [],
      meta: {},
      last: {},
      imap_accounts: [],
      imap_ignore_rules: []
    }
  });
});

function clearOwnerStoreData(store, ownerRaw) {
  const owner = String(ownerRaw || "").trim().toLowerCase();
  const o = getOwner(store, owner);
  if (!o) {
    return {
      ok: true,
      owner,
      removed: false,
      removed_trackings: 0,
      removed_meta: 0,
      removed_last: 0,
      removed_imap_accounts: 0,
      removed_ignore_rules: 0
    };
  }

  const removedTrackings = ownerTrackings(o).length;
  const removedMeta = o?.meta && typeof o.meta === "object" ? Object.keys(o.meta).length : 0;
  const removedLast = o?.last && typeof o.last === "object" ? Object.keys(o.last).length : 0;
  const removedImapAccounts = Array.isArray(o?.imap_accounts) ? o.imap_accounts.length : 0;
  const removedIgnoreRules = Array.isArray(o?.imap_ignore_rules) ? o.imap_ignore_rules.length : 0;

  if (store?.owners && typeof store.owners === "object") {
    delete store.owners[owner];
  }

  return {
    ok: true,
    owner,
    removed: true,
    removed_trackings: removedTrackings,
    removed_meta: removedMeta,
    removed_last: removedLast,
    removed_imap_accounts: removedImapAccounts,
    removed_ignore_rules: removedIgnoreRules
  };
}

app.post("/api/ui/raw/clear_owner", (req, res) => {
  const access = haOwnerAccessFromHeaders(req.headers);
  if (!canViewHaIngressDebug(access, RAW_DEBUG_OWNER)) {
    const payload = {
      req_id: req.reqId,
      ha_user_id: access.ha_user_id,
      display_name: access.display_name,
      path: req.originalUrl,
      error: "ha_debug_not_allowed"
    };
    logAt("warn", "ha_ingress_raw_debug_denied", payload);
    postHaAuditLogSafe("warn", "ha_ingress_raw_debug_denied", payload);
    return res.status(403).json({ ok: false, error: "ha_debug_not_allowed" });
  }

  const store = loadStore();
  const owner = RAW_DEBUG_OWNER;
  const result = clearOwnerStoreData(store, owner);
  saveStore(store);

  const payload = {
    req_id: req.reqId,
    ha_user_id: access.ha_user_id,
    display_name: access.display_name,
    owner,
    removed: result.removed,
    removed_trackings: result.removed_trackings,
    removed_meta: result.removed_meta,
    removed_last: result.removed_last,
    removed_imap_accounts: result.removed_imap_accounts,
    removed_ignore_rules: result.removed_ignore_rules
  };
  logAt("warn", "ha_ingress_raw_debug_owner_cleared", payload);
  postHaAuditLogSafe("warn", "ha_ingress_raw_debug_owner_cleared", payload);

  return res.json(result);
});

app.post("/api/telegram/imap/refresh", (req, res) => {
  const result = triggerManualImapRefresh({
    source: "telegram_miniapp",
    telegram_user_id: req.telegramSession.telegram_user_id,
    owners: req.telegramSession.owners
  });

  const status = result.ok ? 200 : 503;
  return res.status(status).json(result);
});

app.post("/api/ui/imap/refresh", (req, res) => {
  const access = haOwnerAccessFromHeaders(req.headers);
  if (access.via_ingress && !access.mapped) {
    return res.status(403).json({ ok: false, error: "ha_user_not_allowed" });
  }

  const result = triggerManualImapRefresh({
    source: "ingress_ui",
    ha_user_id: access.ha_user_id || null,
    owners: access.owners || []
  });

  const status = result.ok ? 200 : 503;
  return res.status(status).json(result);
});

app.post("/api/telegram/tracking/:owner/:tracking/delivered", (req, res) => {
  const owner = normalizeTelegramOwner(req.params.owner);
  const tracking = normalizeTracking(req.params.tracking);
  if (!req.telegramSession.owners.includes(owner)) {
    return res.status(403).json({ ok: false, error: "telegram_owner_not_allowed" });
  }

  const store = loadStore();
  const result = setTrackingDeliveredOverride(store, owner, tracking, true);
  if (!result.ok) return res.status(result.status).json(result);
  saveStore(store);

  logAt("info", "telegram_tracking_marked_delivered", {
    req_id: req.reqId,
    telegram_user_id: req.telegramSession.telegram_user_id,
    owner,
    tracking
  });

  return res.json({
    ok: true,
    owner,
    tracking,
    delivered_override: true
  });
});

app.post("/api/telegram/tracking/:owner/:tracking/not_package", (req, res) => {
  const owner = normalizeTelegramOwner(req.params.owner);
  const tracking = normalizeTracking(req.params.tracking);
  if (!req.telegramSession.owners.includes(owner)) {
    return res.status(403).json({ ok: false, error: "telegram_owner_not_allowed" });
  }

  const store = loadStore();
  const result = markTrackingAsNotPackage(store, owner, tracking);
  if (!result.ok) return res.status(result.status).json(result);

  const o = getOwner(store, owner);
  if (ownerIsEmpty(o)) delete store.owners[owner];
  else store.owners[owner] = o;
  saveStore(store);

  logAt("info", "telegram_tracking_marked_not_package", {
    req_id: req.reqId,
    telegram_user_id: req.telegramSession.telegram_user_id,
    owner,
    tracking
  });

  return res.json(result);
});

function normalizePackageSource(sourceRaw, fallback = DEFAULT_PACKAGE_SOURCE) {
  const s = String(sourceRaw || "").trim().toLowerCase();
  if (!s) return fallback;
  return PACKAGE_SOURCES.has(s) ? s : null;
}

function maybeBool(v) {
  if (v === true || v === false) return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return undefined;
}

function parseIsoOrNull(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function detectImapOutForDelivery(status, subStatus, description) {
  const s = String(status || "").toLowerCase();
  const sub = String(subStatus || "").toLowerCase();
  const d = String(description || "").toLowerCase();
  return (
    s.includes("outfordelivery") ||
    s.includes("out_for_delivery") ||
    s.includes("en reparto") ||
    sub.includes("outfordelivery") ||
    sub.includes("out_for_delivery") ||
    sub.includes("en reparto") ||
    d.includes("out for delivery") ||
    d.includes("en reparto")
  );
}

function detectImapDelivered(status, subStatus, description) {
  const s = String(status || "").toLowerCase();
  const sub = String(subStatus || "").toLowerCase();
  const d = String(description || "").toLowerCase();
  const looksDelivered = (
    s.includes("delivered") ||
    s.includes("entregado") ||
    sub.includes("delivered") ||
    sub.includes("entregado") ||
    d.includes("delivered") ||
    d.includes("entregado")
  );
  const looksOfd = detectImapOutForDelivery(status, subStatus, description) || d.includes("being delivered");
  return looksDelivered && !looksOfd;
}

function normalizeImapSnapshot(item, tracking, accountEmail = "") {
  const status = String(item?.status || "").trim();
  const subStatus = String(item?.sub_status || item?.subStatus || "").trim();
  const description = String(item?.description || item?.desc || "").trim();
  const location = String(item?.location || "").trim();
  const carrierName = String(item?.carrier_name || item?.carrierName || "").trim();
  const subject = String(item?.subject || item?.email_subject || "").trim();
  const sender = String(item?.sender || item?.email_sender || "").trim();
  const timeIso = parseIsoOrNull(item?.time_iso || item?.time || item?.event_time);
  const forcedOutForDelivery = maybeBool(item?.is_out_for_delivery ?? item?.isOutForDelivery);
  const forcedDelivered = maybeBool(item?.is_delivered ?? item?.isDelivered);
  const isOutForDelivery = forcedOutForDelivery ?? detectImapOutForDelivery(status, subStatus, description);
  const isDelivered = forcedDelivered ?? detectImapDelivered(status, subStatus, description);

  return {
    number: tracking,
    carrierKey: null,
    carrierName: carrierName || null,
    carrierCountry: null,
    source: "imap",
    sourceAccount: accountEmail || null,
    latest: {
      status: status || null,
      subStatus: subStatus || null,
      description: description || null,
      time: timeIso,
      location: location || null,
      subject: subject || description || null,
      sender: sender || null
    },
    flags: {
      isOutForDelivery: !!isOutForDelivery,
      isDelivered: !!isDelivered
    }
  };
}

function inferImapProvider(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e.includes("@")) return "generic";
  const domain = e.split("@")[1] || "";
  if (domain.includes("gmail.com") || domain.includes("googlemail.com")) return "gmail";
  if (domain.includes("outlook.") || domain.includes("hotmail.") || domain.includes("live.") || domain.includes("microsoft")) return "outlook";
  return "generic";
}

// ---- Background scheduler (Step 3) ----
// Enable with: BG_ENABLED=1 (also accepts true/yes/on)
// Interval: BG_INTERVAL_MIN (default 15)
// Refresh policy: BG_NORMAL_INTERVAL_MIN (default 45), BG_SLOW_HOURS (default "8,20")
// Rate limit between trackings: BG_DELAY_MS (default 0 in IMAP-only mode)
// Delivered retention: DELIVERED_RETENTION_DAYS (default 7, <=0 disables auto-removal)
// Home Assistant notify target:
//   HA_URL (e.g. http://homeassistant:8123 or http://192.168.x.x:8123)
//   HA_TOKEN (Long-Lived Access Token)
//   HA_SCRIPT (script entity/service name without domain, default: jarvis_17track_notify)

const BG_ENABLED_RAW = process.env.BG_ENABLED;
const BG_ENABLED = boolFromAny(BG_ENABLED_RAW, false);
const BG_INTERVAL_MIN = Number(process.env.BG_INTERVAL_MIN || 15);
const BG_NORMAL_INTERVAL_MIN = Number(process.env.BG_NORMAL_INTERVAL_MIN || 45);
const BG_SLOW_HOURS = String(process.env.BG_SLOW_HOURS || "8,20")
  .split(",")
  .map((x) => Number(String(x).trim()))
  .filter((n) => !isNaN(n));
const BG_DELAY_MS = Number(process.env.BG_DELAY_MS || 0);
const DELIVERED_RETENTION_DAYS = Number(process.env.DELIVERED_RETENTION_DAYS || 7);

const HA_URL = String(process.env.HA_URL || "").trim().replace(/\/$/, "");
const HA_TOKEN = String(process.env.HA_TOKEN || "").trim();
const HA_SCRIPT = String(process.env.HA_SCRIPT || "jarvis_17track_notify").trim();

async function callHAService(domain, service, data) {
  if (!HA_URL || !HA_TOKEN) {
    throw new Error("HA_URL/HA_TOKEN no configurados");
  }

  const url = `${HA_URL}/api/services/${domain}/${service}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data || {})
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    logAt("error", "ha_service_call_failed", {
      domain,
      service,
      status: r.status,
      body: txt.slice(0, 500)
    });
    throw new Error(`HA call failed ${r.status}: ${txt}`);
  }

  // HA returns an array; we don't really need it.
  return await r.json().catch(() => ({}));
}

// Background runtime state
const bgState = {
  enabled: BG_ENABLED,
  running: false,
  intervalId: null,
  lastRunAt: null,
  lastError: null,
  lastSummary: null
};

const imapManualRefreshState = {
  running: false,
  pid: null,
  last_started_at: null,
  last_finished_at: null,
  last_exit_code: null,
  last_error: null,
  last_trigger: null
};

function isPositiveNumber(n) {
  return Number.isFinite(n) && n > 0;
}

function isNonNegativeNumber(n) {
  return Number.isFinite(n) && n >= 0;
}

function validateStartupConfig() {
  const missing = [];
  if (!HA_URL) missing.push("HA_URL");
  if (!HA_TOKEN) missing.push("HA_TOKEN");
  if (!HA_SCRIPT) missing.push("HA_SCRIPT");

  const invalid = [];
  if (!isPositiveNumber(Number(process.env.PORT || 8787))) invalid.push("PORT");
  if (!isPositiveNumber(BG_INTERVAL_MIN)) invalid.push("BG_INTERVAL_MIN");
  if (!isPositiveNumber(BG_NORMAL_INTERVAL_MIN)) invalid.push("BG_NORMAL_INTERVAL_MIN");
  if (!isNonNegativeNumber(BG_DELAY_MS)) invalid.push("BG_DELAY_MS");
  if (!(Number.isFinite(DELIVERED_RETENTION_DAYS) && DELIVERED_RETENTION_DAYS >= 0)) invalid.push("DELIVERED_RETENTION_DAYS");

  const allowedLogLevels = new Set(Object.keys(LOG_LEVELS));
  if (!allowedLogLevels.has(HA_AUDIT_LOG_LEVEL)) invalid.push("HA_AUDIT_LOG_LEVEL");

  if (missing.length || invalid.length) {
    const details = {
      missing,
      invalid,
      hint: "Revisa la configuración del add-on y completa todos los campos requeridos."
    };
    console.error(`[BOOT] Invalid configuration: ${JSON.stringify(details)}`);
    process.exit(1);
  }

  if (APP_API_KEY) {
    logAt("warn", "api_key_auth_enabled", {
      hint: "Incluye X-API-Key o Authorization: Bearer <key> en los clientes."
    });
  }

  const telegramFieldsPresent = [TELEGRAM_BOT_TOKEN, TELEGRAM_SESSION_SECRET, TELEGRAM_ACCESS_FILE]
    .filter(Boolean)
    .length;
  if (telegramFieldsPresent > 0 && !hasTelegramMiniAppConfig()) {
    logAt("warn", "telegram_miniapp_partial_config", {
      bot_token: !!TELEGRAM_BOT_TOKEN,
      session_secret: !!TELEGRAM_SESSION_SECRET,
      access_file: TELEGRAM_ACCESS_FILE || null
    });
  }

  logAt("info", "startup_config_ok", {
    app_version: APP_VERSION,
    bg_enabled: BG_ENABLED,
    bg_enabled_raw: BG_ENABLED_RAW ?? null,
    bg_interval_min: BG_INTERVAL_MIN,
    bg_normal_interval_min: BG_NORMAL_INTERVAL_MIN,
    bg_slow_hours: BG_SLOW_HOURS,
    bg_delay_ms: BG_DELAY_MS,
    delivered_retention_days: DELIVERED_RETENTION_DAYS,
    ha_configured: !!(HA_URL && HA_TOKEN),
    json_limit: APP_JSON_LIMIT,
    ha_audit_log_enabled: HA_AUDIT_LOG_ENABLED,
    ha_audit_log_level: HA_AUDIT_LOG_LEVEL,
    ha_user_owners_file: HA_USER_OWNERS_FILE || null,
    telegram_miniapp_configured: hasTelegramMiniAppConfig(),
    telegram_public_base_url: TELEGRAM_PUBLIC_BASE_URL || null
  });
}
function ownersFromStore(store) {
  const owners = store?.owners && typeof store.owners === "object" ? store.owners : {};
  return Object.keys(owners);
}

function getAnnouncedMap(o) {
  // Tracks which tracking numbers have already been announced as "out for delivery".
  // Structure: o.announced = { out_for_delivery: { "TN": true, ... } }
  o.announced = o.announced && typeof o.announced === "object" ? o.announced : {};
  o.announced.out_for_delivery = o.announced.out_for_delivery && typeof o.announced.out_for_delivery === "object" ? o.announced.out_for_delivery : {};
  return o.announced.out_for_delivery;
}

function buildOwnerDeliveryMessage(ownerKey, newOnes) {
  // newOnes: array of normalized "one" objects
  const lines = newOnes.map((one) => {
    const tn = one?.number || "";
    const desc = one?.latest?.description || one?.latest?.status || "(sin datos)";
    const carrier = one?.carrierName || "";
    const loc = one?.latest?.location || "";
    const extra = [carrier, loc].filter(Boolean).join(" · ");
    return `- ${tn}: ${desc}${extra ? ` — ${extra}` : ""}`;
  });

  return `📦 Paquete(s) en reparto (${ownerKey}):\n${lines.join("\n")}`;
}

async function refreshTrackingBySource(o, ownerKey, tn, now = new Date()) {
  const source = trackingSource(o, tn);

  if (source === "imap") {
    const last = ownerLastMap(o);
    const one = last?.[tn];
    if (one) {
      saveTrackingLastSnapshot(o, tn, one, null, now);
      return { tracking: tn, source, ok: true, one, mode: "push" };
    }
    const err = "imap_pending_ingest";
    saveTrackingLastSnapshot(o, tn, null, err, now);
    const payload = { owner: ownerKey, tracking: tn, source, error: err };
    logAt("warn", "tracking_refresh_imap_pending_ingest", payload);
    postHaAuditLogSafe("warn", "tracking_refresh_imap_pending_ingest", payload);
    return { tracking: tn, source, ok: false, error: err, mode: "push" };
  }

  const err = `source_not_supported:${source}`;
  saveTrackingLastSnapshot(o, tn, null, err, now);
  const payload = { owner: ownerKey, tracking: tn, source, error: err };
  logAt("warn", "tracking_source_not_supported", payload);
  postHaAuditLogSafe("warn", "tracking_source_not_supported", payload);
  return { tracking: tn, source, ok: false, error: err };
}

async function refreshOwnerPolicy(o, ownerKey, now, opts) {
  const decision = shouldRefreshOwnerNow(o, now, {
    normalIntervalMin: opts.normalIntervalMin,
    slowHours: opts.slowHours
  });

  if (!decision.should) {
    return { refreshed: false, decision, results: [] };
  }

  const trackings = ownerTrackings(o);
  const results = [];

  for (let i = 0; i < trackings.length; i++) {
    const tn = trackings[i];
    const r = await refreshTrackingBySource(o, ownerKey, tn, now);
    results.push(r);

    if (i < trackings.length - 1) await sleep(opts.delayMs);
  }

  // bookkeeping timestamps
  o.last_checked_at = now.toISOString();
  if (decision.mode === "slow") {
    o.last_full_refresh_at = now.toISOString();
  }

  return { refreshed: true, decision, results };
}

function detectNewOutForDelivery(o, prevLast) {
  const announced = getAnnouncedMap(o);
  const nowLast = ownerLastMap(o);

  const newOnes = [];

  for (const tn of Object.keys(nowLast)) {
    const one = nowLast[tn];
    if (!one) continue;

    const isOFD = effectiveIsOutForDelivery(one);
    if (!isOFD) {
      // If it is no longer out for delivery, clear announced so it can re-trigger if it goes back to OFD.
      if (announced[tn]) delete announced[tn];
      continue;
    }

    // If already announced, skip
    if (announced[tn]) continue;

    // If previously out for delivery, skip (extra safety)
    const prevOne = prevLast?.[tn];
    const wasOFD = prevOne ? effectiveIsOutForDelivery(prevOne) : false;
    if (wasOFD) {
      announced[tn] = true;
      continue;
    }

    // New transition
    announced[tn] = true;
    newOnes.push(one);
  }

  return newOnes;
}

async function bgRunOnce() {
  if (bgState.running) return { ok: false, skipped: true, reason: "already_running" };
  bgState.running = true;
  bgState.lastError = null;

  const started = new Date();
  bgState.lastRunAt = started.toISOString();

  try {
    const store = loadStore();
    const ownerKeys = ownersFromStore(store);

    const summary = {
      owners_total: ownerKeys.length,
      owners_refreshed: 0,
      owners_skipped: 0,
      delivered_pruned: 0,
      notifications_sent: 0,
      notified: []
    };

    for (const ownerKey of ownerKeys) {
      const retention = applyDeliveredRetentionForOwner(store, ownerKey, new Date());
      if (retention.removed > 0) {
        summary.delivered_pruned += retention.removed;
        logAt("info", "delivered_retention_pruned", {
          owner: ownerKey,
          removed: retention.removed,
          retention_days: DELIVERED_RETENTION_DAYS
        });
        saveStore(store);
      }

      const o = store.owners[ownerKey];
      if (!o || typeof o !== "object") continue;

      // If no trackings, skip
      const tns = ownerTrackings(o);
      if (tns.length === 0) {
        summary.owners_skipped++;
        continue;
      }

      const prevLast = { ...(o.last && typeof o.last === "object" ? o.last : {}) };

      const r = await refreshOwnerPolicy(o, ownerKey, new Date(), {
        delayMs: BG_DELAY_MS,
        normalIntervalMin: BG_NORMAL_INTERVAL_MIN,
        slowHours: BG_SLOW_HOURS
      });

      if (!r.refreshed) {
        summary.owners_skipped++;
        continue;
      }

      summary.owners_refreshed++;

      // Detect new transitions to out-for-delivery
      const newOnes = detectNewOutForDelivery(o, prevLast);
      if (newOnes.length > 0) {
        const message = buildOwnerDeliveryMessage(ownerKey, newOnes);

        // Notify HA via a single script, HA decides voice vs telegram based on presence.
        await callHAService("script", HA_SCRIPT, {
          owner: ownerKey,
          message,
          trackings: newOnes.map((x) => x?.number).filter(Boolean)
        });

        summary.notifications_sent++;
        summary.notified.push({ owner: ownerKey, count: newOnes.length });
      }

      // Save owner changes after each owner to persist announced map and last timestamps.
      store.owners[ownerKey] = o;
      saveStore(store);
    }

    bgState.lastSummary = summary;
    logAt("info", "bg_run_summary", summary);
    // Keep periodic scheduler heartbeats out of HA logbook even at info level.
    // Otherwise a 15 min interval would flood Logbook with low-value entries.
    if (summary.notifications_sent > 0 || summary.delivered_pruned > 0) {
      postHaAuditLogSafe("info", "bg_run_summary", summary);
    }

    return { ok: true, ran: true, summary };
  } catch (e) {
    bgState.lastError = String(e.message || e);
    postHaAuditLogSafe("error", "bg_run_failed", { error: bgState.lastError });
    return { ok: false, error: bgState.lastError };
  } finally {
    bgState.running = false;
  }
}
// ---- Background endpoints ----
app.get("/api/bg/status", (_req, res) => {
  res.json({
    ok: true,
    enabled: bgState.enabled,
    running: bgState.running,
    interval_min: BG_INTERVAL_MIN,
    normal_interval_min: BG_NORMAL_INTERVAL_MIN,
    slow_hours: BG_SLOW_HOURS,
    delay_ms: BG_DELAY_MS,
    delivered_retention_days: DELIVERED_RETENTION_DAYS,
    last_run_at: bgState.lastRunAt,
    last_error: bgState.lastError,
    last_summary: bgState.lastSummary,
    ha_configured: !!(HA_URL && HA_TOKEN)
  });
});

app.post("/api/bg/run_once", async (_req, res) => {
  const r = await bgRunOnce();
  res.json(r);
});

app.post("/api/bg/start", (_req, res) => {
  if (bgState.intervalId) {
    return res.json({ ok: true, started: false, reason: "already_started" });
  }

  bgState.enabled = true;
  bgState.intervalId = setInterval(() => {
    bgRunOnce().catch(() => { });
  }, Math.max(1, BG_INTERVAL_MIN) * 60 * 1000);

  return res.json({ ok: true, started: true, interval_min: BG_INTERVAL_MIN });
});

app.post("/api/bg/stop", (_req, res) => {
  if (bgState.intervalId) {
    clearInterval(bgState.intervalId);
    bgState.intervalId = null;
  }
  bgState.enabled = false;
  res.json({ ok: true, stopped: true });
});

function getOwner(store, owner) {
  const o = store.owners?.[owner];
  return o && typeof o === "object" ? o : null;
}

function normalizeTracking(tn) {
  return String(tn || "").trim().toUpperCase();
}

function normalizeManualTrackingStatus(statusRaw) {
  const value = String(statusRaw || "").trim().toLowerCase();
  if (!value) return null;
  if (["in_transit", "transit", "enviado", "in transit"].includes(value)) return "in_transit";
  if (["out_for_delivery", "out for delivery", "reparto", "en reparto"].includes(value)) return "out_for_delivery";
  if (["delivered", "entregado"].includes(value)) return "delivered";
  if (["info_received", "info received", "pedido", "pedido_creado", "pedido creado"].includes(value)) return "info_received";
  return null;
}

function manualTrackingStatusLabel(status) {
  if (status === "out_for_delivery") return "En reparto";
  if (status === "delivered") return "Entregado";
  if (status === "info_received") return "Pedido creado";
  return "Enviado";
}

// Manual additions need a synthetic snapshot so they enter the same list,
// editing and retention flow as IMAP-ingested packages without waiting for mail.
function buildManualTrackingSnapshot({
  tracking,
  status = "in_transit",
  carrierName = "",
  note = "",
  time = new Date()
}) {
  const iso = time instanceof Date ? time.toISOString() : new Date().toISOString();
  const normalizedStatus = normalizeManualTrackingStatus(status) || "in_transit";
  const baseEvent = manualTrackingStatusLabel(normalizedStatus);
  const description = note ? `${baseEvent} · ${String(note).trim()}` : baseEvent;
  return {
    number: normalizeTracking(tracking),
    carrierName: String(carrierName || "").trim() || null,
    latest: {
      status: normalizedStatus,
      subStatus: null,
      description,
      time: iso,
      carrierName: String(carrierName || "").trim() || null,
      subject: "Alta manual desde ingress",
      sender: "Alta manual"
    },
    flags: {
      isOutForDelivery: normalizedStatus === "out_for_delivery",
      isDelivered: normalizedStatus === "delivered"
    },
    error: null
  };
}

function ensureOwnerShape(store, owner) {
  store.owners = store.owners && typeof store.owners === "object" ? store.owners : {};
  store.owners[owner] = store.owners[owner] && typeof store.owners[owner] === "object"
    ? store.owners[owner]
    : {};

  const o = store.owners[owner];
  const normalizedTrackings = Array.isArray(o.trackings)
    ? o.trackings.map((x) => normalizeTracking(x)).filter(Boolean)
    : [];
  o.trackings = [...new Set(normalizedTrackings)];
  o.meta = o.meta && typeof o.meta === "object" ? o.meta : {};
  o.last = o.last && typeof o.last === "object" ? o.last : {};
  o.imap_accounts = Array.isArray(o.imap_accounts) ? o.imap_accounts : [];
  o.imap_ignore_rules = ownerImapIgnoreRules(o);
  return o;
}

function normalizeTrackingKeyedMap(rawMap, valueFactory = () => ({})) {
  const out = {};
  if (!rawMap || typeof rawMap !== "object") return out;

  for (const [rawKey, rawValue] of Object.entries(rawMap)) {
    const key = normalizeTracking(rawKey);
    if (!key) continue;
    out[key] = rawValue && typeof rawValue === "object" ? rawValue : valueFactory();
  }

  return out;
}

function normalizeAnnouncedMap(rawAnnounced) {
  const out = {};
  const source = rawAnnounced && typeof rawAnnounced === "object" ? rawAnnounced : {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizeTracking(rawKey);
    if (!key || !rawValue) continue;
    out[key] = true;
  }
  return out;
}

function sanitizeStore(store) {
  const next = store && typeof store === "object" ? store : {};
  const rawOwners = next.owners && typeof next.owners === "object" ? next.owners : {};
  const mergedOwners = {};

  for (const [rawOwnerKey, rawOwnerValue] of Object.entries(rawOwners)) {
    const owner = String(rawOwnerKey || "").trim().toLowerCase();
    if (!owner) continue;
    const rawOwner = rawOwnerValue && typeof rawOwnerValue === "object" ? rawOwnerValue : {};
    const current = mergedOwners[owner] && typeof mergedOwners[owner] === "object" ? mergedOwners[owner] : {};

    mergedOwners[owner] = {
      ...current,
      ...rawOwner,
      trackings: [
        ...(Array.isArray(current.trackings) ? current.trackings : []),
        ...(Array.isArray(rawOwner.trackings) ? rawOwner.trackings : [])
      ],
      meta: {
        ...(current.meta && typeof current.meta === "object" ? current.meta : {}),
        ...(rawOwner.meta && typeof rawOwner.meta === "object" ? rawOwner.meta : {})
      },
      last: {
        ...(current.last && typeof current.last === "object" ? current.last : {}),
        ...(rawOwner.last && typeof rawOwner.last === "object" ? rawOwner.last : {})
      },
      imap_accounts: [
        ...(Array.isArray(current.imap_accounts) ? current.imap_accounts : []),
        ...(Array.isArray(rawOwner.imap_accounts) ? rawOwner.imap_accounts : [])
      ],
      imap_ignore_rules: [
        ...(Array.isArray(current.imap_ignore_rules) ? current.imap_ignore_rules : []),
        ...(Array.isArray(rawOwner.imap_ignore_rules) ? rawOwner.imap_ignore_rules : [])
      ],
      announced: {
        ...(current.announced && typeof current.announced === "object" ? current.announced : {}),
        ...(rawOwner.announced && typeof rawOwner.announced === "object" ? rawOwner.announced : {})
      }
    };
  }

  next.owners = mergedOwners;

  for (const owner of Object.keys(mergedOwners)) {
    const o = ensureOwnerShape(next, owner);
    o.meta = normalizeTrackingKeyedMap(o.meta);
    o.last = normalizeTrackingKeyedMap(o.last, () => null);

    if (o.announced && typeof o.announced === "object") {
      o.announced.out_for_delivery = normalizeAnnouncedMap(o.announced.out_for_delivery);
    }

    if (ownerIsEmpty(o)) delete next.owners[owner];
  }

  return next;
}

function normalizeImapAccountEntry(a) {
  const email = String(a?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  const providerRaw = String(a?.provider || "").trim().toLowerCase();
  const provider = providerRaw || inferImapProvider(email);
  const enabled = maybeBool(a?.enabled);
  return {
    email,
    provider,
    enabled: enabled === undefined ? true : enabled
  };
}

function ownerImapAccounts(o) {
  const raw = Array.isArray(o?.imap_accounts) ? o.imap_accounts : [];
  const out = [];
  const seen = new Set();
  for (const a of raw) {
    const normalized = normalizeImapAccountEntry(a);
    if (!normalized) continue;
    if (seen.has(normalized.email)) continue;
    seen.add(normalized.email);
    out.push(normalized);
  }
  return out;
}

function setOwnerImapAccounts(o, accounts) {
  o.imap_accounts = ownerImapAccounts({ imap_accounts: accounts });
}

function upsertOwnerImapAccount(o, accountLike) {
  const next = normalizeImapAccountEntry(accountLike);
  if (!next) return null;
  const accounts = ownerImapAccounts(o);
  const idx = accounts.findIndex((a) => a.email === next.email);
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...next };
  else accounts.push(next);
  setOwnerImapAccounts(o, accounts);
  return next;
}

function removeOwnerImapAccount(o, emailRaw) {
  const email = String(emailRaw || "").trim().toLowerCase();
  const accounts = ownerImapAccounts(o);
  const next = accounts.filter((a) => a.email !== email);
  const removed = accounts.length - next.length;
  setOwnerImapAccounts(o, next);
  return removed;
}

function normalizeIgnoreTermToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractIgnoreTerms(textRaw, limit = 4) {
  const text = normalizeIgnoreTermToken(textRaw);
  if (!text) return [];

  const stopwords = new Set([
    "para",
    "desde",
    "hasta",
    "sobre",
    "your",
    "this",
    "that",
    "with",
    "from",
    "have",
    "been",
    "este",
    "esta",
    "estas",
    "estos",
    "como",
    "solo",
    "mail",
    "email",
    "correo",
    "alerta",
    "pedido",
    "paquete",
    "tracking",
    "shipment",
    "delivery",
    "package"
  ]);

  const tokens = [];
  for (const token of text.split(/\s+/)) {
    if (!token || token.length < 4) continue;
    if (stopwords.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/\d/.test(token)) continue;
    const letters = (token.match(/[a-z]/g) || []).length;
    if (letters < 3) continue;
    if (!tokens.includes(token)) tokens.push(token);
    if (tokens.length >= limit) break;
  }
  return tokens;
}

function normalizeImapIgnoreRuleEntry(ruleLike) {
  const accountEmail = String(ruleLike?.account_email || ruleLike?.accountEmail || "").trim().toLowerCase();
  const terms = Array.isArray(ruleLike?.description_terms)
    ? ruleLike.description_terms
    : Array.isArray(ruleLike?.terms)
      ? ruleLike.terms
      : extractIgnoreTerms(ruleLike?.sample_description || ruleLike?.description || "");
  const normalizedTerms = [...new Set(terms.map((x) => normalizeIgnoreTermToken(x)).filter(Boolean))];
  if (!normalizedTerms.length) return null;
  return {
    id: String(ruleLike?.id || `ignore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    kind: "subject_terms_all",
    account_email: accountEmail || null,
    description_terms: normalizedTerms,
    sample_description: String(ruleLike?.sample_description || ruleLike?.description || "").trim() || null,
    created_at: parseIsoOrNull(ruleLike?.created_at || ruleLike?.createdAt) || new Date().toISOString(),
    active: maybeBool(ruleLike?.active) !== false
  };
}

function ownerImapIgnoreRules(o) {
  const raw = Array.isArray(o?.imap_ignore_rules) ? o.imap_ignore_rules : [];
  const out = [];
  const seen = new Set();
  for (const rule of raw) {
    const normalized = normalizeImapIgnoreRuleEntry(rule);
    if (!normalized || !normalized.active) continue;
    const dedupeKey = `${normalized.account_email || "*"}|${normalized.description_terms.join("|")}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(normalized);
  }
  return out;
}

function setOwnerImapIgnoreRules(o, rules) {
  o.imap_ignore_rules = ownerImapIgnoreRules({ imap_ignore_rules: rules });
}

function upsertOwnerImapIgnoreRule(o, ruleLike) {
  const next = normalizeImapIgnoreRuleEntry(ruleLike);
  if (!next) return null;
  const rules = ownerImapIgnoreRules(o);
  const idx = rules.findIndex((rule) => (
    (rule.account_email || null) === (next.account_email || null) &&
    rule.description_terms.join("|") === next.description_terms.join("|")
  ));
  if (idx >= 0) {
    rules[idx] = { ...rules[idx], ...next, id: rules[idx].id, created_at: rules[idx].created_at };
    setOwnerImapIgnoreRules(o, rules);
    return rules[idx];
  }
  rules.push(next);
  setOwnerImapIgnoreRules(o, rules);
  return next;
}

function getMeta(o) {
  return o && o.meta && typeof o.meta === "object" ? o.meta : {};
}

function getTrackingMeta(o, tn) {
  const meta = getMeta(o);
  const key = normalizeTracking(tn);
  const m = meta?.[key];
  if (m && typeof m === "object") return m;

  // Back-compat for older stores with non-normalized keys.
  for (const k of Object.keys(meta)) {
    if (normalizeTracking(k) === key) {
      const hit = meta[k];
      return hit && typeof hit === "object" ? hit : {};
    }
  }

  return {};
}

function setTrackingMeta(o, tn, nextMeta) {
  const key = normalizeTracking(tn);
  o.meta = o.meta && typeof o.meta === "object" ? o.meta : {};
  // Remove older variants of the same tracking key (case/spaces) to avoid duplicates.
  for (const k of Object.keys(o.meta)) {
    if (normalizeTracking(k) === key && k !== key) delete o.meta[k];
  }
  o.meta[key] = nextMeta && typeof nextMeta === "object" ? nextMeta : {};
}

function ownerLastMap(o) {
  const raw = o?.last && typeof o.last === "object" ? o.last : {};
  const normalized = {};
  for (const [k, v] of Object.entries(raw)) {
    const nk = normalizeTracking(k);
    if (nk) normalized[nk] = v;
  }
  return normalized;
}

function deleteTrackingFromMap(mapObj, tracking) {
  if (!mapObj || typeof mapObj !== "object") return 0;
  const key = normalizeTracking(tracking);
  let removed = 0;
  for (const k of Object.keys(mapObj)) {
    if (normalizeTracking(k) === key) {
      delete mapObj[k];
      removed++;
    }
  }
  return removed;
}

function ownerIsEmpty(o) {
  const tCount = Array.isArray(o?.trackings) ? o.trackings.length : 0;
  const mCount = o?.meta && typeof o.meta === "object" ? Object.keys(o.meta).length : 0;
  const lCount = o?.last && typeof o.last === "object" ? Object.keys(o.last).length : 0;
  const aCount = Array.isArray(o?.imap_accounts) ? o.imap_accounts.length : 0;
  const rCount = Array.isArray(o?.imap_ignore_rules) ? o.imap_ignore_rules.length : 0;
  return tCount === 0 && mCount === 0 && lCount === 0 && aCount === 0 && rCount === 0;
}

function trackingSource(o, tn) {
  const meta = getTrackingMeta(o, tn);
  return normalizePackageSource(meta?.source, DEFAULT_PACKAGE_SOURCE) || DEFAULT_PACKAGE_SOURCE;
}

function effectiveCarrierName(one, trackingMeta = {}) {
  const override = String(trackingMeta?.carrier_name_override || "").trim();
  if (override) return override;
  const latest = String(one?.carrierName || "").trim();
  return latest || null;
}

function deliveredOverrideValue(trackingMeta = {}) {
  return trackingMeta?.delivered_override === true || trackingMeta?.delivered_override === false
    ? trackingMeta.delivered_override
    : null;
}

function serializeTrackingItem(owner, o, tn) {
  const tracking = normalizeTracking(tn);
  const meta = getTrackingMeta(o, tracking);
  const last = ownerLastMap(o);
  const one = last?.[tracking];

  return {
    owner,
    tracking,
    source: trackingSource(o, tracking),
    imap_account: String(meta?.imap_account || "").trim() || null,
    note: String(meta?.note || "").trim() || "",
    carrier_name: effectiveCarrierName(one, meta),
    carrier_name_detected: String(one?.carrierName || "").trim() || null,
    carrier_name_override: String(meta?.carrier_name_override || "").trim() || null,
    delivered_override: deliveredOverrideValue(meta),
    delivered_effective: effectiveIsDelivered(one, meta),
    delivered_at: String(meta?.delivered_at || "").trim() || null,
    out_for_delivery: effectiveIsOutForDelivery(one),
    one: shortOne(one)
  };
}

function telegramDisplayNameFromUser(user = {}) {
  const first = String(user?.first_name || "").trim();
  const last = String(user?.last_name || "").trim();
  const username = String(user?.username || "").trim();
  return [first, last].filter(Boolean).join(" ") || username || "Telegram";
}

function trackingLifecycleState(item) {
  if (item?.delivered_effective) return "delivered";
  if (item?.out_for_delivery) return "out_for_delivery";

  // Telegram no debería mostrar "pre-shipment". Esta heurística intenta dejar
  // fuera prealertas y etiquetas creadas sin ocultar envíos reales.
  const haystack = [
    item?.one?.latest?.status,
    item?.one?.latest?.subStatus,
    item?.one?.latest?.description
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const preShipmentHints = [
    "info_received",
    "info received",
    "information received",
    "shipment information received",
    "pre transit",
    "pre_transit",
    "pre advice",
    "pre_advice",
    "label created",
    "etiqueta creada",
    "pedido confirmado",
    "order processed",
    "waiting for carrier",
    "carrier not found"
  ];

  if (preShipmentHints.some((hint) => haystack.includes(hint))) return "pre_shipment";
  return "in_transit";
}

function isTrackingVisibleInTelegram(item) {
  return trackingLifecycleState(item) !== "pre_shipment";
}

function trackingLifecycleRank(state) {
  if (state === "out_for_delivery") return 0;
  if (state === "in_transit") return 1;
  if (state === "delivered") return 2;
  return 9;
}

function serializeTelegramTrackingItem(item) {
  const lifecycle = trackingLifecycleState(item);
  return {
    owner: item.owner,
    tracking: item.tracking,
    alias: item.note || "",
    courier: item.carrier_name || item.carrier_name_detected || "",
    status: lifecycle,
    status_label:
      lifecycle === "out_for_delivery"
        ? "En reparto"
        : lifecycle === "delivered"
          ? "Entregado"
          : "Enviado",
    delivered_effective: !!item.delivered_effective,
    delivered_override: item.delivered_override,
    imap_account: item.imap_account,
    sender: item?.one?.latest?.sender || "",
    last_event: item?.one?.latest?.description || item?.one?.latest?.status || "Sin estado",
    last_time: item?.one?.latest?.time || item?.delivered_at || null,
    latest: item?.one?.latest || null
  };
}

function listTelegramTrackings(store, allowedOwners, filters = {}) {
  const normalizedOwners = [...new Set((allowedOwners || []).map((owner) => normalizeTelegramOwner(owner)).filter(Boolean))];
  const statusFilter = String(filters.status || "").trim().toLowerCase();
  const courierFilter = String(filters.courier || "").trim().toLowerCase();
  const aliasFilter = String(filters.alias || "").trim().toLowerCase();
  const sortBy = String(filters.sort || "status").trim().toLowerCase();

  const items = normalizedOwners.flatMap((owner) => {
    applyDeliveredRetentionForOwner(store, owner, new Date());
    const o = getOwner(store, owner);
    if (!o) return [];
    return ownerTrackings(o).map((tn) => serializeTrackingItem(owner, o, tn));
  });

  const visible = items
    .filter((item) => isTrackingVisibleInTelegram(item))
    .filter((item) => !statusFilter || trackingLifecycleState(item) === statusFilter)
    .filter((item) => !courierFilter || String(item.carrier_name || item.carrier_name_detected || "").toLowerCase().includes(courierFilter))
    .filter((item) => !aliasFilter || String(item.note || "").toLowerCase().includes(aliasFilter))
    .map((item) => serializeTelegramTrackingItem(item));

  visible.sort((a, b) => {
    if (sortBy === "recent") {
      return (Date.parse(b.last_time || "") || 0) - (Date.parse(a.last_time || "") || 0);
    }
    if (sortBy === "oldest") {
      return (Date.parse(a.last_time || "") || 0) - (Date.parse(b.last_time || "") || 0);
    }
    const rankDiff = trackingLifecycleRank(a.status) - trackingLifecycleRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return (Date.parse(b.last_time || "") || 0) - (Date.parse(a.last_time || "") || 0);
  });

  const couriers = [...new Set(visible.map((item) => String(item.courier || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    items: visible,
    couriers
  };
}

function splitLogLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Manual mini-app refresh reuses the same IMAP worker process as the scheduled
// path so parsing, filters and ingest behavior stay identical in both flows.
function triggerManualImapRefresh(trigger = {}, deps = {}) {
  const state = deps.state || imapManualRefreshState;
  const scriptPath = deps.scriptPath || IMAP_WORKER_SCRIPT;
  const pathExists = deps.pathExists || fs.existsSync;
  const spawnImpl = deps.spawnImpl || spawn;
  const appRootDir = deps.appRootDir || APP_ROOT_DIR;
  const env = deps.env || process.env;
  const logFn = deps.logFn || logAt;
  const auditFn = deps.auditFn || postHaAuditLogSafe;

  if (state.running) {
    auditFn("info", "imap_manual_refresh_already_running", {
      trigger_source: trigger?.source || null,
      telegram_user_id: trigger?.telegram_user_id || null
    });
    return {
      ok: true,
      started: false,
      reason: "already_running",
      message: "Ya hay un refresco de correo en curso. Puede tardar unos momentos.",
      state: { ...state }
    };
  }

  if (!pathExists(scriptPath)) {
    const error = "imap_worker_script_missing";
    state.last_error = error;
    return {
      ok: false,
      started: false,
      error,
      message: "No se encontró el worker IMAP para lanzar el refresco."
    };
  }

  const child = spawnImpl("python3", [scriptPath], {
    cwd: appRootDir,
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  state.running = true;
  state.pid = child.pid || null;
  state.last_started_at = new Date().toISOString();
  state.last_finished_at = null;
  state.last_exit_code = null;
  state.last_error = null;
  state.last_trigger = trigger || null;

  logFn("info", "imap_manual_refresh_started", {
    pid: child.pid || null,
    trigger_source: trigger?.source || null,
    telegram_user_id: trigger?.telegram_user_id || null
  });
  auditFn("info", "imap_manual_refresh_started", {
    pid: child.pid || null,
    trigger_source: trigger?.source || null,
    telegram_user_id: trigger?.telegram_user_id || null
  });

  child.stdout.on("data", (chunk) => {
    for (const line of splitLogLines(chunk)) {
      logFn("info", "imap_manual_refresh_stdout", { line });
    }
  });

  child.stderr.on("data", (chunk) => {
    for (const line of splitLogLines(chunk)) {
      logFn("warn", "imap_manual_refresh_stderr", { line });
    }
  });

  child.on("error", (error) => {
    state.running = false;
    state.pid = null;
    state.last_finished_at = new Date().toISOString();
    state.last_error = String(error.message || error);
    logFn("error", "imap_manual_refresh_failed_to_start", {
      error: state.last_error
    });
    auditFn("error", "imap_manual_refresh_failed_to_start", {
      error: state.last_error
    });
  });

  child.on("close", (code) => {
    state.running = false;
    state.pid = null;
    state.last_finished_at = new Date().toISOString();
    state.last_exit_code = code;
    state.last_error = code === 0 ? null : `imap_manual_refresh_exit_${code}`;

    const level = code === 0 ? "info" : "warn";
    logFn(level, "imap_manual_refresh_finished", {
      exit_code: code,
      trigger_source: trigger?.source || null,
      telegram_user_id: trigger?.telegram_user_id || null
    });
    auditFn(level, "imap_manual_refresh_finished", {
      exit_code: code,
      trigger_source: trigger?.source || null,
      telegram_user_id: trigger?.telegram_user_id || null
    });
  });

  return {
    ok: true,
    started: true,
    message: "Refresco de correo lanzado. Puede tardar unos momentos en reflejarse.",
    state: { ...state }
  };
}

function boolFromAny(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}

function getBodyOrQuery(req, key) {
  if (req.body && req.body[key] !== undefined) return req.body[key];
  if (req.query && req.query[key] !== undefined) return req.query[key];
  return undefined;
}

function getDeliveredRetentionMs() {
  if (!Number.isFinite(DELIVERED_RETENTION_DAYS) || DELIVERED_RETENTION_DAYS <= 0) return 0;
  return DELIVERED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

// Returns effective delivered flag, honoring manual override if present.
function effectiveIsDelivered(one, trackingMeta) {
  const ov = trackingMeta?.delivered_override;
  if (ov === true || ov === false) return ov;
  return !!one?.flags?.isDelivered;
}

// Returns effective out-for-delivery flag (currently no override; placeholder if needed later).
function effectiveIsOutForDelivery(one) {
  return !!one?.flags?.isOutForDelivery;
}

// ---- Pending detection and refresh policy helpers ----

function ownerTrackings(o) {
  if (!Array.isArray(o?.trackings)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of o.trackings) {
    const tracking = normalizeTracking(raw);
    if (!tracking || seen.has(tracking)) continue;
    seen.add(tracking);
    out.push(tracking);
  }
  return out;
}

// Returns list of tracking numbers that are NOT delivered (honoring delivered_override).
function ownerPendingList(o) {
  const tns = ownerTrackings(o);
  const last = ownerLastMap(o);
  const pending = [];
  for (const tn of tns) {
    const one = last?.[tn];
    const meta = getTrackingMeta(o, tn);
    // If we have no status yet, treat as pending so it will refresh.
    const delivered = one ? effectiveIsDelivered(one, meta) : false;
    if (!delivered) pending.push(tn);
  }
  return pending;
}

function parseIsoDate(s) {
  const d = s ? new Date(String(s)) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

function deliveredAtForTracking(one, trackingMeta) {
  const status = String(one?.latest?.status || "").toLowerCase();
  const fromLatest = status === "delivered" ? parseIsoDate(one?.latest?.time) : null;
  const fromMeta = parseIsoDate(trackingMeta?.delivered_at);
  const fromOverride =
    trackingMeta?.delivered_override === true
      ? parseIsoDate(trackingMeta?.delivered_override_at)
      : null;
  return fromLatest || fromMeta || fromOverride || null;
}

function manualDeliveredAtForRetention(trackingMeta = {}) {
  // Auto-prune only starts after an explicit manual "delivered" action.
  // Auto-detected delivered states from IMAP stay visible until the user confirms them.
  return parseIsoDate(trackingMeta?.delivered_override_at) || parseIsoDate(trackingMeta?.delivered_at);
}

function updateDeliveredMetaForTracking(o, tn, one, now = new Date()) {
  if (!one || typeof one !== "object") return;
  const prev = getTrackingMeta(o, tn);
  const next = { ...prev };
  let changed = false;

  const delivered = effectiveIsDelivered(one, next);
  if (!delivered) {
    if (next.delivered_at !== undefined) {
      delete next.delivered_at;
      changed = true;
    }
  } else {
    const deliveredAt = deliveredAtForTracking(one, next) || now;
    const iso = deliveredAt.toISOString();
    if (next.delivered_at !== iso) {
      next.delivered_at = iso;
      changed = true;
    }
  }

  if (changed) setTrackingMeta(o, tn, next);
}

function saveTrackingLastSnapshot(o, tn, one, normError = null, now = new Date()) {
  o.last = o.last && typeof o.last === "object" ? o.last : {};
  if (one) {
    o.last[tn] = one;
    updateDeliveredMetaForTracking(o, tn, one, now);
  } else {
    o.last[tn] = { number: tn, latest: null, flags: null, error: normError };
  }
}

function applyDeliveredRetentionForOwner(store, owner, now = new Date()) {
  const retentionMs = getDeliveredRetentionMs();
  if (!retentionMs) return { removed: 0 };

  const o = getOwner(store, owner);
  if (!o) return { removed: 0 };

  const tns = ownerTrackings(o);
  const last = ownerLastMap(o);
  const announced =
    o?.announced &&
    typeof o.announced === "object" &&
    o.announced.out_for_delivery &&
    typeof o.announced.out_for_delivery === "object"
      ? o.announced.out_for_delivery
      : null;
  let removed = 0;

  for (const tn of tns) {
    const one = last?.[tn];
    const meta = getTrackingMeta(o, tn);
    // Auto-prune only packages explicitly marked as delivered by the user.
    if (meta?.delivered_override !== true) continue;

    const deliveredAt = manualDeliveredAtForRetention(meta);
    if (!deliveredAt) continue;

    const ageMs = now.getTime() - deliveredAt.getTime();
    if (ageMs < retentionMs) continue;

    o.trackings = o.trackings.filter((x) => normalizeTracking(x) !== tn);
    deleteTrackingFromMap(o.meta, tn);
    deleteTrackingFromMap(o.last, tn);
    if (announced?.[tn]) delete announced[tn];
    removed++;
  }

  if (removed > 0) {
    if (ownerIsEmpty(o)) delete store.owners[owner];
    else store.owners[owner] = o;
  }
  return { removed };
}

function applyDeliveredRetentionAndPersist(store, owner, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const r = applyDeliveredRetentionForOwner(store, owner, now);
  if (r.removed > 0) {
    saveStore(store);
    logAt("info", "delivered_retention_pruned", {
      req_id: context.reqId ?? null,
      owner,
      removed: r.removed,
      retention_days: DELIVERED_RETENTION_DAYS
    });
    postHaAuditLogSafe("info", "delivered_retention_pruned", {
      owner,
      removed: r.removed,
      retention_days: DELIVERED_RETENTION_DAYS
    });
  }
  return r;
}

function applyDeliveredRetentionForAllOwnersAndPersist(store, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const owners = ownersFromStore(store);
  let removed = 0;
  const touched = [];

  for (const owner of owners) {
    const r = applyDeliveredRetentionForOwner(store, owner, now);
    if (r.removed > 0) {
      removed += r.removed;
      touched.push({ owner, removed: r.removed });
    }
  }

  if (removed > 0) {
    saveStore(store);
    logAt("info", "delivered_retention_pruned_all", {
      req_id: context.reqId ?? null,
      removed,
      owners: touched,
      retention_days: DELIVERED_RETENTION_DAYS
    });
    postHaAuditLogSafe("info", "delivered_retention_pruned_all", {
      removed,
      owners: touched,
      retention_days: DELIVERED_RETENTION_DAYS
    });
  }

  return { removed, owners: touched };
}

function setTrackingDeliveredOverride(store, ownerRaw, trackingRaw, delivered) {
  const owner = String(ownerRaw || "").trim().toLowerCase();
  const tracking = normalizeTracking(trackingRaw);
  const o = getOwner(store, owner);
  if (!o) return { ok: false, status: 404, owner, tracking, error: "owner_not_found" };
  if (!ownerTrackings(o).includes(tracking)) {
    return { ok: false, status: 404, owner, tracking, error: "tracking_not_found" };
  }

  o.meta = o.meta && typeof o.meta === "object" ? o.meta : {};
  o.meta[tracking] = o.meta[tracking] && typeof o.meta[tracking] === "object" ? o.meta[tracking] : {};

  if (delivered === true || delivered === false) {
    o.meta[tracking].delivered_override = delivered;
    if (delivered === true) {
      const nowIso = new Date().toISOString();
      o.meta[tracking].delivered_override_at = nowIso;
      if (!parseIsoDate(o.meta[tracking].delivered_at)) {
        o.meta[tracking].delivered_at = nowIso;
      }
    } else {
      if (o.meta[tracking].delivered_override_at !== undefined) delete o.meta[tracking].delivered_override_at;
      if (o.meta[tracking].delivered_at !== undefined) delete o.meta[tracking].delivered_at;
    }
  } else {
    if (o.meta[tracking].delivered_override !== undefined) delete o.meta[tracking].delivered_override;
    if (o.meta[tracking].delivered_override_at !== undefined) delete o.meta[tracking].delivered_override_at;
  }

  return {
    ok: true,
    status: 200,
    owner,
    tracking,
    delivered_override: o.meta[tracking].delivered_override ?? null
  };
}

function removeTrackingFromOwner(o, trackingRaw) {
  const tracking = normalizeTracking(trackingRaw);
  const before = ownerTrackings(o);
  o.trackings = before.filter((x) => normalizeTracking(x) !== tracking);
  const removedFromTrackings = before.length - o.trackings.length;
  const removedFromMeta = deleteTrackingFromMap(o.meta, tracking);
  const removedFromLast = deleteTrackingFromMap(o.last, tracking);
  return {
    tracking,
    removed: removedFromTrackings > 0,
    removed_count: removedFromTrackings,
    removed_meta: removedFromMeta,
    removed_last: removedFromLast
  };
}

function reconcileImapAccountOwnership(store, ownerRaw, accountEmailRaw) {
  const owner = String(ownerRaw || "").trim().toLowerCase();
  const accountEmail = String(accountEmailRaw || "").trim().toLowerCase();
  if (!owner || !accountEmail || !accountEmail.includes("@")) {
    return { account_email: accountEmail || null, removed_trackings: 0, owners: [] };
  }

  let removedTrackings = 0;
  const touched = [];

  for (const foreignOwner of ownersFromStore(store)) {
    if (foreignOwner === owner) continue;
    const o = getOwner(store, foreignOwner);
    if (!o) continue;

    let removedOwnerTrackings = 0;
    const hadAccount = ownerImapAccounts(o).some((entry) => entry.email === accountEmail);
    if (hadAccount) removeOwnerImapAccount(o, accountEmail);

    for (const tracking of ownerTrackings(o)) {
      const meta = getTrackingMeta(o, tracking);
      const trackingAccount = String(meta?.imap_account || "").trim().toLowerCase();
      if (trackingAccount !== accountEmail) continue;
      const removed = removeTrackingFromOwner(o, tracking);
      if (removed.removed) removedOwnerTrackings += removed.removed_count;
    }

    if (!hadAccount && removedOwnerTrackings === 0) continue;

    removedTrackings += removedOwnerTrackings;
    touched.push({
      owner: foreignOwner,
      removed_trackings: removedOwnerTrackings,
      removed_account: hadAccount
    });

    if (ownerIsEmpty(o)) delete store.owners[foreignOwner];
    else store.owners[foreignOwner] = o;
  }

  return { account_email: accountEmail, removed_trackings: removedTrackings, owners: touched };
}

function markTrackingAsNotPackage(store, ownerRaw, trackingRaw) {
  const owner = String(ownerRaw || "").trim().toLowerCase();
  const tracking = normalizeTracking(trackingRaw);
  const o = getOwner(store, owner);
  if (!o) return { ok: false, status: 404, owner, tracking, error: "owner_not_found" };
  if (!ownerTrackings(o).includes(tracking)) {
    return { ok: false, status: 404, owner, tracking, error: "tracking_not_found" };
  }

  const meta = getTrackingMeta(o, tracking);
  const one = ownerLastMap(o)?.[tracking];
  const description = String(one?.latest?.subject || one?.latest?.description || one?.latest?.status || "").trim();
  const terms = extractIgnoreTerms(description);
  if (!terms.length) {
    return { ok: false, status: 422, owner, tracking, error: "ignore_rule_terms_missing" };
  }

  const ignoreRule = upsertOwnerImapIgnoreRule(o, {
    account_email: String(meta?.imap_account || "").trim().toLowerCase() || null,
    description_terms: terms,
    sample_description: description
  });
  const removal = removeTrackingFromOwner(o, tracking);

  return {
    ok: true,
    status: 200,
    owner,
    tracking,
    ignore_rule: ignoreRule,
    ...removal
  };
}

// Decide whether we should refresh now.
// Policy:
// - If owner has pending trackings => refresh every normalIntervalMin
// - If owner has trackings but all delivered => refresh only at specified hours (e.g. 8 and 20)
// - If owner has no trackings => never
function shouldRefreshOwnerNow(o, now, opts = {}) {
  const normalIntervalMin = Number(opts.normalIntervalMin ?? 45);
  const slowHours = Array.isArray(opts.slowHours) ? opts.slowHours : [8, 20];

  const tns = ownerTrackings(o);
  if (tns.length === 0) return { should: false, reason: "no_trackings" };

  const pending = ownerPendingList(o);
  const allDelivered = pending.length === 0;

  const lastChecked = parseIsoDate(o?.last_checked_at);
  const lastFull = parseIsoDate(o?.last_full_refresh_at);

  if (!allDelivered) {
    // Normal schedule: every N minutes
    if (!lastChecked) return { should: true, mode: "normal", reason: "never_checked", pending };
    const mins = (now.getTime() - lastChecked.getTime()) / 60000;
    if (mins >= normalIntervalMin) return { should: true, mode: "normal", reason: "interval_elapsed", pending };
    return { should: false, mode: "normal", reason: "interval_not_elapsed", pending, next_in_min: Math.max(0, normalIntervalMin - mins) };
  }

  // Slow schedule: only at fixed hours (default 08:00 and 20:00)
  const hour = now.getHours();
  const isSlowHour = slowHours.includes(hour);
  if (!isSlowHour) return { should: false, mode: "slow", reason: "not_slow_hour", pending: [] };

  // If we already did a slow refresh in this same hour window, skip.
  if (lastFull) {
    const sameDay = lastFull.getFullYear() === now.getFullYear() && lastFull.getMonth() === now.getMonth() && lastFull.getDate() === now.getDate();
    const sameHour = lastFull.getHours() === hour;
    if (sameDay && sameHour) return { should: false, mode: "slow", reason: "already_refreshed_this_hour", pending: [] };
  }

  return { should: true, mode: "slow", reason: "slow_hour", pending: [] };
}
// Inspect pending status for an owner (without refreshing)
app.get("/api/owner/:owner/pending", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const store = loadStore();
  applyDeliveredRetentionAndPersist(store, owner, { reqId: req.reqId });
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const tns = ownerTrackings(o);
  const pending = ownerPendingList(o);

  return res.json({
    ok: true,
    owner,
    total: tns.length,
    pending_count: pending.length,
    all_delivered: pending.length === 0 && tns.length > 0,
    pending
  });
});

function buildStatusLine(one, note, opts = {}) {
  const tn = one?.number || "";
  const desc = one?.latest?.description || "";
  const st = one?.latest?.status || "";
  const carrier = effectiveCarrierName(one, opts?.trackingMeta || {}) || "";
  const loc = one?.latest?.location || "";

  const extra = [carrier, loc].filter(Boolean).join(" · ");
  const right = desc || st || "(sin datos)";
  const left = note ? `${tn} (${note})` : tn;

  // If delivered_override was applied, show a tiny marker so we remember it's manual.
  const mark = opts?.delivered_override_applied ? " (manual)" : "";

  return `- ${left}: ${right}${extra ? ` — ${extra}` : ""}${mark}`;
}

function matchesFilter(one, filter, trackingMeta = {}) {
  if (!filter) return true;
  const f = String(filter).toLowerCase();

  if (f === "out_for_delivery" || f === "reparto") return effectiveIsOutForDelivery(one);
  if (f === "delivered" || f === "entregado") return effectiveIsDelivered(one, trackingMeta);

  // status/substatus contains
  const st = String(one?.latest?.status || "").toLowerCase();
  const sub = String(one?.latest?.subStatus || "").toLowerCase();
  const desc = String(one?.latest?.description || "").toLowerCase();
  return st.includes(f) || sub.includes(f) || desc.includes(f);
}

// ---- Utilities to resolve a tracking by "alias" (note) or by tracking number ----
function normalizeQuery(q) {
  return String(q || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveTrackingQueryAll(o, q, opts = {}) {
  // Returns an array of { tracking, note, score } sorted best-first.
  // Rules:
  // - Exact tracking match wins.
  // - Otherwise, match against note (substring). Prefer exact note, then startsWith, then includes.
  const query = normalizeQuery(q);
  if (!query) return [];

  const tns = ownerTrackings(o);
  const out = [];

  // 1) exact tracking
  const exact = tns.find((tn) => tn.toLowerCase() === query);
  if (exact) {
    const note = getTrackingMeta(o, exact)?.note || "";
    out.push({ tracking: exact, note, score: 100 });
    return out;
  }

  // 2) by note
  for (const tn of tns) {
    const note = String(getTrackingMeta(o, tn)?.note || "").trim();
    const n = normalizeQuery(note);
    if (!n) continue;

    if (n === query) out.push({ tracking: tn, note, score: 90 });
    else if (n.startsWith(query)) out.push({ tracking: tn, note, score: 80 });
    else if (n.includes(query)) out.push({ tracking: tn, note, score: 70 });
  }

  // Prefer higher score, then shorter note (more specific), then tracking asc
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const al = (a.note || "").length;
    const bl = (b.note || "").length;
    if (al !== bl) return al - bl;
    return String(a.tracking).localeCompare(String(b.tracking));
  });

  const limit = Number(opts.limit ?? 10);
  return out.slice(0, Math.max(1, limit));
}

function resolveTrackingQuery(o, q) {
  // Back-compat: return only the best match or null.
  const all = resolveTrackingQueryAll(o, q, { limit: 10 });
  return all.length ? all[0] : null;
}

function shortOne(one) {
  if (!one) return null;
  return {
    number: one.number,
    carrierName: one.carrierName,
    carrierCountry: one.carrierCountry,
    latest: one.latest
      ? {
        status: one.latest.status ?? null,
        subStatus: one.latest.subStatus ?? null,
        description: one.latest.description ?? null,
        time: one.latest.time ?? null,
        location: one.latest.location ?? null,
        subject: one.latest.subject ?? null,
        sender: one.latest.sender ?? null
      }
      : null,
    flags: one.flags
      ? {
        isOutForDelivery: !!one.flags.isOutForDelivery,
        isDelivered: !!one.flags.isDelivered
      }
      : null
  };
}

// List trackings for an owner (useful for Telegram/HA without parsing the text status)
app.get("/api/owner/:owner/trackings", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const store = loadStore();
  applyDeliveredRetentionAndPersist(store, owner, { reqId: req.reqId });
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const items = ownerTrackings(o).map((tn) => serializeTrackingItem(owner, o, tn));

  return res.json({ ok: true, owner, count: items.length, items });
});

// Resolve a query to a tracking number by either tracking itself or note/alias.
// Example: /api/owner/owner_a/resolve?q=ropa
app.get("/api/owner/:owner/resolve", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const q = String(req.query?.q || req.query?.query || "");

  const store = loadStore();
  applyDeliveredRetentionAndPersist(store, owner, { reqId: req.reqId });
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const matches = resolveTrackingQueryAll(o, q, { limit: 5 });
  if (!matches.length) {
    return res.status(404).json({ ok: false, owner, query: q, error: "no_match" });
  }
  const hit = matches[0];
  const item = serializeTrackingItem(owner, o, hit.tracking);

  return res.json({
    ok: true,
    owner,
    query: q,
    tracking: hit.tracking,
    source: item.source,
    imap_account: item.imap_account,
    note: hit.note || "",
    score: hit.score,
    matches: matches.map((m) => ({
      tracking: m.tracking,
      source: trackingSource(o, m.tracking),
      note: m.note || "",
      score: m.score
    })),
    carrier_name: item.carrier_name,
    carrier_name_detected: item.carrier_name_detected,
    carrier_name_override: item.carrier_name_override,
    delivered_override: item.delivered_override,
    delivered_effective: item.delivered_effective,
    out_for_delivery: item.out_for_delivery,
    one: item.one
  });
});

app.get("/api/store", (_req, res) => {
  const store = loadStore();
  const owners = store?.owners && typeof store.owners === "object" ? Object.keys(store.owners) : [];
  const payload = { req_id: _req.reqId, owners_count: owners.length };
  logAt("warn", "store_dump_requested", payload);
  postHaAuditLogSafe("warn", "store_dump_requested", payload);
  res.json(store);
});

app.get("/api/ui/owners", (req, res) => {
  const store = loadStore();
  applyDeliveredRetentionForAllOwnersAndPersist(store, { reqId: req.reqId });
  const access = haOwnerAccessFromHeaders(req.headers);
  if (access.via_ingress && !access.mapped) {
    const payload = {
      req_id: req.reqId,
      ha_user_id: access.ha_user_id,
      display_name: access.display_name,
      path: req.originalUrl,
      error: "ha_user_not_allowed"
    };
    logAt("warn", "ha_ingress_user_denied", payload);
    postHaAuditLogSafe("warn", "ha_ingress_user_denied", payload);
    return res.status(403).json({ ok: false, error: "ha_user_not_allowed" });
  }

  const owners = filterOwnersForHaIngress(
    ownersFromStore(store)
    .sort((a, b) => a.localeCompare(b))
    .map((owner) => {
      const o = getOwner(store, owner);
      if (!o) return null;

      const items = ownerTrackings(o)
        .map((tn) => serializeTrackingItem(owner, o, tn))
        .sort((a, b) => {
          if (a.delivered_effective !== b.delivered_effective) return a.delivered_effective ? 1 : -1;
          const aTime = Date.parse(a?.one?.latest?.time || "") || 0;
          const bTime = Date.parse(b?.one?.latest?.time || "") || 0;
          return bTime - aTime;
        });

      return {
        owner,
        count: items.length,
        delivered_count: items.filter((item) => item.delivered_effective).length,
        pending_count: items.filter((item) => !item.delivered_effective).length,
        items
      };
    })
    .filter(Boolean),
    access
  );

  const totalItems = owners.reduce((acc, owner) => acc + owner.count, 0);
  return res.json({
    ok: true,
    owners_count: owners.length,
    total_items: totalItems,
    delivered_retention_days: DELIVERED_RETENTION_DAYS,
    raw_debug_enabled: canViewHaIngressDebug(access, RAW_DEBUG_OWNER),
    scoped_by_ha_user: access.via_ingress ? {
      ha_user_id: access.ha_user_id,
      display_name: access.display_name,
      owners: access.owners
    } : null,
    owners
  });
});

app.get("/api/owner/:owner/imap/accounts", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const store = loadStore();
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });
  const accounts = ownerImapAccounts(o);
  return res.json({ ok: true, owner, count: accounts.length, accounts });
});

app.post("/api/owner/:owner/imap/accounts", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const email = String(req.body?.email || req.body?.account_email || "").trim().toLowerCase();
  const provider = String(req.body?.provider || "").trim().toLowerCase();
  const enabled = maybeBool(req.body?.enabled);
  if (!email || !email.includes("@")) {
    const payload = {
      req_id: req.reqId,
      owner,
      account_email: email || null,
      error: "email_invalido"
    };
    logAt("warn", "imap_account_upsert_invalid_email", payload);
    postHaAuditLogSafe("warn", "imap_account_upsert_invalid_email", payload);
    return res.status(400).json({ ok: false, owner, error: "email_invalido" });
  }

  const store = loadStore();
  const o = ensureOwnerShape(store, owner);
  const prevAccount = ownerImapAccounts(o).find((entry) => entry.email === email) || null;
  const account = upsertOwnerImapAccount(o, {
    email,
    provider: provider || inferImapProvider(email),
    enabled: enabled === undefined ? true : enabled
  });
  const reconciliation = reconcileImapAccountOwnership(store, owner, email);
  saveStore(store);
  const changed =
    !prevAccount ||
    prevAccount.provider !== account?.provider ||
    prevAccount.enabled !== account?.enabled;
  if (changed) {
    logAt("info", "imap_account_upserted", {
      req_id: req.reqId,
      owner,
      account_email: email,
      provider: account?.provider || null
    });
    postHaAuditLogSafe("info", "imap_account_upserted", {
      owner,
      account_email: email,
      provider: account?.provider || null
    });
  }
  if (reconciliation.removed_trackings > 0 || reconciliation.owners.length > 0) {
    const payload = {
      req_id: req.reqId,
      owner,
      account_email: email,
      removed_trackings: reconciliation.removed_trackings,
      owners: reconciliation.owners
    };
    logAt("warn", "imap_account_upsert_reconciled_ownership", payload);
    postHaAuditLogSafe("warn", "imap_account_upsert_reconciled_ownership", payload);
  }
  return res.json({
    ok: true,
    owner,
    account,
    changed,
    reconciliation,
    count: ownerImapAccounts(o).length
  });
});

app.delete("/api/owner/:owner/imap/accounts/:email", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const email = decodeURIComponent(String(req.params.email || "")).trim().toLowerCase();
  if (!email) {
    const payload = {
      req_id: req.reqId,
      owner,
      account_email: null,
      error: "email_invalido"
    };
    logAt("warn", "imap_account_delete_invalid_email", payload);
    postHaAuditLogSafe("warn", "imap_account_delete_invalid_email", payload);
    return res.status(400).json({ ok: false, owner, error: "email_invalido" });
  }

  const store = loadStore();
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });
  const removed = removeOwnerImapAccount(o, email);
  saveStore(store);
  logAt("info", "imap_account_deleted", {
    req_id: req.reqId,
    owner,
    account_email: email,
    removed_count: removed
  });
  postHaAuditLogSafe("info", "imap_account_deleted", {
    owner,
    account_email: email,
    removed_count: removed
  });
  return res.json({
    ok: true,
    owner,
    email,
    removed: removed > 0,
    removed_count: removed,
    count: ownerImapAccounts(o).length
  });
});

app.get("/api/owner/:owner/imap/ignore_rules", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const store = loadStore();
  const o = getOwner(store, owner);
  if (!o) return res.json({ ok: true, owner, count: 0, rules: [] });
  const rules = ownerImapIgnoreRules(o);
  return res.json({ ok: true, owner, count: rules.length, rules });
});

app.post("/api/owner/:owner/imap/ingest", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const fallbackAccountEmail = String(req.body?.account_email || req.body?.account || "").trim().toLowerCase();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) {
    const payload = { req_id: req.reqId, owner, error: "items_obligatorio" };
    logAt("warn", "imap_ingest_rejected_empty_items", payload);
    postHaAuditLogSafe("warn", "imap_ingest_rejected_empty_items", payload);
    return res.status(400).json({ ok: false, owner, error: "items_obligatorio" });
  }

  const store = loadStore();
  const o = ensureOwnerShape(store, owner);
  const now = new Date();
  const accepted = [];
  const reconciledAccounts = new Set();
  const reconciliationEvents = [];
  let skipped_invalid = 0;

  for (const item of items) {
    const tracking = normalizeTracking(item?.tracking || item?.number || item?.id || "");
    if (!tracking) {
      skipped_invalid++;
      continue;
    }
    if (!o.trackings.includes(tracking)) o.trackings.push(tracking);

    const accountEmail = String(item?.account_email || item?.account || fallbackAccountEmail || "")
      .trim()
      .toLowerCase();
    if (accountEmail && accountEmail.includes("@")) {
      upsertOwnerImapAccount(o, { email: accountEmail, provider: inferImapProvider(accountEmail), enabled: true });
      if (!reconciledAccounts.has(accountEmail)) {
        // The worker's owner/account pairing is authoritative. If an account was
        // previously attached to another owner, clean those leftovers now.
        const reconciliation = reconcileImapAccountOwnership(store, owner, accountEmail);
        reconciledAccounts.add(accountEmail);
        if (reconciliation.removed_trackings > 0 || reconciliation.owners.length > 0) {
          reconciliationEvents.push(reconciliation);
        }
      }
    }

    const prev = getTrackingMeta(o, tracking);
    const nextMeta = {
      ...prev,
      source: "imap",
      ...(accountEmail ? { imap_account: accountEmail } : {})
    };
    const note = String(item?.note || "").trim();
    if (note) nextMeta.note = note;
    setTrackingMeta(o, tracking, nextMeta);

    const one = normalizeImapSnapshot(item, tracking, accountEmail);
    saveTrackingLastSnapshot(o, tracking, one, null, now);
    accepted.push({ tracking, source: "imap", imap_account: accountEmail || null });
  }

  o.last_imap_ingest_at = now.toISOString();
  saveStore(store);
  for (const reconciliation of reconciliationEvents) {
    const payload = {
      req_id: req.reqId,
      owner,
      account_email: reconciliation.account_email,
      removed_trackings: reconciliation.removed_trackings,
      owners: reconciliation.owners
    };
    logAt("warn", "imap_ingest_reconciled_account_ownership", payload);
    postHaAuditLogSafe("warn", "imap_ingest_reconciled_account_ownership", payload);
  }
  if (skipped_invalid > 0) {
    // Keep this as warning to surface malformed payloads in HA logbook.
    logAt("warn", "imap_ingest_items_skipped_invalid", {
      req_id: req.reqId,
      owner,
      ingested: accepted.length,
      skipped_invalid
    });
    postHaAuditLogSafe("warn", "imap_ingest_items_skipped_invalid", {
      owner,
      ingested: accepted.length,
      skipped_invalid
    });
  }

  const ingestLevel = accepted.length === 0 && skipped_invalid > 0 ? "warn" : "info";
  logAt(ingestLevel, "imap_ingest_done", {
    req_id: req.reqId,
    owner,
    ingested: accepted.length,
    skipped_invalid
  });
  postHaAuditLogSafe(ingestLevel, "imap_ingest_done", {
    owner,
    ingested: accepted.length,
    skipped_invalid
  });

  return res.json({
    ok: true,
    owner,
    ingested: accepted.length,
    skipped_invalid,
    accepted
  });
});

app.patch("/api/owner/:owner/tracking/:tracking/meta", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = normalizeTracking(req.params.tracking);
  const store = loadStore();
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ ok: false, owner, tracking, error: "owner_not_found" });
  if (!ownerTrackings(o).includes(tracking)) {
    return res.status(404).json({ ok: false, owner, tracking, error: "tracking_not_found" });
  }

  const nextMeta = { ...getTrackingMeta(o, tracking) };
  const hadNote = Object.prototype.hasOwnProperty.call(req.body || {}, "note");
  const hadCarrierName =
    Object.prototype.hasOwnProperty.call(req.body || {}, "carrier_name") ||
    Object.prototype.hasOwnProperty.call(req.body || {}, "carrierName");

  if (hadNote) {
    const note = String(req.body?.note || "").trim();
    if (note) nextMeta.note = note;
    else delete nextMeta.note;
  }

  if (hadCarrierName) {
    const carrierName = String(req.body?.carrier_name ?? req.body?.carrierName ?? "").trim();
    if (carrierName) nextMeta.carrier_name_override = carrierName;
    else delete nextMeta.carrier_name_override;
  }

  setTrackingMeta(o, tracking, nextMeta);
  saveStore(store);

  const payload = {
    req_id: req.reqId,
    owner,
    tracking,
    note: String(nextMeta.note || "").trim() || null,
    carrier_name_override: String(nextMeta.carrier_name_override || "").trim() || null
  };
  logAt("info", "tracking_meta_updated", payload);

  return res.json({
    ok: true,
    owner,
    tracking,
    item: serializeTrackingItem(owner, o, tracking)
  });
});

app.post("/api/owner/:owner/tracking", async (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = normalizeTracking(req.body?.tracking || req.query?.tracking || "");
  const note = String(req.body?.note || "").trim();
  const source = normalizePackageSource(getBodyOrQuery(req, "source"), DEFAULT_PACKAGE_SOURCE);
  const imapAccount = String(getBodyOrQuery(req, "imap_account") || "").trim().toLowerCase();
  const manualStatus = normalizeManualTrackingStatus(getBodyOrQuery(req, "status") || getBodyOrQuery(req, "current_status"));
  const manualCarrierName = String(getBodyOrQuery(req, "carrier_name") || "").trim();
  if (source === null) {
    const payload = {
      req_id: req.reqId,
      owner,
      tracking,
      source_raw: getBodyOrQuery(req, "source")
    };
    logAt("warn", "tracking_add_invalid_source", payload);
    postHaAuditLogSafe("warn", "tracking_add_invalid_source", payload);
    return res.status(400).json({ error: "source_invalido", allowed_sources: [...PACKAGE_SOURCES] });
  }

  logAt("info", "tracking_add_requested", {
    req_id: req.reqId,
    owner,
    tracking,
    source,
    imap_account: imapAccount || null
  });

  if (!owner || !tracking) return res.status(400).json({ error: "owner y tracking son obligatorios" });

  const store = loadStore();
  const o = ensureOwnerShape(store, owner);

  if (!o.trackings.includes(tracking)) o.trackings.push(tracking);
  const prevMeta = getTrackingMeta(o, tracking);
  const nextMeta = { ...prevMeta, source };
  if (note) nextMeta.note = note;
  if (manualCarrierName) nextMeta.carrier_name_override = manualCarrierName;
  if (imapAccount && imapAccount.includes("@")) {
    nextMeta.imap_account = imapAccount;
    upsertOwnerImapAccount(o, {
      email: imapAccount,
      provider: inferImapProvider(imapAccount),
      enabled: true
    });
  }
  setTrackingMeta(o, tracking, nextMeta);

  if (manualStatus) {
    const now = new Date();
    saveTrackingLastSnapshot(
      o,
      tracking,
      buildManualTrackingSnapshot({
        tracking,
        status: manualStatus,
        carrierName: manualCarrierName || String(prevMeta?.carrier_name_override || "").trim(),
        note,
        time: now
      }),
      null,
      now
    );
  }

  saveStore(store);
  if (manualStatus) {
    const payload = {
      req_id: req.reqId,
      owner,
      tracking,
      status: manualStatus,
      carrier_name: manualCarrierName || null,
      note: note || null
    };
    logAt("info", "manual_tracking_added", payload);
    postHaAuditLogSafe("info", "manual_tracking_added", {
      owner,
      tracking,
      status: manualStatus,
      carrier_name: manualCarrierName || null
    });
  }
  logAt("info", "tracking_add_saved", {
    req_id: req.reqId,
    owner,
    tracking,
    source
  });
  res.json({ ok: true, owner, tracking, source, note });
});

// Set or clear a manual delivered override for a tracking number.
// Body: { delivered: true|false|null }
// - true/false forces the delivered flag when the detected state is wrong
// - null (or missing) clears the override and returns to the latest stored flags
app.post("/api/owner/:owner/tracking/:tracking/override", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = String(req.params.tracking || "").trim().toUpperCase();
  const delivered = req.body?.delivered;

  const store = loadStore();
  const result = setTrackingDeliveredOverride(store, owner, tracking, delivered);
  if (!result.ok) {
    if (result.error === "tracking_not_found") {
      const payload = { req_id: req.reqId, owner, tracking, error: "tracking_not_found" };
      logAt("warn", "tracking_override_rejected_missing_tracking", payload);
      postHaAuditLogSafe("warn", "tracking_override_rejected_missing_tracking", payload);
    }
    return res.status(result.status).json(result);
  }

  saveStore(store);
  logAt("info", "tracking_override_updated", {
    req_id: req.reqId,
    owner: result.owner,
    tracking: result.tracking,
    delivered_override: result.delivered_override
  });
  return res.json(result);
});

app.post("/api/owner/:owner/tracking/:tracking/not_package", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = String(req.params.tracking || "").trim().toUpperCase();
  const store = loadStore();
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ ok: false, owner, tracking, error: "owner_not_found" });

  const source = trackingSource(o, tracking);
  if (source !== "imap") {
    return res.status(400).json({
      ok: false,
      owner,
      tracking,
      source,
      error: "not_package_only_imap"
    });
  }

  const result = markTrackingAsNotPackage(store, owner, tracking);
  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  if (ownerIsEmpty(o)) delete store.owners[owner];
  else store.owners[owner] = o;
  saveStore(store);

  const payload = {
    req_id: req.reqId,
    owner,
    tracking,
    account_email: result.ignore_rule?.account_email || null,
    description_terms: result.ignore_rule?.description_terms || []
  };
  logAt("info", "tracking_marked_not_package", payload);
  postHaAuditLogSafe("info", "tracking_marked_not_package", payload);

  return res.json(result);
});

app.delete("/api/owner/:owner/tracking/:tracking", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = normalizeTracking(req.params.tracking);

  const store = loadStore();
  const o = store.owners[owner];
  if (!o) {
    return res.json({ ok: true, owner, tracking, removed: false, removed_count: 0, reason: "owner_not_found" });
  }

  const removal = removeTrackingFromOwner(o, tracking);

  if (ownerIsEmpty(o)) delete store.owners[owner];

  saveStore(store);
  logAt("info", "tracking_deleted", {
    req_id: req.reqId,
    owner,
    tracking,
    removed_count: removal.removed_count,
    removed_meta: removal.removed_meta,
    removed_last: removal.removed_last
  });
  res.json({
    ok: true,
    owner,
    tracking,
    removed: removal.removed,
    removed_count: removal.removed_count,
    removed_meta: removal.removed_meta,
    removed_last: removal.removed_last
  });
});

app.get("/api/owner/:owner/status", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const filter = req.query?.filter; // e.g. reparto|delivered|intransit|...
  const format = String(req.query?.format || "json").toLowerCase(); // json|text

  const store = loadStore();
  applyDeliveredRetentionAndPersist(store, owner, { reqId: req.reqId });
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const last = o.last && typeof o.last === "object" ? o.last : {};
  const meta = o.meta && typeof o.meta === "object" ? o.meta : {};

  const items = Object.keys(last)
    .sort()
    .map((tn) => {
      const one = last[tn];
      const m = getTrackingMeta(o, tn);
      const note = m?.note || "";
      const delivered_override_applied = (m.delivered_override === true || m.delivered_override === false);
      return { tn, one, note, meta: m, delivered_override_applied };
    })
    .filter((x) => x.one && matchesFilter(x.one, filter, x.meta));

  if (format === "text") {
    const lines = items.map((x) => buildStatusLine(x.one, x.note, {
      delivered_override_applied: x.delivered_override_applied,
      trackingMeta: x.meta
    }));
    return res.type("text/plain").send(lines.join("\n"));
  }

  return res.json({
    ok: true,
    owner,
    filter: filter || null,
    count: items.length,
    items: items.map((x) => ({
      tracking: x.tn,
      source: trackingSource(o, x.tn),
      one: x.one,
      note: x.note,
      carrier_name: effectiveCarrierName(x.one, x.meta),
      delivered_override: (x.meta?.delivered_override === true || x.meta?.delivered_override === false) ? x.meta.delivered_override : null
    }))
  });
});


app.post("/api/owner/:owner/refresh", async (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const delayMs = Number(req.body?.delay_ms ?? 5000); // 5s por defecto

  const store = loadStore();
  applyDeliveredRetentionAndPersist(store, owner, { reqId: req.reqId });
  const o = store.owners[owner];
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const trackings = Array.isArray(o.trackings) ? o.trackings : [];
  if (trackings.length === 0) return res.json({ ok: true, owner, results: [] });

  const results = [];
  for (let i = 0; i < trackings.length; i++) {
    const tn = String(trackings[i] || "").trim().toUpperCase();
    if (!tn) continue;
    const r = await refreshTrackingBySource(o, owner, tn, new Date());
    results.push(r);

    if (i < trackings.length - 1) await sleep(delayMs);
  }

  store.owners[owner] = o;
  saveStore(store);

  res.json({ ok: true, owner, count: results.length, results });
});

// Conditional refresh endpoint: only refresh if policy says it's time
app.post("/api/owner/:owner/refresh_if_needed", async (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const delayMs = Number(req.body?.delay_ms ?? 5000);
  const normalIntervalMin = Number(req.body?.normal_interval_min ?? 45);
  const slowHours = Array.isArray(req.body?.slow_hours) ? req.body.slow_hours.map((x) => Number(x)).filter((n) => !isNaN(n)) : [8, 20];

  const now = new Date();

  const store = loadStore();
  applyDeliveredRetentionAndPersist(store, owner, { reqId: req.reqId, now });
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const decision = shouldRefreshOwnerNow(o, now, { normalIntervalMin, slowHours });
  if (!decision.should) {
    // still update last_checked_at? No: only update when we actually attempt refresh.
    return res.json({ ok: true, owner, refreshed: false, decision });
  }

  const trackings = ownerTrackings(o);
  if (trackings.length === 0) return res.json({ ok: true, owner, refreshed: false, decision: { ...decision, reason: "no_trackings" } });

  const results = [];
  for (let i = 0; i < trackings.length; i++) {
    const tn = trackings[i];
    const r = await refreshTrackingBySource(o, owner, tn, now);
    results.push(r);

    if (i < trackings.length - 1) await sleep(delayMs);
  }

  // bookkeeping timestamps
  o.last_checked_at = now.toISOString();
  if (decision.mode === "slow") {
    o.last_full_refresh_at = now.toISOString();
  }

  store.owners[owner] = o;
  saveStore(store);

  return res.json({ ok: true, owner, refreshed: true, decision, count: results.length, results });
});

app.post("/api/owner/:owner/refresh_and_filter", async (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const delayMs = Number(req.body?.delay_ms ?? 5000);
  const filter = req.body?.filter; // e.g. "reparto"

  // Reuse the existing refresh logic by calling the internal handler inline:
  const store = loadStore();
  applyDeliveredRetentionAndPersist(store, owner, { reqId: req.reqId });
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const trackings = Array.isArray(o.trackings) ? o.trackings : [];
  const results = [];

  for (let i = 0; i < trackings.length; i++) {
    const tn = String(trackings[i] || "").trim().toUpperCase();
    if (!tn) continue;
    const r = await refreshTrackingBySource(o, owner, tn, new Date());
    results.push(r);

    if (i < trackings.length - 1) await sleep(delayMs);
  }

  store.owners[owner] = o;
  saveStore(store);

  const filtered = results
    .map((r) => r.one)
    .filter((one) => one && matchesFilter(one, filter));

  res.json({ ok: true, owner, filter: filter || null, refreshed: results.length, matched: filtered.length, items: filtered });
});

function startBackgroundIfEnabled() {
  if (!BG_ENABLED) {
    logAt("warn", "bg_scheduler_disabled_by_config", {
      bg_enabled: BG_ENABLED,
      bg_enabled_raw: BG_ENABLED_RAW ?? null,
      hint: "Configura BG_ENABLED con 1/true/yes/on para activar refresco automático."
    });
    return;
  }
  if (bgState.intervalId) return;

  // Run once shortly after boot (helps after restarts / power cuts).
  setTimeout(() => {
    bgRunOnce().catch(() => { });
  }, 10_000);

  bgState.intervalId = setInterval(() => {
    bgRunOnce().catch(() => { });
  }, Math.max(1, BG_INTERVAL_MIN) * 60 * 1000);

  bgState.enabled = true;
  logAt("info", "bg_scheduler_enabled", {
    interval_min: BG_INTERVAL_MIN,
    normal_interval_min: BG_NORMAL_INTERVAL_MIN,
    slow_hours: BG_SLOW_HOURS,
    delay_ms: BG_DELAY_MS
  });
}

function startServer(listenPort = process.env.PORT || 8787) {
  validateStartupConfig();
  return app.listen(listenPort, () => {
    console.log(`HA IMAP Tracker listening on ${listenPort}`);
    console.log(`[DATA] store path: ${DATA_DIR}/${STORE_FILE}`);
    console.log(`[APP] log level: ${APP_LOG_LEVEL}`);
    console.log(`[APP] version: ${APP_VERSION}`);
    startBackgroundIfEnabled();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  _test: {
    applyDeliveredRetentionForOwner,
    manualDeliveredAtForRetention,
    setTrackingDeliveredOverride,
    extractIgnoreTerms,
    markTrackingAsNotPackage,
    normalizeTelegramAccessEntry,
    parseTelegramInitData,
    createTelegramSessionToken,
    verifyTelegramSessionToken,
    trackingLifecycleState,
    listTelegramTrackings,
    triggerManualImapRefresh,
    splitLogLines,
    ownerTrackings,
    trackingSource,
    clearOwnerStoreData,
    sanitizeStore,
    reconcileImapAccountOwnership,
    normalizeHaOwnerAccessEntry,
    haOwnerAccessFromHeaders,
    filterOwnersForHaIngress,
    canViewHaIngressDebug,
    RAW_DEBUG_OWNER,
    normalizeManualTrackingStatus,
    buildManualTrackingSnapshot
  }
};
