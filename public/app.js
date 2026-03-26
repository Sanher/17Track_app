const state = {
  owners: [],
  apiKey: localStorage.getItem("paquetes_app_api_key") || "",
  search: "",
  dateFrom: "",
  dateTo: "",
  selectedKeys: new Set(),
  theme: localStorage.getItem("paquetes_app_theme") || ""
};

const themeToggleButton = document.getElementById("themeToggleButton");
const refreshButton = document.getElementById("refreshButton");
const authToggleButton = document.getElementById("authToggleButton");
const saveApiKeyButton = document.getElementById("saveApiKeyButton");
const clearApiKeyButton = document.getElementById("clearApiKeyButton");
const apiKeyInput = document.getElementById("apiKeyInput");
const authPanel = document.getElementById("authPanel");
const searchInput = document.getElementById("searchInput");
const dateFromInput = document.getElementById("dateFromInput");
const dateToInput = document.getElementById("dateToInput");
const clearFiltersButton = document.getElementById("clearFiltersButton");
const ownersRoot = document.getElementById("ownersRoot");
const statsBar = document.getElementById("statsBar");
const statusBar = document.getElementById("statusBar");
const ownerTemplate = document.getElementById("ownerTemplate");
const itemTemplate = document.getElementById("itemTemplate");
const selectionBar = document.getElementById("selectionBar");
const selectionSummary = document.getElementById("selectionSummary");
const selectVisibleButton = document.getElementById("selectVisibleButton");
const clearSelectionButton = document.getElementById("clearSelectionButton");
const bulkDeliveredButton = document.getElementById("bulkDeliveredButton");
const bulkUndeliveredButton = document.getElementById("bulkUndeliveredButton");
const bulkNotPackageButton = document.getElementById("bulkNotPackageButton");
const bulkDeleteButton = document.getElementById("bulkDeleteButton");
const olderThanDaysInput = document.getElementById("olderThanDaysInput");
const selectOlderButton = document.getElementById("selectOlderButton");
const deleteOlderButton = document.getElementById("deleteOlderButton");
const confirmDialog = document.getElementById("confirmDialog");
const confirmDialogTitle = document.getElementById("confirmDialogTitle");
const confirmDialogMessage = document.getElementById("confirmDialogMessage");
const confirmDialogAccept = document.getElementById("confirmDialogAccept");

const bulkButtons = [
  selectVisibleButton,
  clearSelectionButton,
  bulkDeliveredButton,
  bulkUndeliveredButton,
  bulkNotPackageButton,
  bulkDeleteButton,
  selectOlderButton,
  deleteOlderButton
];

apiKeyInput.value = state.apiKey;

function preferredTheme() {
  if (state.theme === "light" || state.theme === "dark") return state.theme;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function updateThemeToggleLabel(theme) {
  if (!themeToggleButton) return;
  themeToggleButton.textContent = theme === "dark" ? "Modo claro" : "Modo oscuro";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  state.theme = nextTheme;
  localStorage.setItem("paquetes_app_theme", nextTheme);
  updateThemeToggleLabel(nextTheme);
}

function toggleTheme() {
  applyTheme(preferredTheme() === "dark" ? "light" : "dark");
}

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
  const rawUrl = String(url || "");
  // Resolve relative to the current page so the same UI works both on direct port
  // access and behind the Home Assistant ingress prefix.
  const finalUrl = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : new URL(rawUrl.replace(/^\/+/, ""), window.location.href).toString();
  const response = await fetch(finalUrl, { ...options, headers });
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

function itemKey(owner, tracking) {
  return `${String(owner || "").trim().toLowerCase()}::${String(tracking || "").trim().toUpperCase()}`;
}

function getAllItems() {
  return state.owners.flatMap((owner) => owner.items || []);
}

function getItemTimestampMs(item) {
  const raw = item?.one?.latest?.time || item?.delivered_at || "";
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
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
    item.one?.latest?.description,
    item.one?.latest?.subject,
    item.one?.latest?.sender
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function matchesDate(item) {
  if (!state.dateFrom && !state.dateTo) return true;
  const ts = getItemTimestampMs(item);
  if (!ts) return false;

  if (state.dateFrom) {
    const from = new Date(`${state.dateFrom}T00:00:00`);
    if (!Number.isNaN(from.getTime()) && ts < from.getTime()) return false;
  }
  if (state.dateTo) {
    const to = new Date(`${state.dateTo}T23:59:59.999`);
    if (!Number.isNaN(to.getTime()) && ts > to.getTime()) return false;
  }
  return true;
}

function getVisibleOwners() {
  const normalizedSearch = state.search.trim().toLowerCase();
  return state.owners
    .map((owner) => ({
      ...owner,
      items: owner.items.filter((item) => matchesSearch(item, normalizedSearch) && matchesDate(item))
    }))
    .filter((owner) => owner.items.length > 0);
}

function syncSelectionToKnownItems() {
  const known = new Set(getAllItems().map((item) => itemKey(item.owner, item.tracking)));
  state.selectedKeys = new Set([...state.selectedKeys].filter((key) => known.has(key)));
}

function getSelectedItems(owners) {
  return owners.flatMap((owner) => owner.items).filter((item) => state.selectedKeys.has(itemKey(item.owner, item.tracking)));
}

function renderStats(owners) {
  const flatItems = owners.flatMap((owner) => owner.items);
  const delivered = flatItems.filter((item) => item.delivered_effective).length;
  const pending = flatItems.length - delivered;
  const chips = [
    `Owners: ${owners.length}`,
    `Visibles: ${flatItems.length}`,
    `Pendientes: ${pending}`,
    `Delivered: ${delivered}`,
    `Seleccionados: ${state.selectedKeys.size}`
  ];
  statsBar.innerHTML = chips.map((label) => `<span class="stat-chip">${escapeHtml(label)}</span>`).join("");
}

function renderSelectionBar(owners) {
  const visibleItems = owners.flatMap((owner) => owner.items);
  const selectedItems = getSelectedItems(owners);
  const selectedCount = selectedItems.length;
  const visibleCount = visibleItems.length;

  selectionSummary.textContent = selectedCount
    ? `${selectedCount} seleccionados de ${visibleCount} visibles`
    : `0 seleccionados de ${visibleCount} visibles`;
  selectionBar.classList.toggle("hidden", visibleCount === 0);

  const hasSelection = selectedCount > 0;
  clearSelectionButton.disabled = !hasSelection;
  bulkDeliveredButton.disabled = !hasSelection;
  bulkUndeliveredButton.disabled = !hasSelection;
  bulkNotPackageButton.disabled = !hasSelection;
  bulkDeleteButton.disabled = !hasSelection;
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

async function markNotPackage(owner, tracking) {
  return apiFetch(`/api/owner/${encodeURIComponent(owner)}/tracking/${encodeURIComponent(tracking)}/not_package`, {
    method: "POST"
  });
}

async function deleteTracking(owner, tracking) {
  return apiFetch(`/api/owner/${encodeURIComponent(owner)}/tracking/${encodeURIComponent(tracking)}`, {
    method: "DELETE"
  });
}

async function confirmBulkAction(action, count) {
  const copyByAction = {
    delivered: {
      title: "Confirmar delivered masivo",
      message: `Vas a marcar ${count} paquetes como delivered. Esto inicia su cuenta atras de borrado automatico a 7 dias si no vuelven a undelivered.`,
      button: "Marcar delivered"
    },
    delete: {
      title: "Confirmar borrado masivo",
      message: `Vas a borrar ${count} paquetes de la base de datos. Esta accion no se puede deshacer desde la UI.`,
      button: "Borrar paquetes"
    },
    not_package: {
      title: "Confirmar no es paquete",
      message: `Vas a marcar ${count} elementos como no paquete. Se borraran y se guardara una regla para ignorar correos parecidos en esa cuenta.`,
      button: "Marcar no paquete"
    }
  };

  const copy = copyByAction[action];
  if (!copy || !confirmDialog || typeof confirmDialog.showModal !== "function") return true;

  confirmDialogTitle.textContent = copy.title;
  confirmDialogMessage.textContent = copy.message;
  confirmDialogAccept.textContent = copy.button;

  return new Promise((resolve) => {
    const handleClose = () => {
      confirmDialog.removeEventListener("close", handleClose);
      resolve(confirmDialog.returnValue === "accept");
    };
    confirmDialog.addEventListener("close", handleClose, { once: true });
    confirmDialog.showModal();
  });
}

async function performBulkAction(action) {
  const visibleOwners = getVisibleOwners();
  const items = getSelectedItems(visibleOwners);
  return performActionOnItems(action, items);
}

function parseRetentionDaysInput() {
  const raw = String(olderThanDaysInput.value || "").trim();
  if (!raw) {
    setStatus("Introduce un numero de dias para la limpieza por antiguedad.", "error");
    olderThanDaysInput.focus();
    return null;
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0) {
    setStatus("El numero de dias debe ser un entero mayor que cero.", "error");
    olderThanDaysInput.focus();
    return null;
  }
  return days;
}

function getItemsOlderThanDays(days) {
  const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  return getAllItems().filter((item) => {
    const ts = getItemTimestampMs(item);
    return ts > 0 && ts < cutoffMs;
  });
}

async function performActionOnItems(action, items) {
  if (!items.length) {
    const emptyMessage = action === "delete"
      ? "No hay paquetes que cumplan el criterio."
      : "No hay elementos seleccionados.";
    setStatus(emptyMessage, "error");
    return;
  }

  if (["delivered", "delete", "not_package"].includes(action)) {
    const confirmed = await confirmBulkAction(action, items.length);
    if (!confirmed) return;
  }

  withBusy(bulkButtons, true);
  let okCount = 0;
  let failedCount = 0;

  try {
    for (const item of items) {
      try {
        if (action === "delivered") {
          await updateDeliveredOverride(item.owner, item.tracking, true);
        } else if (action === "undelivered") {
          await updateDeliveredOverride(item.owner, item.tracking, false);
        } else if (action === "delete") {
          await deleteTracking(item.owner, item.tracking);
        } else if (action === "not_package") {
          await markNotPackage(item.owner, item.tracking);
        }
        state.selectedKeys.delete(itemKey(item.owner, item.tracking));
        okCount += 1;
      } catch (_error) {
        failedCount += 1;
      }
    }

    const labels = {
      delivered: "marcados como delivered",
      undelivered: "marcados como undelivered",
      delete: "borrados",
      not_package: "marcados como no paquete"
    };
    const summary = `${okCount}/${items.length} ${labels[action]}`;
    const suffix = failedCount ? ` · ${failedCount} con error` : "";
    setStatus(`${summary}${suffix}.`, failedCount ? "error" : "info");
    await loadOwners();
  } finally {
    withBusy(bulkButtons, false);
  }
}

function renderOwners() {
  syncSelectionToKnownItems();
  const owners = getVisibleOwners();

  renderStats(owners);
  renderSelectionBar(owners);
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
      const notPackageButton = itemNode.querySelector(".not-package-button");
      const deleteButton = itemNode.querySelector(".delete-button");
      const selectCheckbox = itemNode.querySelector(".item-select");
      const buttons = [saveButton, deliveredButton, undeliveredButton, notPackageButton, deleteButton];

      const currentKey = itemKey(item.owner, item.tracking);
      itemNode.dataset.state = item.delivered_effective ? "delivered" : "pending";
      selectCheckbox.checked = state.selectedKeys.has(currentKey);
      selectCheckbox.addEventListener("change", () => {
        if (selectCheckbox.checked) state.selectedKeys.add(currentKey);
        else state.selectedKeys.delete(currentKey);
        renderOwners();
      });

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
        `<div class="detail-row"><strong>Asunto base:</strong> ${escapeHtml(item.one?.latest?.subject || item.one?.latest?.description || "Sin asunto")}</div>`,
        `<div class="detail-row"><strong>Remitente:</strong> ${escapeHtml(item.one?.latest?.sender || "Sin remitente")}</div>`,
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

      notPackageButton.addEventListener("click", async () => {
        try {
          withBusy(buttons, true);
          await markNotPackage(item.owner, item.tracking);
          state.selectedKeys.delete(currentKey);
          setStatus(`Marcado como no paquete: ${item.tracking}.`);
          await loadOwners();
        } catch (error) {
          setStatus(`No se pudo marcar como no paquete ${item.tracking}: ${error.message}`, "error");
        } finally {
          withBusy(buttons, false);
        }
      });

      deleteButton.addEventListener("click", async () => {
        try {
          withBusy(buttons, true);
          await deleteTracking(item.owner, item.tracking);
          state.selectedKeys.delete(currentKey);
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
    syncSelectionToKnownItems();
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

themeToggleButton.addEventListener("click", () => {
  toggleTheme();
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

dateFromInput.addEventListener("input", () => {
  state.dateFrom = dateFromInput.value;
  renderOwners();
});

dateToInput.addEventListener("input", () => {
  state.dateTo = dateToInput.value;
  renderOwners();
});

clearFiltersButton.addEventListener("click", () => {
  state.search = "";
  state.dateFrom = "";
  state.dateTo = "";
  searchInput.value = "";
  dateFromInput.value = "";
  dateToInput.value = "";
  renderOwners();
});

selectVisibleButton.addEventListener("click", () => {
  const visibleOwners = getVisibleOwners();
  for (const item of visibleOwners.flatMap((owner) => owner.items)) {
    state.selectedKeys.add(itemKey(item.owner, item.tracking));
  }
  renderOwners();
});

clearSelectionButton.addEventListener("click", () => {
  state.selectedKeys.clear();
  renderOwners();
});

bulkDeliveredButton.addEventListener("click", () => performBulkAction("delivered"));
bulkUndeliveredButton.addEventListener("click", () => performBulkAction("undelivered"));
bulkNotPackageButton.addEventListener("click", () => performBulkAction("not_package"));
bulkDeleteButton.addEventListener("click", () => performBulkAction("delete"));
selectOlderButton.addEventListener("click", () => {
  const days = parseRetentionDaysInput();
  if (days === null) return;
  const items = getItemsOlderThanDays(days);
  for (const item of items) {
    state.selectedKeys.add(itemKey(item.owner, item.tracking));
  }
  renderOwners();
  setStatus(
    items.length
      ? `Seleccionados ${items.length} paquetes anteriores a ${days} dias.`
      : `No hay paquetes anteriores a ${days} dias.`,
    items.length ? "info" : "error"
  );
});
deleteOlderButton.addEventListener("click", async () => {
  const days = parseRetentionDaysInput();
  if (days === null) return;
  const items = getItemsOlderThanDays(days);
  if (!items.length) {
    setStatus(`No hay paquetes anteriores a ${days} dias.`, "error");
    return;
  }
  await performActionOnItems("delete", items);
});

applyTheme(preferredTheme());

loadOwners();
