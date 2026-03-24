const state = {
  owners: [],
  apiKey: localStorage.getItem("paquetes_app_api_key") || "",
  search: ""
};

const refreshButton = document.getElementById("refreshButton");
const authToggleButton = document.getElementById("authToggleButton");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
const clearApiKeyButton = document.getElementById("clearApiKeyButton");
const apiKeyInput = document.getElementById("apiKeyInput");
const authPanel = document.getElementById("authPanel");
const searchInput = document.getElementById("searchInput");
const ownersRoot = document.getElementById("ownersRoot");
const statsBar = document.getElementById("statsBar");
const statusBar = document.getElementById("statusBar");
const ownerTemplate = document.getElementById("ownerTemplate");
const itemTemplate = document.getElementById("itemTemplate");

apiKeyInput.value = state.apiKey;

function setStatus(message, type = "info") {
  if (!message) {
    statusBar.textContent = "";
    statusBar.classList.add("hidden");
    statusBar.dataset.type = "";
    return;
  }
  statusBar.textContent = message;
  statusBar.dataset.type = type;
  statusBar.classList.remove("hidden");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function buildHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.apiKey) headers["X-API-Key"] = state.apiKey;
  return headers;
}

async function apiFetch(url, options = {}) {
  const headers = buildHeaders(options.headers || {});
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    authPanel.classList.remove("hidden");
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `http_${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

function effectiveStatusLabel(item) {
  const description = item?.one?.latest?.description;
  const status = item?.one?.latest?.status;
  return description || status || "Sin estado";
}

function matchesSearch(item, search) {
  if (!search) return true;
  const haystack = [
    item.owner,
    item.tracking,
    item.note,
    item.carrier_name,
    item.carrier_name_detected,
    item.imap_account,
    item.one?.latest?.status,
    item.one?.latest?.description
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function renderStats(owners) {
  const flatItems = owners.flatMap((owner) => owner.items);
  const delivered = flatItems.filter((item) => item.delivered_effective).length;
  const pending = flatItems.length - delivered;
  const chips = [
    `Owners: ${owners.length}`,
    `Paquetes: ${flatItems.length}`,
    `Pendientes: ${pending}`,
    `Delivered: ${delivered}`
  ];
  statsBar.innerHTML = chips.map((label) => `<span class="stat-chip">${escapeHtml(label)}</span>`).join("");
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

function withBusy(buttons, isBusy) {
  buttons.forEach((button) => {
    button.disabled = isBusy;
  });
}

async function updateTrackingMeta(owner, tracking, payload) {
  return apiFetch(`/api/owner/${encodeURIComponent(owner)}/tracking/${encodeURIComponent(tracking)}/meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function updateDeliveredOverride(owner, tracking, delivered) {
  return apiFetch(`/api/owner/${encodeURIComponent(owner)}/tracking/${encodeURIComponent(tracking)}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delivered })
  });
}

async function deleteTracking(owner, tracking) {
  return apiFetch(`/api/owner/${encodeURIComponent(owner)}/tracking/${encodeURIComponent(tracking)}`, {
    method: "DELETE"
  });
}

function renderOwners() {
  const normalizedSearch = state.search.trim().toLowerCase();
  const owners = state.owners
    .map((owner) => ({
      ...owner,
      items: owner.items.filter((item) => matchesSearch(item, normalizedSearch))
    }))
    .filter((owner) => owner.items.length > 0);

  renderStats(owners);
  ownersRoot.innerHTML = "";

  if (!owners.length) {
    ownersRoot.innerHTML = '<div class="empty-state">No hay paquetes que coincidan con el filtro actual.</div>';
    return;
  }

  for (const owner of owners) {
    const ownerNode = ownerTemplate.content.firstElementChild.cloneNode(true);
    ownerNode.querySelector(".owner-title").textContent = owner.owner;
    ownerNode.querySelector(".owner-meta").textContent =
      `${owner.pending_count} pendientes · ${owner.delivered_count} delivered · ${owner.count} total`;
    ownerNode.querySelector(".owner-chip").textContent = `${owner.items.length} visibles`;

    const itemsRoot = ownerNode.querySelector(".owner-items");
    for (const item of owner.items) {
      const itemNode = itemTemplate.content.firstElementChild.cloneNode(true);
      const noteInput = itemNode.querySelector(".note-input");
      const carrierInput = itemNode.querySelector(".carrier-input");
      const saveButton = itemNode.querySelector(".save-button");
      const deliveredButton = itemNode.querySelector(".delivered-button");
      const undeliveredButton = itemNode.querySelector(".undelivered-button");
      const deleteButton = itemNode.querySelector(".delete-button");
      const buttons = [saveButton, deliveredButton, undeliveredButton, deleteButton];

      itemNode.querySelector(".item-id").textContent = item.tracking;
      itemNode.querySelector(".item-account").textContent = item.imap_account || "Cuenta no asociada";
      itemNode.querySelector(".status-pill").textContent = effectiveStatusLabel(item);

      const statePill = itemNode.querySelector(".state-pill");
      statePill.dataset.state = item.delivered_effective ? "delivered" : "pending";
      statePill.textContent = item.delivered_effective ? "Delivered" : "Pendiente";

      noteInput.value = item.note || "";
      carrierInput.value = item.carrier_name_override || item.carrier_name || "";
      carrierInput.placeholder = item.carrier_name_detected || "Courier editable";

      const details = [
        `<div class="detail-row"><strong>Courier detectado:</strong> ${escapeHtml(item.carrier_name_detected || "Sin detectar")}</div>`,
        `<div class="detail-row"><strong>Estado base:</strong> ${escapeHtml(item.one?.latest?.status || "Sin estado")}</div>`,
        `<div class="detail-row"><strong>Ultimo evento:</strong> ${escapeHtml(item.one?.latest?.description || "Sin descripcion")}</div>`,
        `<div class="detail-row"><strong>Fecha:</strong> ${escapeHtml(formatWhen(item.one?.latest?.time || item.delivered_at))}</div>`
      ];
      itemNode.querySelector(".item-details").innerHTML = details.join("");

      saveButton.addEventListener("click", async () => {
        try {
          withBusy(buttons, true);
          await updateTrackingMeta(item.owner, item.tracking, {
            note: noteInput.value,
            carrier_name: carrierInput.value
          });
          setStatus(`Guardado ${item.tracking} (${item.owner}).`);
          await loadOwners();
        } catch (error) {
          setStatus(`No se pudo guardar ${item.tracking}: ${error.message}`, "error");
        } finally {
          withBusy(buttons, false);
        }
      });

      deliveredButton.addEventListener("click", async () => {
        try {
          withBusy(buttons, true);
          await updateDeliveredOverride(item.owner, item.tracking, true);
          setStatus(`Marcado como delivered: ${item.tracking}.`);
          await loadOwners();
        } catch (error) {
          setStatus(`No se pudo marcar delivered ${item.tracking}: ${error.message}`, "error");
        } finally {
          withBusy(buttons, false);
        }
      });

      undeliveredButton.addEventListener("click", async () => {
        try {
          withBusy(buttons, true);
          await updateDeliveredOverride(item.owner, item.tracking, false);
          setStatus(`Marcado como undelivered: ${item.tracking}.`);
          await loadOwners();
        } catch (error) {
          setStatus(`No se pudo marcar undelivered ${item.tracking}: ${error.message}`, "error");
        } finally {
          withBusy(buttons, false);
        }
      });

      deleteButton.addEventListener("click", async () => {
        const confirmed = window.confirm(`Borrar ${item.tracking} de ${item.owner}?`);
        if (!confirmed) return;
        try {
          withBusy(buttons, true);
          await deleteTracking(item.owner, item.tracking);
          setStatus(`Borrado ${item.tracking}.`);
          await loadOwners();
        } catch (error) {
          setStatus(`No se pudo borrar ${item.tracking}: ${error.message}`, "error");
        } finally {
          withBusy(buttons, false);
        }
      });

      itemsRoot.appendChild(itemNode);
    }

    ownersRoot.appendChild(ownerNode);
  }
}

async function loadOwners() {
  refreshButton.disabled = true;
  try {
    const payload = await apiFetch("/api/ui/owners");
    state.owners = Array.isArray(payload.owners) ? payload.owners : [];
    renderOwners();
    setStatus(`Vista cargada. Retencion delivered: ${payload.delivered_retention_days} dias.`);
  } catch (error) {
    if (error.message === "unauthorized") {
      setStatus("La UI necesita API key para consultar el backend.", "error");
    } else {
      setStatus(`No se pudo cargar la vista: ${error.message}`, "error");
    }
    ownersRoot.innerHTML = '<div class="empty-state">No hemos podido cargar los paquetes todavia.</div>';
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  loadOwners();
});

authToggleButton.addEventListener("click", () => {
  authPanel.classList.toggle("hidden");
});

saveApiKeyButton.addEventListener("click", async () => {
  state.apiKey = apiKeyInput.value.trim();
  localStorage.setItem("paquetes_app_api_key", state.apiKey);
  await loadOwners();
});

clearApiKeyButton.addEventListener("click", async () => {
  state.apiKey = "";
  apiKeyInput.value = "";
  localStorage.removeItem("paquetes_app_api_key");
  await loadOwners();
});

searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  renderOwners();
});

loadOwners();
