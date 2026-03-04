#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function normalizeTracking(v) {
  return String(v || "").trim().toUpperCase();
}

function findByNormalizedKey(mapObj, tracking) {
  if (!mapObj || typeof mapObj !== "object") return undefined;
  const key = normalizeTracking(tracking);
  for (const [k, v] of Object.entries(mapObj)) {
    if (normalizeTracking(k) === key) return v;
  }
  return undefined;
}

function deleteByNormalizedKey(mapObj, tracking) {
  if (!mapObj || typeof mapObj !== "object") return 0;
  const key = normalizeTracking(tracking);
  let removed = 0;
  for (const k of Object.keys(mapObj)) {
    if (normalizeTracking(k) === key) {
      delete mapObj[k];
      removed += 1;
    }
  }
  return removed;
}

function readStore(storePath) {
  const raw = fs.readFileSync(storePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("store_invalid_json_object");
  }
  parsed.owners = parsed.owners && typeof parsed.owners === "object" ? parsed.owners : {};
  return parsed;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = String(process.env.DATA_DIR || path.join(process.cwd(), "data"));
  const storePath = String(process.env.STORE_PATH || path.join(dataDir, "store.json"));

  if (!fs.existsSync(storePath)) {
    console.log(JSON.stringify({
      ok: true,
      changed: false,
      reason: "store_not_found",
      store_path: storePath
    }));
    return;
  }

  const store = readStore(storePath);
  const owners = store.owners;
  const summary = {
    ok: true,
    dry_run: dryRun,
    changed: false,
    store_path: storePath,
    owners_scanned: 0,
    owners_changed: 0,
    removed_trackings: 0,
    removed_meta_entries: 0,
    removed_last_entries: 0,
    removed_announced_entries: 0,
    backup_path: null
  };

  for (const owner of Object.keys(owners)) {
    summary.owners_scanned += 1;
    const o = owners[owner];
    if (!o || typeof o !== "object") continue;

    const currentTrackings = Array.isArray(o.trackings)
      ? o.trackings.map((x) => normalizeTracking(x)).filter(Boolean)
      : [];
    const keep = [];
    const remove = [];

    for (const tn of currentTrackings) {
      const meta = findByNormalizedKey(o.meta, tn);
      const source = String(meta?.source || "").trim().toLowerCase();
      if (source === "imap") keep.push(tn);
      else remove.push(tn);
    }

    if (!remove.length) {
      // Ensure normalized deduplicated tracking list even if nothing removed.
      o.trackings = [...new Set(keep)];
      continue;
    }

    summary.changed = true;
    summary.owners_changed += 1;
    summary.removed_trackings += remove.length;
    o.trackings = [...new Set(keep)];

    for (const tn of remove) {
      summary.removed_meta_entries += deleteByNormalizedKey(o.meta, tn);
      summary.removed_last_entries += deleteByNormalizedKey(o.last, tn);
      const announcedMap =
        o?.announced &&
        typeof o.announced === "object" &&
        o.announced.out_for_delivery &&
        typeof o.announced.out_for_delivery === "object"
          ? o.announced.out_for_delivery
          : null;
      if (announcedMap?.[tn]) {
        delete announcedMap[tn];
        summary.removed_announced_entries += 1;
      }
    }
  }

  if (summary.changed && !dryRun) {
    const backupPath = `${storePath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(storePath, backupPath);
    fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    summary.backup_path = backupPath;
  }

  console.log(JSON.stringify(summary));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message || error)
  }));
  process.exit(1);
}

