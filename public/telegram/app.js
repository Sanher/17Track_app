const state = {
  me: null,
  items: [],
  couriers: []
};

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const userMeta = document.getElementById("userMeta");
const statusBar = document.getElementById("statusBar");
const listRoot = document.getElementById("listRoot");
const itemTemplate = document.getElementById("itemTemplate");
const refreshButton = document.getElementById("refreshButton");
const statusFilter = document.getElementById("statusFilter");
const courierFilter = document.getElementById("courierFilter");
const aliasFilter = document.getElementById("aliasFilter");
const sortFilter = document.getElementById("sortFilter");

function setStatus(message, isError = false) {
  if (!message) {
    statusBar.textContent = "";
    statusBar.classList.add("hidden");
    return;
  }
  statusBar.textContent = message;
  statusBar.classList.remove("hidden");
  statusBar.style.color = isError ? "#8c3112" : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatWhen(value) {
  if (!value) return "Sin fecha";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-ES", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");

  if (!response.ok) {
    const error = typeof payload === "string" ? payload : payload?.error || `http_${response.status}`;
    throw new Error(error);
  }
  return payload;
}

async function ensureTelegramSession() {
  try {
    return await apiFetch("/api/telegram/me");
  } catch (error) {
    if (!tg || !tg.initData) throw error;
  }

  await apiFetch("/api/telegram/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: tg.initData })
  });
  return apiFetch("/api/telegram/me");
}

async function loadTrackings() {
  const params = new URLSearchParams();
  if (statusFilter.value) params.set("status", statusFilter.value);
  if (courierFilter.value) params.set("courier", courierFilter.value);
  if (aliasFilter.value.trim()) params.set("alias", aliasFilter.value.trim());
  if (sortFilter.value) params.set("sort", sortFilter.value);
  const query = params.toString();

  const payload = await apiFetch(`/api/telegram/trackings${query ? `?${query}` : ""}`);
  state.items = Array.isArray(payload.items) ? payload.items : [];
  state.couriers = Array.isArray(payload.couriers) ? payload.couriers : [];
  renderCourierOptions();
  renderItems();
}

function renderCourierOptions() {
  const current = courierFilter.value;
  courierFilter.innerHTML = `<option value="">Todos</option>${state.couriers
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("")}`;
  if (state.couriers.includes(current)) courierFilter.value = current;
}

function renderItems() {
  if (!state.items.length) {
    listRoot.innerHTML = `<section class="panel">No hay paquetes visibles para estos filtros.</section>`;
    return;
  }

  listRoot.innerHTML = "";
  for (const item of state.items) {
    const node = itemTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".tracking").textContent = item.tracking;
    node.querySelector(".owner").textContent = item.owner;
    node.querySelector(".alias").textContent = item.alias || "Sin alias";
    node.querySelector(".courier").textContent = item.courier || "Sin courier";
    node.querySelector(".event").textContent = item.last_event || "Sin estado";
    node.querySelector(".when").textContent = formatWhen(item.last_time);

    const pill = node.querySelector(".pill");
    pill.textContent = item.status_label || item.status;
    pill.dataset.state = item.status;

    const deliveredButton = node.querySelector(".delivered-button");
    deliveredButton.disabled = !!item.delivered_effective;
    if (item.delivered_effective) deliveredButton.textContent = "Ya entregado";
    deliveredButton.addEventListener("click", async () => {
      deliveredButton.disabled = true;
      setStatus(`Marcando ${item.tracking} como delivered...`);
      try {
        await apiFetch(`/api/telegram/tracking/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.tracking)}/delivered`, {
          method: "POST"
        });
        setStatus(`Paquete ${item.tracking} marcado como delivered.`);
        await loadTrackings();
      } catch (error) {
        deliveredButton.disabled = false;
        setStatus(`No se pudo marcar ${item.tracking}: ${error.message}`, true);
      }
    });

    listRoot.appendChild(node);
  }
}

async function bootstrap() {
  if (tg) {
    tg.ready();
    tg.expand();
  }

  setStatus("Cargando mini app...");
  try {
    state.me = await ensureTelegramSession();
    userMeta.textContent = `Acceso para ${state.me.display_name} · owners: ${(state.me.owners || []).join(", ")}`;
    await loadTrackings();
    setStatus("");
  } catch (error) {
    const message = tg
      ? `No se pudo abrir la mini app: ${error.message}`
      : "Esta vista debe abrirse desde Telegram o con una sesion ya iniciada.";
    setStatus(message, true);
  }
}

refreshButton.addEventListener("click", () => {
  loadTrackings().catch((error) => setStatus(`No se pudo actualizar: ${error.message}`, true));
});

for (const control of [statusFilter, courierFilter, sortFilter]) {
  control.addEventListener("change", () => {
    loadTrackings().catch((error) => setStatus(`No se pudo aplicar el filtro: ${error.message}`, true));
  });
}

aliasFilter.addEventListener("input", () => {
  window.clearTimeout(aliasFilter._debounceId);
  aliasFilter._debounceId = window.setTimeout(() => {
    loadTrackings().catch((error) => setStatus(`No se pudo aplicar el alias: ${error.message}`, true));
  }, 220);
});

bootstrap();
