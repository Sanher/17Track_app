const API = "https://api.17track.net/track/v2.2";

function getToken() {
  const t = process.env.TRACK17_TOKEN || "";
  if (!t) throw new Error("Falta TRACK17_TOKEN en variables de entorno");
  return t;
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "17token": getToken(),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function getTrackInfo(number, carrier) {
  const payload = carrier
    ? [{ number, carrier }]
    : [{ number }];
  return post("/gettrackinfo", payload);
}

async function register(number, carrier) {
  const payload = carrier
    ? [{ number, carrier }]
    : [{ number }];
  return post("/register", payload);
}

function pick(obj, path, fallback = "") {
  try {
    return path.split(".").reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj) ?? fallback;
  } catch {
    return fallback;
  }
}

// Normaliza una respuesta aceptada en algo útil
function normalizeAccepted(a0) {
  const number = a0?.number || "";
  const carrierKey = a0?.carrier ?? null;

  const carrierName =
    String(pick(a0, "track_info.tracking.providers.0.provider.name", "")).trim();

  const carrierCountry =
    String(pick(a0, "track_info.tracking.providers.0.provider.country", "")).trim();

  const latestStatus =
    String(pick(a0, "track_info.shipping_info.latest_status.status", "")).trim();

  const latestSub =
    String(pick(a0, "track_info.shipping_info.latest_status.sub_status", "")).trim();

  const latestDesc =
    String(pick(a0, "track_info.shipping_info.latest_event.description", "")).trim();

  const latestTime =
    String(pick(a0, "track_info.shipping_info.latest_event.time_iso", "")).trim();

  const latestLoc =
    String(pick(a0, "track_info.shipping_info.latest_event.location", "")).trim();

  // Heurística “en reparto”
  const d = latestDesc.toLowerCase();
  const isOutForDelivery =
    latestStatus === "OutForDelivery" ||
    latestSub.toLowerCase().includes("outfordelivery") ||
    d.includes("en reparto") ||
    d.includes("out for delivery");

  // Entregado
  const isDelivered =
    latestStatus === "Delivered" ||
    latestSub.toLowerCase().includes("delivered") ||
    d.includes("entregado") ||
    d.includes("delivered");

  return {
    number,
    carrierKey,
    carrierName: carrierName || null,
    carrierCountry: carrierCountry || null,
    latest: {
      status: latestStatus || null,
      subStatus: latestSub || null,
      description: latestDesc || null,
      time: latestTime || null,
      location: latestLoc || null
    },
    flags: { isOutForDelivery, isDelivered }
  };
}

function normalizeGetTrackInfoResponse(json) {
  if (!json || typeof json !== "object") return { ok: false, error: "Respuesta inválida" };
  if (json.code !== 0) {
    return { ok: false, error: `API error code ${json.code}`, raw: json };
  }

  const accepted = pick(json, "data.accepted", []);
  const rejected = pick(json, "data.rejected", []);
  const errors = pick(json, "data.errors", []);

  return {
    ok: true,
    accepted: Array.isArray(accepted) ? accepted.map(normalizeAccepted) : [],
    rejected,
    errors,
    raw: json
  };
}

module.exports = {
  getTrackInfo,
  register,
  normalizeGetTrackInfoResponse
};
