const express = require("express");
const { readJson, writeJson } = require("./storage");
const { getTrackInfo, register, normalizeGetTrackInfoResponse } = require("./track17");

const STORE_FILE = "store.json";

function loadStore() { return readJson(STORE_FILE, { owners: {} }); }
function saveStore(store) { writeJson(STORE_FILE, store); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/carriers", (_req, res) => res.json({ carriers_map: {} }));

function getOwner(store, owner) {
  const o = store.owners?.[owner];
  return o && typeof o === "object" ? o : null;
}

function buildStatusLine(one, note) {
  const tn = one?.number || "";
  const desc = one?.latest?.description || "";
  const st = one?.latest?.status || "";
  const carrier = one?.carrierName || "";
  const loc = one?.latest?.location || "";
  const extra = [carrier, loc].filter(Boolean).join(" · ");
  const right = desc || st || "(sin datos)";
  const left = note ? `${tn} (${note})` : tn;
  return `- ${left}: ${right}${extra ? ` — ${extra}` : ""}`;
}

function matchesFilter(one, filter) {
  if (!filter) return true;
  const f = String(filter).toLowerCase();

  if (f === "out_for_delivery" || f === "reparto") return !!one?.flags?.isOutForDelivery;
  if (f === "delivered" || f === "entregado") return !!one?.flags?.isDelivered;

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
    .map((tn) => ({ tn, one: last[tn], note: meta?.[tn]?.note || "" }))
    .filter((x) => x.one && matchesFilter(x.one, filter));

  if (format === "text") {
    const lines = items.map((x) => buildStatusLine(x.one, x.note));
    return res.type("text/plain").send(lines.join("\n"));
  }

  return res.json({ ok: true, owner, filter: filter || null, count: items.length, items });
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

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`17Track app listening on ${port}`);
});
