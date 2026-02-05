const express = require("express");
const { readJson, writeJson } = require("./storage");
const { getTrackInfo, register, normalizeGetTrackInfoResponse } = require("./track17");

const STORE_FILE = "store.json";
const app = express();

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/carriers", (_req, res) => res.json({ carriers_map: {} }));

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`17Track app listening on ${port}`);
});

// store: { owners: { david: { trackings: [], meta: {} }, mireia: {...} } }
function loadStore() {
  return readJson(STORE_FILE, { owners: {} });
}
function saveStore(store) {
  writeJson(STORE_FILE, store);
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


