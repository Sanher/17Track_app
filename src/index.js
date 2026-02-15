const express = require("express");
const { readJson, writeJson, DATA_DIR } = require("./storage");
const { getTrackInfo, register, normalizeGetTrackInfoResponse } = require("./track17");
const { CARRIERS } = require("./carriers");

const STORE_FILE = "store.json";
const APP_LOG_LEVEL = String(process.env.APP_LOG_LEVEL || "info").trim().toLowerCase();
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

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
 *     david: {
 *       trackings: ["PH7...", "323..."] ,
 *       // meta holds user-provided metadata per tracking number
 *       meta: {
 *         "PH7...": {
 *           note: "Amazon - regalo",       // free text shown in status lines
 *           delivered_override: false       // OPTIONAL: force delivered true/false. If undefined, use 17Track flags.
 *         }
 *       },
 *       // last holds the latest normalized 17Track status per tracking
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

function loadStore() { return readJson(STORE_FILE, { owners: {} }); }
function saveStore(store) { writeJson(STORE_FILE, store); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();

app.use(express.json());

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

app.use((req, res, next) => {
  const started = Date.now();
  const reqId = `${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req.reqId = reqId;
  logAt("debug", "http_request_start", {
    req_id: reqId,
    method: req.method,
    path: req.originalUrl
  });
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

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/_build", (_req, res) => res.json({ ok: true, build: "v0.3.3", has_trackings: true }));

// Carriers live in ./carriers.js for easier maintenance (names + keys).
// CARRIERS: { alias: { key, name }, ... }
const CARRIERS_MAP = Object.fromEntries(
  Object.entries(CARRIERS).map(([alias, v]) => [alias, v.key])
);

// Expose the full carriers object so clients can show friendly names.
app.get("/api/carriers", (_req, res) => res.json({ carriers: CARRIERS }));

const TRACK17_CARRIERS_CSV_URL = "https://res.17track.net/asset/carrier/info/apicarrier.all.csv";
const CARRIERS_17TRACK_CACHE_TTL_MS = Number(process.env.CARRIERS_17TRACK_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const CARRIERS_17TRACK_FETCH_TIMEOUT_MS = Number(process.env.CARRIERS_17TRACK_FETCH_TIMEOUT_MS || 12000);
const carriers17TrackCache = {
  fetched_at: null,
  items: [],
  loading: null
};

function normalizeAliasText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        cur += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseTrack17CarriersCsv(csvRaw) {
  const lines = String(csvRaw || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [];

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (!row.length) continue;
    const keyNum = Number(row[0]);
    const nameEn = String(row[1] || "").trim();
    const nameCn = String(row[2] || "").trim();
    const nameHk = String(row[3] || "").trim();
    const url = String(row[4] || "").trim();
    if (!Number.isFinite(keyNum) || !nameEn) continue;

    const alias = normalizeAliasText(nameEn);
    const baseAlias = normalizeAliasText(
      nameEn
        .replace(/\([^)]*\)/g, " ")
        .split(/[\s-]+/)[0]
    );

    items.push({
      key: keyNum,
      alias,
      base_alias: baseAlias,
      name_en: nameEn,
      name_cn: nameCn || null,
      name_hk: nameHk || null,
      url: url || null
    });
  }
  return items;
}

async function load17TrackCarriersCached(forceRefresh = false) {
  const now = Date.now();
  const ttlMs = Number.isFinite(CARRIERS_17TRACK_CACHE_TTL_MS) && CARRIERS_17TRACK_CACHE_TTL_MS > 0
    ? CARRIERS_17TRACK_CACHE_TTL_MS
    : 24 * 60 * 60 * 1000;

  const cacheValid = carriers17TrackCache.fetched_at && (now - carriers17TrackCache.fetched_at.getTime() < ttlMs);
  if (!forceRefresh && cacheValid && carriers17TrackCache.items.length > 0) {
    return carriers17TrackCache.items;
  }

  if (carriers17TrackCache.loading) {
    return carriers17TrackCache.loading;
  }

  carriers17TrackCache.loading = (async () => {
    const timeoutMs = Number.isFinite(CARRIERS_17TRACK_FETCH_TIMEOUT_MS) && CARRIERS_17TRACK_FETCH_TIMEOUT_MS > 0
      ? CARRIERS_17TRACK_FETCH_TIMEOUT_MS
      : 12000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(TRACK17_CARRIERS_CSV_URL, { signal: controller.signal });
      if (!r.ok) {
        throw new Error(`carriers_csv_fetch_failed_${r.status}`);
      }
      const txt = await r.text();
      const parsed = parseTrack17CarriersCsv(txt);
      carriers17TrackCache.items = parsed;
      carriers17TrackCache.fetched_at = new Date();
      return parsed;
    } catch (e) {
      if (carriers17TrackCache.items.length > 0) {
        logAt("warn", "carriers_cached_source_failed_using_stale", {
          error: String(e.message || e),
          stale_items: carriers17TrackCache.items.length
        });
        return carriers17TrackCache.items;
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  })();

  try {
    return await carriers17TrackCache.loading;
  } finally {
    carriers17TrackCache.loading = null;
  }
}

app.get("/api/carriers/17track_cached", async (req, res) => {
  const qRaw = String(req.query?.q || "").trim();
  const q = normalizeAliasText(qRaw);
  const rawLimit = Number(req.query?.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100;
  const refresh = String(req.query?.refresh || "").toLowerCase() === "true";
  const ttlMs = Number.isFinite(CARRIERS_17TRACK_CACHE_TTL_MS) && CARRIERS_17TRACK_CACHE_TTL_MS > 0
    ? CARRIERS_17TRACK_CACHE_TTL_MS
    : 24 * 60 * 60 * 1000;

  try {
    const items = await load17TrackCarriersCached(refresh);
    let filtered = items;
    if (q) {
      filtered = items.filter((it) =>
        it.alias.includes(q) ||
        it.base_alias.includes(q) ||
        normalizeAliasText(it.name_en).includes(q)
      );
    }

    const out = filtered
      .sort((a, b) => a.key - b.key)
      .slice(0, limit);

    return res.json({
      ok: true,
      source: "17track_csv_cached",
      query: qRaw || null,
      total: filtered.length,
      count: out.length,
      cache_ttl_ms: ttlMs,
      fetched_at: carriers17TrackCache.fetched_at ? carriers17TrackCache.fetched_at.toISOString() : null,
      items: out
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: "carriers_source_unavailable",
      message: String(e.message || e)
    });
  }
});
// ---- Background scheduler (Step 3) ----
// Enable with: BG_ENABLED=1
// Interval: BG_INTERVAL_MIN (default 15)
// Refresh policy: BG_NORMAL_INTERVAL_MIN (default 45), BG_SLOW_HOURS (default "8,20")
// Rate limit between trackings: BG_DELAY_MS (default 5000)
// Home Assistant notify target:
//   HA_URL (e.g. http://homeassistant:8123 or http://192.168.x.x:8123)
//   HA_TOKEN (Long-Lived Access Token)
//   HA_SCRIPT (script entity/service name without domain, default: jarvis_17track_notify)

const BG_ENABLED = String(process.env.BG_ENABLED || "").trim() === "1";
const BG_INTERVAL_MIN = Number(process.env.BG_INTERVAL_MIN || 15);
const BG_NORMAL_INTERVAL_MIN = Number(process.env.BG_NORMAL_INTERVAL_MIN || 45);
const BG_SLOW_HOURS = String(process.env.BG_SLOW_HOURS || "8,20")
  .split(",")
  .map((x) => Number(String(x).trim()))
  .filter((n) => !isNaN(n));
const BG_DELAY_MS = Number(process.env.BG_DELAY_MS || 5000);

const HA_URL = String(process.env.HA_URL || "").trim().replace(/\/$/, "");
const HA_TOKEN = String(process.env.HA_TOKEN || "").trim();
const HA_SCRIPT = String(process.env.HA_SCRIPT || "jarvis_17track_notify").trim();
const TRACK17_TOKEN = String(process.env.TRACK17_TOKEN || "").trim();

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
  logAt("debug", "ha_service_call_ok", { domain, service });
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

function isPositiveNumber(n) {
  return Number.isFinite(n) && n > 0;
}

function validateStartupConfig() {
  const missing = [];
  if (!TRACK17_TOKEN) missing.push("TRACK17_TOKEN");
  if (!HA_URL) missing.push("HA_URL");
  if (!HA_TOKEN) missing.push("HA_TOKEN");
  if (!HA_SCRIPT) missing.push("HA_SCRIPT");

  const invalid = [];
  if (!isPositiveNumber(Number(process.env.PORT || 8787))) invalid.push("PORT");
  if (!isPositiveNumber(BG_INTERVAL_MIN)) invalid.push("BG_INTERVAL_MIN");
  if (!isPositiveNumber(BG_NORMAL_INTERVAL_MIN)) invalid.push("BG_NORMAL_INTERVAL_MIN");
  if (!isPositiveNumber(BG_DELAY_MS)) invalid.push("BG_DELAY_MS");

  const allowedLogLevels = new Set(Object.keys(LOG_LEVELS));
  if (!allowedLogLevels.has(APP_LOG_LEVEL)) invalid.push("APP_LOG_LEVEL");

  if (missing.length || invalid.length) {
    const details = {
      missing,
      invalid,
      hint: "Revisa la configuración del add-on y completa todos los campos requeridos."
    };
    console.error(`[BOOT] Invalid configuration: ${JSON.stringify(details)}`);
    process.exit(1);
  }
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

    try {
      const carrier = trackingPreferredCarrier(o, tn);
      const { json } = await getTrackInfo(tn, carrier);
      const norm = normalizeGetTrackInfoResponse(json);
      const one = norm.ok && Array.isArray(norm.accepted) && norm.accepted[0] ? norm.accepted[0] : null;

      o.last = o.last || {};
      o.last[tn] = one || { number: tn, latest: null, flags: null, error: norm.ok ? null : norm.error };
      results.push({ tracking: tn, ok: norm.ok, one });
    } catch (e) {
      o.last = o.last || {};
      o.last[tn] = { number: tn, latest: null, flags: null, error: String(e.message || e) };
      results.push({ tracking: tn, ok: false, error: String(e.message || e) });
    }

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
      notifications_sent: 0,
      notified: []
    };

    for (const ownerKey of ownerKeys) {
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

    return { ok: true, ran: true, summary };
  } catch (e) {
    bgState.lastError = String(e.message || e);
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
  return o;
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
  return tCount === 0 && mCount === 0 && lCount === 0;
}

function resolveCarrierKey(aliasOrKey) {
  const raw = String(aliasOrKey || "").trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const alias = raw.toLowerCase();
  return CARRIERS_MAP?.[alias];
}

function metaCarrierKey(meta) {
  const n = Number(meta?.carrier_key);
  return Number.isFinite(n) ? n : undefined;
}

function trackingPreferredCarrier(o, tn) {
  const meta = getTrackingMeta(o, tn);
  return metaCarrierKey(meta);
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
  return Array.isArray(o?.trackings) ? o.trackings.map((x) => normalizeTracking(x)).filter(Boolean) : [];
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
  const carrier = one?.carrierName || "";
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
        location: one.latest.location ?? null
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
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const tns = ownerTrackings(o);
  const last = ownerLastMap(o);

  const items = tns.map((tn) => {
    const meta = getTrackingMeta(o, tn);
    const delivered_override =
      meta?.delivered_override === true || meta?.delivered_override === false
        ? meta.delivered_override
        : null;

    return {
      tracking: tn,
      note: String(meta?.note || "").trim() || "",
      carrier_override: metaCarrierKey(meta) ?? null,
      delivered_override,
      delivered_effective: effectiveIsDelivered(last?.[tn], meta),
      out_for_delivery: effectiveIsOutForDelivery(last?.[tn]),
      one: shortOne(last?.[tn])
    };
  });

  return res.json({ ok: true, owner, count: items.length, items });
});

// Resolve a query to a tracking number by either tracking itself or note/alias.
// Example: /api/owner/david/resolve?q=ropa
app.get("/api/owner/:owner/resolve", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const q = String(req.query?.q || req.query?.query || "");

  const store = loadStore();
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const matches = resolveTrackingQueryAll(o, q, { limit: 5 });
  if (!matches.length) {
    return res.status(404).json({ ok: false, owner, query: q, error: "no_match" });
  }
  const hit = matches[0];
  const last = ownerLastMap(o);
  const meta = getTrackingMeta(o, hit.tracking);
  const delivered_override =
    meta?.delivered_override === true || meta?.delivered_override === false
      ? meta.delivered_override
      : null;

  return res.json({
    ok: true,
    owner,
    query: q,
    tracking: hit.tracking,
    note: hit.note || "",
    score: hit.score,
    matches: matches.map((m) => ({ tracking: m.tracking, note: m.note || "", score: m.score })),
    carrier_override: metaCarrierKey(meta) ?? null,
    delivered_override,
    delivered_effective: effectiveIsDelivered(last?.[hit.tracking], meta),
    out_for_delivery: effectiveIsOutForDelivery(last?.[hit.tracking]),
    one: shortOne(last?.[hit.tracking])
  });
});

app.get("/api/store", (_req, res) => {
  res.json(loadStore());
});

app.post("/api/owner/:owner/tracking", async (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = normalizeTracking(req.body?.tracking || req.query?.tracking || "");
  const note = String(req.body?.note || "").trim();
  const carrierAlias = String(req.body?.carrier_alias || req.query?.carrier_alias || "").trim();
  const carrier = resolveCarrierKey(req.body?.carrier || req.query?.carrier || carrierAlias);
  const registerOnAdd = boolFromAny(getBodyOrQuery(req, "register_on_add"), true);
  const registerStrict = boolFromAny(getBodyOrQuery(req, "register_strict"), false);
  logAt("info", "tracking_add_requested", {
    req_id: req.reqId,
    owner,
    tracking,
    carrier: carrier ?? null,
    register_on_add: registerOnAdd,
    register_strict: registerStrict
  });

  if (!owner || !tracking) return res.status(400).json({ error: "owner y tracking son obligatorios" });

  const store = loadStore();
  const o = ensureOwnerShape(store, owner);

  if (!o.trackings.includes(tracking)) o.trackings.push(tracking);
  if (note) {
    const prev = getTrackingMeta(o, tracking);
    setTrackingMeta(o, tracking, {
      ...prev,
      note,
      ...(Number.isFinite(carrier) ? { carrier_key: carrier } : {})
    });
  } else if (Number.isFinite(carrier)) {
    const prev = getTrackingMeta(o, tracking);
    setTrackingMeta(o, tracking, { ...prev, carrier_key: carrier });
  }

  let registerResult = null;
  if (registerOnAdd) {
    try {
      const r = await register(tracking, carrier);
      const apiCode = Number(r?.json?.code);
      const accepted = Array.isArray(r?.json?.data?.accepted) ? r.json.data.accepted.length : 0;
      const rejected = Array.isArray(r?.json?.data?.rejected) ? r.json.data.rejected.length : 0;
      const registerOk = apiCode === 0 && rejected === 0;
      registerResult = {
        ok: registerOk,
        carrier: carrier ?? null,
        status: r?.status ?? null,
        api_code: Number.isFinite(apiCode) ? apiCode : null,
        accepted,
        rejected,
        response: r?.json ?? null
      };
      if (!registerOk && registerStrict) {
        return res.status(502).json({
          ok: false,
          owner,
          tracking,
          note,
          error: "register_rejected",
          register: registerResult
        });
      }
    } catch (e) {
      const err = String(e.message || e);
      registerResult = { ok: false, carrier: carrier ?? null, error: err };
      logAt("error", "tracking_register_failed", {
        req_id: req.reqId,
        owner,
        tracking,
        carrier: carrier ?? null,
        error: err
      });
      if (registerStrict) {
        return res.status(502).json({
          ok: false,
          owner,
          tracking,
          note,
          error: "register_failed",
          register: registerResult
        });
      }
    }
  }

  saveStore(store);
  logAt("info", "tracking_add_saved", {
    req_id: req.reqId,
    owner,
    tracking,
    register_ok: registerResult?.ok ?? null
  });
  res.json({ ok: true, owner, tracking, note, register: registerResult });
});

// Set or clear a manual delivered override for a tracking number.
// Body: { delivered: true|false|null }
// - true/false forces the delivered flag (useful when 17Track is wrong)
// - null (or missing) clears the override and returns to 17Track-derived flags
app.post("/api/owner/:owner/tracking/:tracking/override", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = String(req.params.tracking || "").trim().toUpperCase();
  const delivered = req.body?.delivered;

  const store = loadStore();
  store.owners[owner] = store.owners[owner] || { trackings: [], meta: {} };
  const o = store.owners[owner];
  o.meta = o.meta && typeof o.meta === "object" ? o.meta : {};
  o.meta[tracking] = o.meta[tracking] && typeof o.meta[tracking] === "object" ? o.meta[tracking] : {};

  if (delivered === true || delivered === false) {
    o.meta[tracking].delivered_override = delivered;
  } else {
    // clear override
    if (o.meta[tracking].delivered_override !== undefined) delete o.meta[tracking].delivered_override;
  }

  saveStore(store);
  logAt("info", "tracking_override_updated", {
    req_id: req.reqId,
    owner,
    tracking,
    delivered_override: o.meta[tracking].delivered_override ?? null
  });
  return res.json({ ok: true, owner, tracking, delivered_override: o.meta[tracking].delivered_override ?? null });
});

// Set or clear a preferred carrier for a tracking.
// Body:
// - { carrier: 100189 } or { carrier_alias: "gls_es" } => set preferred carrier
// - { carrier: null } or { carrier_alias: "" } => clear preferred carrier
app.post("/api/owner/:owner/tracking/:tracking/carrier", async (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = normalizeTracking(req.params.tracking);

  const bodyCarrierRaw = req.body?.carrier;
  const bodyAliasRaw = req.body?.carrier_alias;
  const clearRequested =
    bodyCarrierRaw === null ||
    (bodyCarrierRaw !== undefined && String(bodyCarrierRaw).trim() === "") ||
    (bodyAliasRaw !== undefined && String(bodyAliasRaw).trim() === "");

  const resolvedCarrier = clearRequested ? undefined : resolveCarrierKey(
    bodyCarrierRaw !== undefined ? bodyCarrierRaw : bodyAliasRaw
  );
  if (!clearRequested && !Number.isFinite(resolvedCarrier)) {
    return res.status(400).json({
      ok: false,
      owner,
      tracking,
      error: "invalid_carrier",
      message: "Usa carrier numérico o alias válido (ej: gls_es, dpd, tipsa, asmred)."
    });
  }

  const store = loadStore();
  const o = ensureOwnerShape(store, owner);
  if (!o.trackings.includes(tracking)) o.trackings.push(tracking);

  const prev = getTrackingMeta(o, tracking);
  const next = { ...prev };
  if (clearRequested) delete next.carrier_key;
  else next.carrier_key = resolvedCarrier;
  setTrackingMeta(o, tracking, next);

  let refreshed = false;
  let refresh_error = null;
  let refresh_one = null;
  try {
    const preferred = trackingPreferredCarrier(o, tracking);
    const { json } = await getTrackInfo(tracking, preferred);
    const norm = normalizeGetTrackInfoResponse(json);
    const one = norm.ok && Array.isArray(norm.accepted) && norm.accepted[0] ? norm.accepted[0] : null;
    o.last = o.last || {};
    o.last[tracking] = one || { number: tracking, latest: null, flags: null, error: norm.ok ? null : norm.error };
    refresh_one = one ? shortOne(one) : null;
    refreshed = true;
  } catch (e) {
    refresh_error = String(e.message || e);
  }

  saveStore(store);
  logAt("info", "tracking_carrier_updated", {
    req_id: req.reqId,
    owner,
    tracking,
    carrier_override: clearRequested ? null : resolvedCarrier,
    refreshed,
    refresh_error
  });

  return res.json({
    ok: true,
    owner,
    tracking,
    carrier_override: clearRequested ? null : resolvedCarrier,
    refreshed,
    refresh_error,
    one: refresh_one
  });
});

app.delete("/api/owner/:owner/tracking/:tracking", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = normalizeTracking(req.params.tracking);

  const store = loadStore();
  const o = store.owners[owner];
  if (!o) {
    return res.json({ ok: true, owner, tracking, removed: false, removed_count: 0, reason: "owner_not_found" });
  }

  const before = ownerTrackings(o);
  o.trackings = before.filter((x) => normalizeTracking(x) !== tracking);
  const removedFromTrackings = before.length - o.trackings.length;
  const removedFromMeta = deleteTrackingFromMap(o.meta, tracking);
  const removedFromLast = deleteTrackingFromMap(o.last, tracking);

  if (ownerIsEmpty(o)) delete store.owners[owner];

  saveStore(store);
  logAt("info", "tracking_deleted", {
    req_id: req.reqId,
    owner,
    tracking,
    removed_count: removedFromTrackings,
    removed_meta: removedFromMeta,
    removed_last: removedFromLast
  });
  res.json({
    ok: true,
    owner,
    tracking,
    removed: removedFromTrackings > 0,
    removed_count: removedFromTrackings,
    removed_meta: removedFromMeta,
    removed_last: removedFromLast
  });
});

app.post("/api/track/refresh", async (req, res) => {
  const number = String(req.body?.tracking || "").trim().toUpperCase();
  const carrier = req.body?.carrier ? Number(req.body.carrier) : undefined;

  if (!number) return res.status(400).json({ error: "tracking es obligatorio" });

  try {
    const { json } = await getTrackInfo(number, carrier);
    logAt("info", "track_refresh_done", {
      req_id: req.reqId,
      tracking: number,
      carrier: carrier ?? null,
      api_code: json?.code ?? null
    });
    return res.json(normalizeGetTrackInfoResponse(json));
  } catch (e) {
    logAt("error", "track_refresh_failed", {
      req_id: req.reqId,
      tracking: number,
      carrier: carrier ?? null,
      error: String(e.message || e)
    });
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/track/register", async (req, res) => {
  const number = String(req.body?.tracking || "").trim().toUpperCase();
  const carrier = req.body?.carrier ? Number(req.body.carrier) : undefined;

  if (!number) return res.status(400).json({ error: "tracking es obligatorio" });

  try {
    const r1 = await register(number, carrier);
    const r2 = await getTrackInfo(number, carrier);
    logAt("info", "track_register_done", {
      req_id: req.reqId,
      tracking: number,
      carrier: carrier ?? null,
      register_api_code: r1?.json?.code ?? null,
      refresh_api_code: r2?.json?.code ?? null
    });
    return res.json({
      register: r1.json,
      refresh: normalizeGetTrackInfoResponse(r2.json)
    });
  } catch (e) {
    logAt("error", "track_register_failed", {
      req_id: req.reqId,
      tracking: number,
      carrier: carrier ?? null,
      error: String(e.message || e)
    });
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/owner/:owner/status", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const filter = req.query?.filter; // e.g. reparto|delivered|intransit|...
  const format = String(req.query?.format || "json").toLowerCase(); // json|text

  const store = loadStore();
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
    const lines = items.map((x) => buildStatusLine(x.one, x.note, { delivered_override_applied: x.delivered_override_applied }));
    return res.type("text/plain").send(lines.join("\n"));
  }

  return res.json({
    ok: true,
    owner,
    filter: filter || null,
    count: items.length,
    items: items.map((x) => ({
      tracking: x.tn,
      one: x.one,
      note: x.note,
      delivered_override: (x.meta?.delivered_override === true || x.meta?.delivered_override === false) ? x.meta.delivered_override : null
    }))
  });
});


app.post("/api/owner/:owner/refresh", async (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const delayMs = Number(req.body?.delay_ms ?? 5000); // 5s por defecto

  const store = loadStore();
  const o = store.owners[owner];
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const trackings = Array.isArray(o.trackings) ? o.trackings : [];
  if (trackings.length === 0) return res.json({ ok: true, owner, results: [] });

  const results = [];
  for (let i = 0; i < trackings.length; i++) {
    const tn = String(trackings[i] || "").trim().toUpperCase();
    if (!tn) continue;

    try {
      const carrier = trackingPreferredCarrier(o, tn);
      const { json } = await getTrackInfo(tn, carrier);
      const norm = normalizeGetTrackInfoResponse(json);

      // norm.accepted[0] contiene el estado normalizado
      const one = norm.ok && Array.isArray(norm.accepted) && norm.accepted[0] ? norm.accepted[0] : null;

      results.push({ tracking: tn, ok: norm.ok, one, rejected: norm.rejected, errors: norm.errors });

      // guarda last
      o.last = o.last || {};
      o.last[tn] = one || { number: tn, latest: null, flags: null, error: norm.ok ? null : norm.error };

    } catch (e) {
      results.push({ tracking: tn, ok: false, error: String(e.message || e) });
      o.last = o.last || {};
      o.last[tn] = { number: tn, latest: null, flags: null, error: String(e.message || e) };
    }

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
    try {
      const carrier = trackingPreferredCarrier(o, tn);
      const { json } = await getTrackInfo(tn, carrier);
      const norm = normalizeGetTrackInfoResponse(json);
      const one = norm.ok && Array.isArray(norm.accepted) && norm.accepted[0] ? norm.accepted[0] : null;

      o.last = o.last || {};
      o.last[tn] = one || { number: tn, latest: null, flags: null, error: norm.ok ? null : norm.error };
      results.push({ tracking: tn, ok: norm.ok, one });
    } catch (e) {
      o.last = o.last || {};
      o.last[tn] = { number: tn, latest: null, flags: null, error: String(e.message || e) };
      results.push({ tracking: tn, ok: false, error: String(e.message || e) });
    }

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
  const o = getOwner(store, owner);
  if (!o) return res.status(404).json({ error: "owner no existe" });

  const trackings = Array.isArray(o.trackings) ? o.trackings : [];
  const results = [];

  for (let i = 0; i < trackings.length; i++) {
    const tn = String(trackings[i] || "").trim().toUpperCase();
    if (!tn) continue;

    try {
      const carrier = trackingPreferredCarrier(o, tn);
      const { json } = await getTrackInfo(tn, carrier);
      const norm = normalizeGetTrackInfoResponse(json);
      const one = norm.ok && Array.isArray(norm.accepted) && norm.accepted[0] ? norm.accepted[0] : null;

      o.last = o.last || {};
      o.last[tn] = one || { number: tn, latest: null, flags: null, error: norm.ok ? null : norm.error };

      results.push({ tracking: tn, ok: norm.ok, one });
    } catch (e) {
      o.last = o.last || {};
      o.last[tn] = { number: tn, latest: null, flags: null, error: String(e.message || e) };
      results.push({ tracking: tn, ok: false, error: String(e.message || e) });
    }

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
  if (!BG_ENABLED) return;
  if (bgState.intervalId) return;

  // Run once shortly after boot (helps after restarts / power cuts).
  setTimeout(() => {
    bgRunOnce().catch(() => { });
  }, 10_000);

  bgState.intervalId = setInterval(() => {
    bgRunOnce().catch(() => { });
  }, Math.max(1, BG_INTERVAL_MIN) * 60 * 1000);

  bgState.enabled = true;
  console.log(`[BG] enabled. interval=${BG_INTERVAL_MIN}min normal=${BG_NORMAL_INTERVAL_MIN}min slowHours=${BG_SLOW_HOURS.join(",")}`);
}

const port = process.env.PORT || 8787;
validateStartupConfig();
app.listen(port, () => {
  console.log(`17Track app listening on ${port}`);
  console.log(`[DATA] store path: ${DATA_DIR}/${STORE_FILE}`);
  console.log(`[APP] log level: ${APP_LOG_LEVEL}`);
  startBackgroundIfEnabled();
});
