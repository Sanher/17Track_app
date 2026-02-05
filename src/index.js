const express = require("express");
const { readJson, writeJson } = require("./storage");

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
