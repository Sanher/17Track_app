const state = {
  owners: [],
  search: "",
  dateFrom: "",
  dateTo: "",
  selectedKeys: new Set(),
  theme: localStorage.getItem("paquetes_app_theme") || "",
  scopedByHaUser: null,
  refreshPollId: null,
  rawDebugEnabled: false
};

const heroText = document.getElementById("heroText");
const addTrackingButton = document.getElementById("addTrackingButton");
const rawDebugButton = document.getElementById("rawDebugButton");
const themeToggleButton = document.getElementById("themeToggleButton");
const refreshButton = document.getElementById("refreshButton");
const refreshMailButton = document.getElementById("refreshMailButton");
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
const addTrackingDialog = document.getElementById("addTrackingDialog");
const addTrackingForm = document.getElementById("addTrackingForm");
const addTrackingOwnerField = document.getElementById("addTrackingOwnerField");
const addTrackingOwnerInput = document.getElementById("addTrackingOwnerInput");
const addTrackingIdInput = document.getElementById("addTrackingIdInput");
const addTrackingCarrierInput = document.getElementById("addTrackingCarrierInput");
const addTrackingStatusInput = document.getElementById("addTrackingStatusInput");
const addTrackingAliasInput = document.getElementById("addTrackingAliasInput");
const addTrackingCancelButton = document.getElementById("addTrackingCancelButton");
const addTrackingSaveButton = document.getElementById("addTrackingSaveButton");
const rawDebugDialog = document.getElementById("rawDebugDialog");
const rawDebugOutput = document.getElementById("rawDebugOutput");
const rawDebugClearOwnerButton = document.getElementById("rawDebugClearOwnerButton");

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
function setMailRefreshBusy(isBusy) {
  if (!refreshMailButton) return;
  refreshMailButton.disabled = isBusy;
  refreshMailButton.textContent = isBusy ? "Refrescando..." : "Refrescar correo";
}

function setAddTrackingBusy(isBusy) {
  if (addTrackingSaveButton) addTrackingSaveButton.disabled = isBusy;
  if (addTrackingCancelButton) addTrackingCancelButton.disabled = isBusy;
  if (addTrackingButton) addTrackingButton.disabled = isBusy;
  if (addTrackingSaveButton) addTrackingSaveButton.textContent = isBusy ? "Guardando..." : "Guardar";
}

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

function titleCaseOwner(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ownerListLabel(owners) {
  const labels = [...new Set((owners || []).map((owner) => titleCaseOwner(owner)).filter(Boolean))];
  if (!labels.length) return "owners";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} y ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} y ${labels.at(-1)}`;
}

function updateHeroText() {
  if (!heroText) return;
  const scopedOwners = Array.isArray(state.scopedByHaUser?.owners) ? state.scopedByHaUser.owners : [];
  if (scopedOwners.length) {
    heroText.textContent = `Vista de paquetes de ${ownerListLabel(scopedOwners)} para revisar, corregir y limpiar paquetes escaneados por correo.`;
    return;
  }
  heroText.textContent = "Vista operativa por owner para revisar, corregir y limpiar paquetes escaneados por correo.";
}

function availableOwnersForManualAdd() {
  const scopedOwners = Array.isArray(state.scopedByHaUser?.owners) ? state.scopedByHaUser.owners : [];
  if (scopedOwners.length) return [...new Set(scopedOwners.map((owner) => String(owner || "").trim().toLowerCase()).filter(Boolean))];
  return [...new Set((state.owners || []).map((owner) => String(owner?.owner || "").trim().toLowerCase()).filter(Boolean))];
}

function primaryIngressOwner() {
  const scopedOwners = Array.isArray(state.scopedByHaUser?.owners) ? state.scopedByHaUser.owners : [];
  const normalized = scopedOwners.map((owner) => String(owner || "").trim().toLowerCase()).filter(Boolean);
  return normalized[0] || "";
}

function updateDebugButtonVisibility() {
  if (!rawDebugButton) return;
  rawDebugButton.classList.toggle("hidden", !state.rawDebugEnabled);
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
  return { ...extra };
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
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `http_${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

async function loadMailRefreshStatus() {
  return apiFetch("/api/ui/imap/status");
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
      const status = await loadMailRefreshStatus();
      if (status.running) return;

      stopRefreshPolling();
      setMailRefreshBusy(false);
      if (status.last_exit_code === 0 || status.last_exit_code === null) {
        setStatus("Refresco de correo completado. Actualizando listado...");
        await loadOwners();
      } else {
        setStatus("El refresco de correo terminó con error. Revisa los logs del add-on.", "error");
      }
    } catch (error) {
      stopRefreshPolling();
      setMailRefreshBusy(false);
      setStatus(`No se pudo comprobar el refresco: ${error.message}`, "error");
    }
  }, 4000);
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

async function addTracking(owner, payload) {
  return apiFetch(`/api/owner/${encodeURIComponent(owner)}/tracking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function loadRawDebugData() {
  return apiFetch("/api/ui/raw");
}

async function clearRawDebugOwner() {
  return apiFetch("/api/ui/raw/clear_owner", {
    method: "POST"
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

async function confirmDangerousAction(copy) {
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

function openAddTrackingDialog() {
  if (!addTrackingDialog || typeof addTrackingDialog.showModal !== "function") return;
  const owners = availableOwnersForManualAdd();
  if (!owners.length) {
    setStatus("No hay owners disponibles para crear un paquete manual.", "error");
    return;
  }

  const scopedOwner = primaryIngressOwner();
  const forceScopedOwner = !!scopedOwner;
  addTrackingOwnerInput.innerHTML = owners
    .map((owner) => `<option value="${escapeHtml(owner)}">${escapeHtml(owner)}</option>`)
    .join("");
  addTrackingOwnerField.classList.toggle("hidden", forceScopedOwner || owners.length <= 1);
  addTrackingOwnerInput.value = forceScopedOwner ? scopedOwner : owners[0];
  addTrackingIdInput.value = "";
  addTrackingCarrierInput.value = "";
  addTrackingStatusInput.value = "in_transit";
  addTrackingAliasInput.value = "";
  setAddTrackingBusy(false);
  addTrackingDialog.showModal();
  window.setTimeout(() => addTrackingIdInput.focus(), 20);
}

async function openRawDebugDialog() {
  if (!rawDebugDialog || typeof rawDebugDialog.showModal !== "function") return;
  rawDebugOutput.textContent = "Cargando...";
  if (rawDebugClearOwnerButton) rawDebugClearOwnerButton.disabled = false;
  rawDebugDialog.showModal();
  try {
    const payload = await loadRawDebugData();
    rawDebugOutput.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    rawDebugOutput.textContent = `No se pudo cargar el raw debug: ${error.message}`;
  }
}

async function loadOwners() {
  refreshButton.disabled = true;
  try {
    const payload = await apiFetch("/api/ui/owners");
    state.owners = Array.isArray(payload.owners) ? payload.owners : [];
    state.scopedByHaUser = payload.scoped_by_ha_user || null;
    state.rawDebugEnabled = payload.raw_debug_enabled === true;
    syncSelectionToKnownItems();
    updateHeroText();
    updateDebugButtonVisibility();
    renderOwners();
    setStatus(`Vista cargada. Retencion delivered: ${payload.delivered_retention_days} dias.`);
  } catch (error) {
    setStatus(`No se pudo cargar la vista: ${error.message}`, "error");
    ownersRoot.innerHTML = '<div class="empty-state">No hemos podido cargar los paquetes todavia.</div>';
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  loadOwners();
});

if (addTrackingButton) {
  addTrackingButton.addEventListener("click", () => {
    openAddTrackingDialog();
  });
}

if (rawDebugButton) {
  rawDebugButton.addEventListener("click", () => {
    openRawDebugDialog();
  });
}

if (rawDebugClearOwnerButton) {
  rawDebugClearOwnerButton.addEventListener("click", async () => {
    const accepted = await confirmDangerousAction({
      title: "Confirmar limpieza del owner",
      message: "Vas a borrar todos los paquetes, metadatos y reglas IMAP del owner con debug. Esta accion no se puede deshacer desde la UI.",
      button: "Limpiar owner"
    });
    if (!accepted) return;

    try {
      rawDebugClearOwnerButton.disabled = true;
      rawDebugOutput.textContent = "Limpiando owner...";
      const result = await clearRawDebugOwner();
      rawDebugOutput.textContent = JSON.stringify(result, null, 2);
      setStatus(`Owner limpiado. Trackings borrados: ${result.removed_trackings || 0}.`);
      await loadOwners();
    } catch (error) {
      rawDebugOutput.textContent = `No se pudo limpiar el owner: ${error.message}`;
      setStatus(`No se pudo limpiar el owner: ${error.message}`, "error");
    } finally {
      rawDebugClearOwnerButton.disabled = false;
    }
  });
}

refreshMailButton.addEventListener("click", async () => {
  setMailRefreshBusy(true);
  setStatus("Lanzando refresco de correo. Puede tardar unos momentos...");
  try {
    const result = await apiFetch("/api/ui/imap/refresh", { method: "POST" });
    setStatus(result.message || "Refresco de correo lanzado. Puede tardar unos momentos.");
    if (result.started === false && result.reason === "already_running") {
      startRefreshPolling();
      return;
    }
    startRefreshPolling();
  } catch (error) {
    setMailRefreshBusy(false);
    setStatus(`No se pudo lanzar el refresco: ${error.message}`, "error");
  }
});

themeToggleButton.addEventListener("click", () => {
  toggleTheme();
});

if (addTrackingCancelButton) {
  addTrackingCancelButton.addEventListener("click", () => {
    addTrackingDialog.close();
  });
}

if (addTrackingForm) {
  addTrackingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const owners = availableOwnersForManualAdd();
    const scopedOwner = primaryIngressOwner();
    const owner = String(
      (scopedOwner || (owners.length <= 1 ? owners[0] : addTrackingOwnerInput.value)) || ""
    )
      .trim()
      .toLowerCase();
    const tracking = String(addTrackingIdInput.value || "").trim().toUpperCase();
    const carrierName = String(addTrackingCarrierInput.value || "").trim();
    const status = String(addTrackingStatusInput.value || "in_transit").trim();
    const note = String(addTrackingAliasInput.value || "").trim();

    if (!owner) {
      setStatus("No hay owner disponible para guardar el paquete.", "error");
      return;
    }
    if (!tracking) {
      setStatus("El ID de seguimiento es obligatorio.", "error");
      addTrackingIdInput.focus();
      return;
    }

    try {
      setAddTrackingBusy(true);
      await addTracking(owner, {
        tracking,
        source: "imap",
        note,
        carrier_name: carrierName,
        status
      });
      addTrackingDialog.close();
      setStatus(`Paquete ${tracking} guardado en ${owner}. Actualizando listado...`);
      await loadOwners();
    } catch (error) {
      setStatus(`No se pudo guardar el paquete manual: ${error.message}`, "error");
    } finally {
      setAddTrackingBusy(false);
    }
  });
}

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
updateHeroText();

loadOwners();
