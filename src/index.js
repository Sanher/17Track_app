const express = require("express");
const { readJson, writeJson } = require("./storage");
const { getTrackInfo, register, normalizeGetTrackInfoResponse } = require("./track17");
const { CARRIERS } = require("./carriers");

const STORE_FILE = "store.json";

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

app.get("/health", (_req, res) => res.json({ ok: true }));

// Carriers live in ./carriers.js for easier maintenance (names + keys).
// CARRIERS: { alias: { key, name }, ... }
const CARRIERS_MAP = Object.fromEntries(
  Object.entries(CARRIERS).map(([alias, v]) => [alias, v.key])
);

// Expose the full carriers object so clients can show friendly names.
app.get("/api/carriers", (_req, res) => res.json({ carriers: CARRIERS }));
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
      const { json } = await getTrackInfo(tn);
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

function getMeta(o) {
  return o && o.meta && typeof o.meta === "object" ? o.meta : {};
}

function getTrackingMeta(o, tn) {
  const meta = getMeta(o);
  const m = meta?.[tn];
  return m && typeof m === "object" ? m : {};
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
  return Array.isArray(o?.trackings) ? o.trackings.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean) : [];
}

function ownerLastMap(o) {
  return o?.last && typeof o.last === "object" ? o.last : {};
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

app.get("/api/store", (_req, res) => {
  res.json(loadStore());
});

app.post("/api/owner/:owner/tracking", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = String(req.body?.tracking || "").trim().toUpperCase();
  const note = String(req.body?.note || "").trim();

  if (!owner || !tracking) return res.status(400).json({ error: "owner y tracking son obligatorios" });

  const store = loadStore();
  store.owners[owner] = store.owners[owner] || { trackings: [], meta: {} };
  const o = store.owners[owner];

  if (!o.trackings.includes(tracking)) o.trackings.push(tracking);
  if (note) o.meta[tracking] = { ...(o.meta[tracking] || {}), note };

  saveStore(store);
  res.json({ ok: true, owner, tracking, note });
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
  return res.json({ ok: true, owner, tracking, delivered_override: o.meta[tracking].delivered_override ?? null });
});

app.delete("/api/owner/:owner/tracking/:tracking", (req, res) => {
  const owner = String(req.params.owner || "").trim().toLowerCase();
  const tracking = String(req.params.tracking || "").trim().toUpperCase();

  const store = loadStore();
  const o = store.owners[owner];
  if (!o) return res.json({ ok: true });

  o.trackings = (o.trackings || []).filter((x) => x !== tracking);
  if (o.meta && o.meta[tracking]) delete o.meta[tracking];

  saveStore(store);
  res.json({ ok: true, owner, tracking });
});

app.post("/api/track/refresh", async (req, res) => {
  const number = String(req.body?.tracking || "").trim().toUpperCase();
  const carrier = req.body?.carrier ? Number(req.body.carrier) : undefined;

  if (!number) return res.status(400).json({ error: "tracking es obligatorio" });

  try {
    const { json } = await getTrackInfo(number, carrier);
    return res.json(normalizeGetTrackInfoResponse(json));
  } catch (e) {
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
    return res.json({
      register: r1.json,
      refresh: normalizeGetTrackInfoResponse(r2.json)
    });
  } catch (e) {
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
      const { json } = await getTrackInfo(tn);
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
      const { json } = await getTrackInfo(tn);
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
      const { json } = await getTrackInfo(tn);
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
app.listen(port, () => {
  console.log(`17Track app listening on ${port}`);
  startBackgroundIfEnabled();
});
