const state = {
  me: null,
  items: [],
  couriers: [],
  refreshPollId: null,
  theme: "light"
};

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const THEME_STORAGE_KEY = "tg_paquetes_theme";

const userMeta = document.getElementById("userMeta");
const appRoot = document.getElementById("appRoot");
const lockedPanel = document.getElementById("lockedPanel");
const lockedMessage = document.getElementById("lockedMessage");
const statusBar = document.getElementById("statusBar");
const listRoot = document.getElementById("listRoot");
const itemTemplate = document.getElementById("itemTemplate");
const refreshMailButton = document.getElementById("refreshMailButton");
const statusFilter = document.getElementById("statusFilter");
const courierFilter = document.getElementById("courierFilter");
const aliasFilter = document.getElementById("aliasFilter");
const sortFilter = document.getElementById("sortFilter");
const themeToggleButton = document.getElementById("themeToggleButton");
const backToTopButton = document.getElementById("backToTopButton");

function setStatus(message, isError = false) {
  if (!message) {
    statusBar.textContent = "";
    statusBar.classList.add("hidden");
    statusBar.classList.remove("is-error");
    return;
  }
  statusBar.textContent = message;
  statusBar.classList.remove("hidden");
  statusBar.classList.toggle("is-error", !!isError);
}

function setAccessState(isAuthorized, message = "") {
  appRoot.classList.toggle("hidden", !isAuthorized);
  lockedPanel.classList.toggle("hidden", isAuthorized);
  if (!isAuthorized) {
    lockedMessage.textContent = message || "Acceso no disponible.";
    listRoot.innerHTML = "";
    state.items = [];
    state.couriers = [];
  }
}

function setMailRefreshBusy(isBusy) {
  refreshMailButton.disabled = isBusy;
  refreshMailButton.textContent = isBusy ? "Refrescando..." : "Refrescar correo";
}

function preferredTheme() {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (tg && tg.colorScheme === "dark") return "dark";
  return "light";
}

function applyTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  window.localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  themeToggleButton.textContent = state.theme === "dark" ? "Modo claro" : "Modo oscuro";
}

function toggleTheme() {
  applyTheme(state.theme === "dark" ? "light" : "dark");
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

async function loadRefreshStatus() {
  return apiFetch("/api/telegram/imap/status");
}

function stopRefreshPolling() {
  if (state.refreshPollId) {
    window.clearInterval(state.refreshPollId);
    state.refreshPollId = null;
  }
}

function startRefreshPolling() {
  stopRefreshPolling();
  state.refreshPollId = window.setInterval(async () => {
    try {
      const status = await loadRefreshStatus();
      if (status.running) return;

      stopRefreshPolling();
      setMailRefreshBusy(false);
      if (status.last_exit_code === 0 || status.last_exit_code === null) {
        setStatus("Refresco de correo completado. Actualizando paquetes...");
        await loadTrackings();
        setStatus("Paquetes actualizados.");
      } else {
        setStatus("El refresco de correo terminó con error. Revisa los logs del add-on.", true);
      }
    } catch (error) {
      stopRefreshPolling();
      setMailRefreshBusy(false);
      setStatus(`No se pudo comprobar el refresco: ${error.message}`, true);
    }
  }, 4000);
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
    updateBackToTopVisibility();
    return;
  }

  listRoot.innerHTML = "";
  for (const item of state.items) {
    const node = itemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.state = item.status;
    node.querySelector(".tracking").textContent = item.tracking;
    node.querySelector(".owner").textContent = item.owner;
    node.querySelector(".alias").textContent = item.alias || "Sin alias";
    node.querySelector(".courier").textContent = item.courier || "Sin courier";
    node.querySelector(".sender").textContent = item.sender || "Sin remitente";
    node.querySelector(".event").textContent = item.last_event || "Sin estado";
    node.querySelector(".when").textContent = formatWhen(item.last_time);

    const pill = node.querySelector(".pill");
    pill.textContent = item.status_label || item.status;
    pill.dataset.state = item.status;

    const deliveredButton = node.querySelector(".delivered-button");
    const notPackageButton = node.querySelector(".not-package-button");
    deliveredButton.disabled = !!item.delivered_effective;
    if (item.delivered_effective) deliveredButton.textContent = "Ya entregado";
    deliveredButton.addEventListener("click", async () => {
      notPackageButton.disabled = true;
      deliveredButton.disabled = true;
      setStatus(`Marcando ${item.tracking} como delivered...`);
      try {
        await apiFetch(`/api/telegram/tracking/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.tracking)}/delivered`, {
          method: "POST"
        });
        setStatus(`Paquete ${item.tracking} marcado como delivered.`);
        await loadTrackings();
      } catch (error) {
        notPackageButton.disabled = false;
        deliveredButton.disabled = false;
        setStatus(`No se pudo marcar ${item.tracking}: ${error.message}`, true);
      }
    });

    notPackageButton.addEventListener("click", async () => {
      notPackageButton.disabled = true;
      deliveredButton.disabled = true;
      setStatus(`Marcando ${item.tracking} como no paquete...`);
      try {
        await apiFetch(`/api/telegram/tracking/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.tracking)}/not_package`, {
          method: "POST"
        });
        setStatus(`Paquete ${item.tracking} marcado como no paquete.`);
        await loadTrackings();
      } catch (error) {
        notPackageButton.disabled = false;
        deliveredButton.disabled = !!item.delivered_effective;
        setStatus(`No se pudo marcar ${item.tracking} como no paquete: ${error.message}`, true);
      }
    });

    listRoot.appendChild(node);
  }
  updateBackToTopVisibility();
}

function updateBackToTopVisibility() {
  const cards = listRoot.querySelectorAll(".card");
  if (!cards.length) {
    backToTopButton.classList.add("hidden");
    return;
  }

  const thresholdCard = cards[1] || cards[0];
  const threshold = thresholdCard.offsetTop + thresholdCard.offsetHeight;
  backToTopButton.classList.toggle("hidden", window.scrollY < threshold);
}

async function bootstrap() {
  applyTheme(preferredTheme());
  if (tg) {
    tg.ready();
    tg.expand();
  }

  setAccessState(false, "Validando sesion de Telegram...");
  try {
    state.me = await ensureTelegramSession();
    setAccessState(true);
    userMeta.textContent = `Acceso para ${state.me.display_name}`;
    setStatus("Cargando mini app...");
    await loadTrackings();
    setStatus("");
  } catch (error) {
    setAccessState(false, tg
      ? `No se pudo abrir la mini app: ${error.message}`
      : "Esta vista debe abrirse desde Telegram."
    );
    const message = tg
      ? `No se pudo abrir la mini app: ${error.message}`
      : "Esta vista debe abrirse desde Telegram o con una sesion ya iniciada.";
    userMeta.textContent = "Acceso restringido";
    setStatus(message, true);
  }
}

refreshMailButton.addEventListener("click", async () => {
  setMailRefreshBusy(true);
  setStatus("Lanzando refresco de correo. Puede tardar unos momentos...");
  try {
    const result = await apiFetch("/api/telegram/imap/refresh", { method: "POST" });
    setStatus(result.message || "Refresco de correo lanzado. Puede tardar unos momentos.");
    if (result.started === false && result.reason === "already_running") {
      startRefreshPolling();
      return;
    }
    startRefreshPolling();
  } catch (error) {
    setMailRefreshBusy(false);
    setStatus(`No se pudo lanzar el refresco: ${error.message}`, true);
  }
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

themeToggleButton.addEventListener("click", toggleTheme);

backToTopButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

window.addEventListener("scroll", updateBackToTopVisibility, { passive: true });

bootstrap();
