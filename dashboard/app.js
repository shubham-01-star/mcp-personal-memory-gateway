const statusBadge = document.getElementById("statusBadge");
const totalQueries = document.getElementById("totalQueries");
const blockedHighRisk = document.getElementById("blockedHighRisk");
const totalRedactions = document.getElementById("totalRedactions");
const totalIngestedFiles = document.getElementById("totalIngestedFiles");
const eventsLog = document.getElementById("eventsLog");
const originalContext = document.getElementById("originalContext");
const redactedContext = document.getElementById("redactedContext");
const filesList = document.getElementById("filesList");
const consentPrompt = document.getElementById("consentPrompt");
const consentAllowBtn = document.getElementById("consentAllowBtn");
const consentDenyBtn = document.getElementById("consentDenyBtn");
const uploadDropZone = document.getElementById("uploadDropZone");
const uploadFileInput = document.getElementById("uploadFileInput");
const uploadFileBtn = document.getElementById("uploadFileBtn");
const uploadTokenInput = document.getElementById("uploadTokenInput");
const uploadStatus = document.getElementById("uploadStatus");
const uploadProgressBar = document.getElementById("uploadProgressBar");
const uploadProgressText = document.getElementById("uploadProgressText");
const clearAllFilesBtn = document.getElementById("clearAllFilesBtn");
const clearAllMemoryBtn = document.getElementById("clearAllMemoryBtn");
const openToolGuideBtn = document.getElementById("openToolGuideBtn");
const closeToolGuideBtn = document.getElementById("closeToolGuideBtn");
const toolGuideModal = document.getElementById("toolGuideModal");
const copyGuideButtons = document.querySelectorAll(".copy-guide-btn");

// Keep log rendering bounded so the page stays responsive during high event volume.
const MAX_EVENTS = 20;
const UPLOAD_ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".png", ".jpg", ".jpeg"]);
let pendingConsentTopic = null;
let selectedUploadFile = null;
const numberFormatter = new Intl.NumberFormat();

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "0";
  }
  return numberFormatter.format(numeric);
}

function formatBytes(bytes) {
  const numeric = Number(bytes);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return "0 B";
  }
  if (numeric < 1024) {
    return `${numeric} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = numeric / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function toEventLabel(type) {
  return String(type ?? "event")
    .replaceAll("_", " ")
    .trim()
    .toUpperCase();
}

function setStatus(text, kind) {
  // Status badge color maps directly to connection health.
  const color =
    kind === "ok" ? "#3fd89a" : kind === "warn" ? "#f5bf54" : kind === "bad" ? "#ff6f7f" : "#9cb3d3";
  statusBadge.textContent = text;
  statusBadge.style.color = color;
  statusBadge.style.borderColor = `${color}66`;
}

function setUploadStatus(text, kind = "info") {
  if (!uploadStatus) {
    return;
  }
  uploadStatus.textContent = text;
  uploadStatus.style.color =
    kind === "ok" ? "#20d38a" : kind === "warn" ? "#f6b73c" : kind === "bad" ? "#ff5b6e" : "#8ea4c7";
}

function setUploadProgress(percent, text = "") {
  const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
  if (uploadProgressBar) {
    uploadProgressBar.style.width = `${clamped}%`;
  }
  if (uploadProgressText) {
    uploadProgressText.textContent = text || `${clamped}%`;
  }
}

function setUploadBusy(isBusy) {
  if (uploadFileBtn) {
    uploadFileBtn.disabled = isBusy;
  }
  if (uploadFileInput) {
    uploadFileInput.disabled = isBusy;
  }
  if (uploadDropZone) {
    uploadDropZone.classList.toggle("disabled", isBusy);
  }
  if (clearAllFilesBtn) {
    clearAllFilesBtn.disabled = isBusy;
  }
  if (clearAllMemoryBtn) {
    clearAllMemoryBtn.disabled = isBusy;
  }
  for (const button of document.querySelectorAll(".file-delete-btn")) {
    button.disabled = isBusy;
  }
}

function isToolGuideOpen() {
  return toolGuideModal?.classList.contains("open") ?? false;
}

function setToolGuideOpen(isOpen) {
  if (!toolGuideModal) {
    return;
  }
  toolGuideModal.classList.toggle("open", isOpen);
  toolGuideModal.setAttribute("aria-hidden", isOpen ? "false" : "true");
}

async function copyTextToClipboard(text) {
  if (!text) {
    throw new Error("Nothing to copy.");
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(input);
  if (!copied) {
    throw new Error("Copy failed.");
  }
}

function bindToolGuideInteractions() {
  openToolGuideBtn?.addEventListener("click", () => {
    setToolGuideOpen(true);
  });

  closeToolGuideBtn?.addEventListener("click", () => {
    setToolGuideOpen(false);
  });

  toolGuideModal?.addEventListener("click", (event) => {
    if (event.target === toolGuideModal) {
      setToolGuideOpen(false);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isToolGuideOpen()) {
      setToolGuideOpen(false);
    }
  });

  copyGuideButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const prompt = button.getAttribute("data-copy-text") ?? "";
      const previousText = button.textContent ?? "Copy Prompt";
      try {
        await copyTextToClipboard(prompt);
        button.textContent = "Copied";
        setUploadStatus("Tool guide prompt copied.");
      } catch (error) {
        setUploadStatus("Failed to copy tool guide prompt.", "bad");
        console.error(error);
      } finally {
        setTimeout(() => {
          button.textContent = previousText;
        }, 900);
      }
    });
  });
}

function hasAllowedUploadExtension(fileName) {
  const extIndex = fileName.lastIndexOf(".");
  if (extIndex < 0) {
    return false;
  }
  const extension = fileName.slice(extIndex).toLowerCase();
  return UPLOAD_ALLOWED_EXTENSIONS.has(extension);
}

function setSelectedUploadFile(file) {
  selectedUploadFile = file ?? null;
  if (uploadDropZone) {
    uploadDropZone.textContent = file
      ? `Selected: ${file.name} (${formatBytes(file.size)})`
      : "Drag and drop a file here, or click to choose.";
  }
}

function addEvent(event) {
  // Render newest events first and trim old items.
  const wrapper = document.createElement("div");
  wrapper.className = "entry";
  wrapper.setAttribute("data-event-type", String(event.type ?? "event"));

  const type = document.createElement("div");
  type.className = "entry-type";
  type.textContent = toEventLabel(event.type);
  wrapper.appendChild(type);

  const time = document.createElement("div");
  time.className = "entry-time";
  time.textContent = formatTime(event.timestamp);
  wrapper.appendChild(time);

  const body = document.createElement("div");
  body.className = "entry-body";
  body.textContent =
    typeof event.payload === "string"
      ? event.payload
      : JSON.stringify(event.payload, null, 2);
  wrapper.appendChild(body);

  eventsLog.prepend(wrapper);
  while (eventsLog.children.length > MAX_EVENTS) {
    eventsLog.removeChild(eventsLog.lastChild);
  }
}

function applyPrivacyEvent(event) {
  // Show latest redacted/original context snapshots from telemetry payload.
  const payload = event.payload ?? {};
  if (typeof payload.redactedContext === "string" && payload.redactedContext) {
    redactedContext.textContent = payload.redactedContext;
  }
  if (typeof payload.originalContext === "string" && payload.originalContext) {
    originalContext.textContent = payload.originalContext;
  } else {
    originalContext.textContent = "Disabled (set DASHBOARD_ALLOW_ORIGINAL=1)";
  }
}

function applyConsentRequest(event) {
  // Store requested topic until user explicitly allows/denies.
  const payload = event.payload ?? {};
  if (typeof payload.topic !== "string" || !payload.topic) {
    return;
  }
  pendingConsentTopic = payload.topic;
  consentPrompt.textContent = `High-risk context blocked for topic "${pendingConsentTopic}". Choose Allow to permit one retry.`;
  consentAllowBtn.disabled = false;
  consentDenyBtn.disabled = false;
}

function clearConsentPrompt(message) {
  pendingConsentTopic = null;
  consentPrompt.textContent = message;
  consentAllowBtn.disabled = true;
  consentDenyBtn.disabled = true;
}

async function sendConsent(decision) {
  if (!pendingConsentTopic) {
    return;
  }
  const topic = pendingConsentTopic;
  // Consent decision is sent as a GET call consumed by backend consent endpoints.
  const url = `/consent/${decision}?topic=${encodeURIComponent(topic)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Consent request failed with ${response.status}`);
    }
    clearConsentPrompt(
      decision === "allow"
        ? `Allowed one high-risk retry for "${topic}".`
        : `Denied high-risk retry for "${topic}".`
    );
  } catch (error) {
    consentPrompt.textContent = "Failed to send consent decision.";
    console.error(error);
  }
}

async function refreshStats() {
  // Pull latest counter snapshot for dashboard cards.
  const response = await fetch("/stats");
  const stats = await response.json();
  totalQueries.textContent = formatNumber(stats.totalQueries ?? 0);
  blockedHighRisk.textContent = formatNumber(stats.blockedHighRisk ?? 0);
  totalRedactions.textContent = formatNumber(stats.totalRedactions ?? 0);
  totalIngestedFiles.textContent = formatNumber(stats.totalIngestedFiles ?? 0);
}

async function refreshFiles() {
  // Refresh indexed file list from ingestion manifest API.
  const response = await fetch("/ingestion/files");
  const data = await response.json();
  const files = Array.isArray(data.files) ? data.files : [];
  filesList.innerHTML = "";

  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "file";
    empty.textContent = "No indexed files yet";
    filesList.appendChild(empty);
    return;
  }

  for (const item of files.slice(0, 50)) {
    const row = document.createElement("div");
    row.className = "file";
    const fileMain = document.createElement("div");
    fileMain.className = "file-main";

    const fileName = document.createElement("div");
    fileName.className = "file-name";
    const resolvedName = String(item.filePath ?? "").split("/").pop() || "unknown";
    fileName.textContent = resolvedName;

    const fileMeta = document.createElement("div");
    fileMeta.className = "file-meta";
    const indexedAt = Number.isFinite(Number(item.mtimeMs))
      ? new Date(Number(item.mtimeMs)).toLocaleString()
      : "unknown time";
    fileMeta.textContent = `${item.filePath} • ${formatBytes(item.size)} • ${indexedAt}`;

    fileMain.appendChild(fileName);
    fileMain.appendChild(fileMeta);
    row.appendChild(fileMain);

    const fileActions = document.createElement("div");
    fileActions.className = "file-actions";
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn ghost-danger file-delete-btn";
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      deleteIndexedFile({
        filePath: String(item.filePath ?? ""),
        fileName: resolvedName,
        triggerButton: deleteBtn,
      }).catch(console.error);
    });
    fileActions.appendChild(deleteBtn);
    row.appendChild(fileActions);
    filesList.appendChild(row);
  }
}

function getDashboardAuthHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const uploadToken = uploadTokenInput?.value?.trim() ?? "";
  if (uploadToken) {
    headers["x-dashboard-token"] = uploadToken;
  }
  return headers;
}

async function parseApiResponse(response) {
  try {
    const body = await response.json();
    return body ?? {};
  } catch {
    return {};
  }
}

async function deleteIndexedFile({ filePath, fileName, triggerButton }) {
  if (!filePath) {
    setUploadStatus("Cannot delete file: path missing.", "bad");
    return;
  }

  const shouldDelete = window.confirm(`Delete indexed file "${fileName}"?`);
  if (!shouldDelete) {
    return;
  }

  if (triggerButton) {
    triggerButton.disabled = true;
  }
  if (clearAllFilesBtn) {
    clearAllFilesBtn.disabled = true;
  }
  if (clearAllMemoryBtn) {
    clearAllMemoryBtn.disabled = true;
  }
  setUploadStatus(`Deleting ${fileName}...`, "warn");

  try {
    const response = await fetch(
      `/ingestion/files?filePath=${encodeURIComponent(filePath)}`,
      {
        method: "DELETE",
        headers: getDashboardAuthHeaders(),
      }
    );
    const body = await parseApiResponse(response);
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `Delete failed with status ${response.status}.`;
      throw new Error(message);
    }

    const deletedMemoryChunks = Number(body.deletedMemoryChunks ?? 0);
    setUploadStatus(
      `Deleted ${fileName}. Removed memory chunks: ${deletedMemoryChunks}.`,
      "ok"
    );
    await refreshFiles();
    await refreshStats();
    await refreshGraph();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed.";
    setUploadStatus(message, "bad");
    console.error(error);
  } finally {
    if (triggerButton) {
      triggerButton.disabled = false;
    }
    if (clearAllFilesBtn) {
      clearAllFilesBtn.disabled = false;
    }
    if (clearAllMemoryBtn) {
      clearAllMemoryBtn.disabled = false;
    }
  }
}

async function clearAllIndexedData() {
  const shouldDelete = window.confirm(
    "Clear all uploaded indexed data? This removes tracked files and document chunks."
  );
  if (!shouldDelete) {
    return;
  }

  setUploadBusy(true);
  setUploadStatus("Clearing uploaded indexed data...", "warn");

  try {
    const response = await fetch("/ingestion/clear", {
      method: "POST",
      headers: getDashboardAuthHeaders(),
    });
    const body = await parseApiResponse(response);
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `Clear failed with status ${response.status}.`;
      throw new Error(message);
    }

    const deletedFiles = Number(body.deletedFiles ?? 0);
    const deletedMemoryChunks = Number(body.deletedMemoryChunks ?? 0);
    setUploadStatus(
      `Cleared uploaded data. Deleted files: ${deletedFiles}, removed memory chunks: ${deletedMemoryChunks}.`,
      "ok"
    );
    setSelectedUploadFile(null);
    if (uploadFileInput) {
      uploadFileInput.value = "";
    }
    setUploadProgress(0, "Idle");
    await refreshFiles();
    await refreshStats();
    await refreshGraph();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clear failed.";
    setUploadStatus(message, "bad");
    console.error(error);
  } finally {
    setUploadBusy(false);
  }
}

async function clearAllMemoryData() {
  const shouldDelete = window.confirm(
    "Clear all uploaded files, document chunks, and saved memory facts?"
  );
  if (!shouldDelete) {
    return;
  }

  setUploadBusy(true);
  setUploadStatus("Clearing all memory data...", "warn");

  try {
    const response = await fetch("/memory/clear", {
      method: "POST",
      headers: getDashboardAuthHeaders(),
    });
    const body = await parseApiResponse(response);
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `Clear failed with status ${response.status}.`;
      throw new Error(message);
    }

    const deletedFiles = Number(body.deletedFiles ?? 0);
    const deletedMemoryChunks = Number(body.deletedMemoryChunks ?? 0);
    const deletedUserFacts = Number(body.deletedUserFacts ?? 0);
    setUploadStatus(
      `Cleared all memory. Deleted files: ${deletedFiles}, removed document chunks: ${deletedMemoryChunks}, removed saved facts: ${deletedUserFacts}.`,
      "ok"
    );
    setSelectedUploadFile(null);
    if (uploadFileInput) {
      uploadFileInput.value = "";
    }
    setUploadProgress(0, "Idle");
    await refreshFiles();
    await refreshStats();
    await refreshGraph();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clear failed.";
    setUploadStatus(message, "bad");
    console.error(error);
  } finally {
    setUploadBusy(false);
  }
}

function fileToBase64(file, onProgress) {
  // Browser-native conversion via data URL keeps upload implementation dependency-free.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }
      onProgress?.(event.loaded, event.total);
    };
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const separatorIndex = result.indexOf(",");
      if (separatorIndex < 0) {
        reject(new Error("Failed to encode file for upload."));
        return;
      }
      resolve(result.slice(separatorIndex + 1));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read file."));
    };
    reader.readAsDataURL(file);
  });
}

function uploadPayloadWithProgress(url, headers, payload, onProgress) {
  // XMLHttpRequest gives upload progress events; fetch does not expose them reliably.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    Object.entries(headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }
      onProgress?.(event.loaded, event.total);
    };

    xhr.onerror = () => {
      reject(new Error("Network error during upload."));
    };

    xhr.onload = () => {
      let body = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        body = {};
      }
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body });
    };

    xhr.send(payload);
  });
}

async function uploadSelectedFile() {
  if (!uploadFileInput || !uploadFileBtn) {
    return;
  }

  const file = selectedUploadFile ?? uploadFileInput.files?.[0] ?? null;
  if (!file) {
    setUploadStatus("Select a file first.", "warn");
    return;
  }
  if (!hasAllowedUploadExtension(file.name)) {
    setUploadStatus("Unsupported file type. Use .txt, .md, .pdf, .png, .jpg, .jpeg", "warn");
    return;
  }

  setUploadBusy(true);
  setUploadProgress(0, "Preparing upload...");
  setUploadStatus(`Uploading ${file.name} ...`);

  try {
    const contentBase64 = await fileToBase64(file, (loaded, total) => {
      const percent = total > 0 ? (loaded / total) * 45 : 0;
      setUploadProgress(percent, `Reading file: ${Math.floor(percent)}%`);
    });

    const headers = getDashboardAuthHeaders({ "content-type": "application/json" });

    const serializedPayload = JSON.stringify({
      fileName: file.name,
      contentBase64,
    });
    setUploadProgress(50, "Uploading: 50%");

    const response = await uploadPayloadWithProgress(
      "/ingestion/upload",
      headers,
      serializedPayload,
      (loaded, total) => {
        const phase = total > 0 ? loaded / total : 0;
        const percent = 50 + phase * 45;
        setUploadProgress(percent, `Uploading: ${Math.floor(percent)}%`);
      }
    );
    setUploadProgress(95, "Processing on server...");

    const body = response.body ?? {};
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `Upload failed with status ${response.status}.`;
      throw new Error(message);
    }

    const indexedChunks = Number(body.indexedChunks ?? 0);
    setUploadProgress(100, "Upload complete");
    const warning =
      typeof body.warning === "string" && body.warning.trim()
        ? body.warning.trim()
        : "";
    const ingestError =
      typeof body.ingestError === "string" && body.ingestError.trim()
        ? body.ingestError.trim()
        : "";
    if (warning) {
      const reason = ingestError ? ` Reason: ${ingestError}` : "";
      setUploadStatus(`${warning}${reason}`, "warn");
    } else {
      setUploadStatus(
        `Uploaded ${file.name} (${formatBytes(file.size)}). Indexed chunks: ${indexedChunks}.`,
        "ok"
      );
    }
    setSelectedUploadFile(null);
    uploadFileInput.value = "";
    await refreshFiles();
    await refreshStats();
    await refreshGraph();
  } catch (error) {
    setUploadProgress(0, "Idle");
    const message = error instanceof Error ? error.message : "Upload failed.";
    setUploadStatus(message, "bad");
    console.error(error);
  } finally {
    setUploadBusy(false);
  }
}

function bindUploadInteractions() {
  if (!uploadFileInput) {
    return;
  }

  uploadFileInput.addEventListener("change", () => {
    const file = uploadFileInput.files?.[0] ?? null;
    setSelectedUploadFile(file);
  });

  if (!uploadDropZone) {
    return;
  }

  uploadDropZone.addEventListener("click", () => {
    if (uploadFileInput.disabled) {
      return;
    }
    uploadFileInput.click();
  });

  uploadDropZone.addEventListener("keydown", (event) => {
    if (uploadFileInput.disabled) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      uploadFileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    uploadDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (uploadFileInput.disabled) {
        return;
      }
      uploadDropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "dragend"].forEach((eventName) => {
    uploadDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      uploadDropZone.classList.remove("drag-over");
    });
  });

  uploadDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    uploadDropZone.classList.remove("drag-over");
    if (uploadFileInput.disabled) {
      return;
    }

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }
    const file = files[0];
    setSelectedUploadFile(file);
  });
}

function startSse() {
  // Subscribe to live telemetry stream with a small replay window.
  const source = new EventSource("/events?replay=20");

  source.addEventListener("open", () => {
    setStatus("SSE: connected", "ok");
  });

  source.addEventListener("error", () => {
    setStatus("SSE: disconnected", "bad");
  });

  source.addEventListener("privacy_processed", async (msg) => {
    const event = JSON.parse(msg.data);
    addEvent(event);
    applyPrivacyEvent(event);
    await refreshStats();
  });

  source.addEventListener("ingest_success", async (msg) => {
    addEvent(JSON.parse(msg.data));
    await refreshStats();
    await refreshFiles();
  });

  source.addEventListener("ingest_error", async (msg) => {
    addEvent(JSON.parse(msg.data));
    await refreshStats();
  });

  source.addEventListener("query_received", async (msg) => {
    addEvent(JSON.parse(msg.data));
    await refreshStats();
  });

  source.addEventListener("risk_blocked", async (msg) => {
    addEvent(JSON.parse(msg.data));
    await refreshStats();
  });

  source.addEventListener("consent_required", (msg) => {
    const event = JSON.parse(msg.data);
    addEvent(event);
    applyConsentRequest(event);
  });

  source.addEventListener("consent_decision", (msg) => {
    addEvent(JSON.parse(msg.data));
  });

  source.addEventListener("archestra_request", (msg) => {
    addEvent(JSON.parse(msg.data));
  });

  source.addEventListener("archestra_response", (msg) => {
    addEvent(JSON.parse(msg.data));
  });

  source.addEventListener("memory_saved", (msg) => {
    addEvent(JSON.parse(msg.data));
  });
}


let cy = null;

async function refreshGraph() {
  // Build/update knowledge graph from recent memory records.
  const container = document.getElementById("knowledgeGraph");
  if (!container) return;

  try {
    const response = await fetch("/graph");
    const data = await response.json();
    const records = Array.isArray(data.nodes) ? data.nodes : [];

    if (records.length === 0 && !cy) {
      container.textContent = "No memory records found.";
      return;
    }

    const elements = [];
    const categories = new Set();

    // Create nodes for memory records and edges to category nodes.
    records.forEach((r) => {
      const label = r.text.length > 20 ? r.text.substring(0, 20) + "..." : r.text;
      elements.push({
        data: { id: r.id, label: label, type: r.source },
      });

      if (r.category) {
        categories.add(r.category);
        elements.push({
          data: { source: r.id, target: `cat_${r.category}` },
        });
      }
    });

    // Create category nodes after record pass so edges always have valid targets.
    categories.forEach((c) => {
      elements.push({
        data: { id: `cat_${c}`, label: c, type: "category" },
      });
    });

    if (!cy) {
      // Initialize Cytoscape
      container.textContent = ""; // Clear "No records" text
      cy = cytoscape({
        container: container,
        elements: elements,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': '#1f314d',
              'label': 'data(label)',
              'color': '#8ea4c7',
              'font-size': '10px',
              'text-valign': 'center',
              'text-halign': 'center',
              'width': 'label',
              'height': 'label',
              'padding': '10px',
              'shape': 'round-rectangle',
            },
          },
          {
            selector: 'node[type="category"]',
            style: {
              'background-color': '#20d38a',
              'color': '#05080f',
              'shape': 'ellipse',
            },
          },
          {
            selector: 'node[type="user_fact"]',
            style: {
              'background-color': '#44c8ff',
              'color': '#05080f',
            },
          },
          {
            selector: 'edge',
            style: {
              'width': 1,
              'line-color': '#1f314d',
              'curve-style': 'bezier',
            },
          },
        ],
        layout: {
          name: 'cose',
          animate: false,
        },
      });
    } else {
      // Update data
      cy.json({ elements: elements });
      cy.layout({ name: 'cose', animate: false }).run();
    }

  } catch (error) {
    console.error("Graph refresh failed", error);
  }
}

async function boot() {
  try {
    // Wire consent buttons first so user actions are available immediately.
    bindToolGuideInteractions();
    consentAllowBtn.addEventListener("click", () => {
      sendConsent("allow").catch(console.error);
    });
    consentDenyBtn.addEventListener("click", () => {
      sendConsent("deny").catch(console.error);
    });
    bindUploadInteractions();
    setUploadProgress(0, "Idle");
    uploadFileBtn?.addEventListener("click", () => {
      uploadSelectedFile().catch(console.error);
    });
    clearAllFilesBtn?.addEventListener("click", () => {
      clearAllIndexedData().catch(console.error);
    });
    clearAllMemoryBtn?.addEventListener("click", () => {
      clearAllMemoryData().catch(console.error);
    });

    await refreshStats();
    await refreshFiles();
    await refreshGraph(); // Initial load
    startSse();

    // Poll graph snapshot periodically; other cards update via SSE handlers.
    setInterval(refreshGraph, 10000);

  } catch (error) {
    setStatus("SSE: init failed", "bad");
    console.error(error);
  }
}

boot();
