const state = {
  sessionId: null,
  endpoint: null,
  selectedBucket: null,
  currentPrefix: "",
  searchQuery: "",
  searchDebounceTimer: null,
  isSearchMode: false,
  nextToken: null,
  isTruncated: false,
  objectsCount: 0,
  displayRows: [],
  virtual: {
    rowHeight: 44,
    overscan: 20,
    start: 0,
    end: 0
  },
  allBuckets: [],
  history: [],
  historyIndex: -1,
  selectedObjectKey: null,
  selectedTab: "meta",
  detailsByObject: {},
  governanceTab: "lifecycle",
  governanceByBucket: {}
};

const THEME_STORAGE_KEY = "ceph-ui-theme";
const connectForm = document.getElementById("connect-form");
const statusEl = document.getElementById("status");
const themeToggleEl = document.getElementById("theme-toggle");
const sessionStateEl = document.getElementById("session-state");
const bucketCountEl = document.getElementById("bucket-count");
const bucketFilterEl = document.getElementById("bucket-filter");
const bucketListEl = document.getElementById("bucket-list");
const navBackButton = document.getElementById("nav-back");
const navForwardButton = document.getElementById("nav-forward");
const navUpButton = document.getElementById("nav-up");
const breadcrumbEl = document.getElementById("breadcrumb");
const searchInputEl = document.getElementById("search-input");
const searchStateEl = document.getElementById("search-state");
const tableWrapEl = document.getElementById("table-wrap");
const loadMoreButton = document.getElementById("load-more");
const objectsSpacerTopEl = document.getElementById("objects-spacer-top");
const objectsSpacerBottomEl = document.getElementById("objects-spacer-bottom");
const objectsBodyEl = document.getElementById("objects-body");
const summaryEl = document.getElementById("objects-summary");
const detailsOutputEl = document.getElementById("details-output");
const selectedObjectLabelEl = document.getElementById("selected-object-label");
const selectedBucketLabelEl = document.getElementById("selected-bucket-label");
const selectedPrefixLabelEl = document.getElementById("selected-prefix-label");
const visibleCountLabelEl = document.getElementById("visible-count-label");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const governanceOutputEl = document.getElementById("governance-output");
const governanceTabButtons = Array.from(document.querySelectorAll("[data-gov-tab]"));

connectForm.addEventListener("submit", onConnect);
themeToggleEl.addEventListener("click", toggleTheme);
loadMoreButton.addEventListener("click", () => loadObjects(false));
bucketFilterEl.addEventListener("input", renderBucketList);
navBackButton.addEventListener("click", goBack);
navForwardButton.addEventListener("click", goForward);
navUpButton.addEventListener("click", goUp);
searchInputEl.addEventListener("input", onSearchInput);
tableWrapEl.addEventListener("scroll", renderVirtualRows);
tabButtons.forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
});
governanceTabButtons.forEach((button) => {
  button.addEventListener("click", () => setGovernanceTab(button.dataset.govTab));
});
initTheme();

async function onConnect(event) {
  event.preventDefault();

  const payload = {
    endpoint: document.getElementById("endpoint").value.trim(),
    accessKey: document.getElementById("accessKey").value.trim(),
    secretKey: document.getElementById("secretKey").value.trim(),
    region: document.getElementById("region").value.trim(),
    pathStyle: document.getElementById("pathStyle").checked
  };

  setStatus("Connecting...");
  try {
    const response = await fetchJson("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.sessionId = response.sessionId;
    state.endpoint = payload.endpoint;
    resetNavigation();
    updateSessionState(true);
    setStatus("Connected.", false, true);
    await loadBuckets();
  } catch (error) {
    updateSessionState(false);
    setStatus("Connection failed: " + error.message, true);
  }
}

async function loadBuckets() {
  ensureConnected();
  const response = await fetchJson(`/api/buckets?sessionId=${encodeURIComponent(state.sessionId)}`);
  state.allBuckets = response.buckets || [];
  bucketCountEl.textContent = String(state.allBuckets.length);
  renderBucketList();
  if (!state.allBuckets.length) {
    setStatus("Connected. No buckets found.", false, true);
  }
}

function renderBucketList() {
  bucketListEl.innerHTML = "";
  const filterText = bucketFilterEl.value.trim().toLowerCase();
  const buckets = state.allBuckets.filter((bucket) => bucket.name.toLowerCase().includes(filterText));

  if (!buckets.length) {
    bucketListEl.innerHTML = "<li class='muted-text'>No buckets found.</li>";
    return;
  }

  buckets.forEach((bucket) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.bucket = bucket.name;
    button.textContent = bucket.name;
    if (state.selectedBucket === bucket.name) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => selectBucket(bucket.name));
    li.appendChild(button);
    bucketListEl.appendChild(li);
  });
}

function selectBucket(bucketName) {
  navigateTo(bucketName, "", true);
}

function navigateTo(bucketName, prefix, pushHistory = false) {
  state.selectedBucket = bucketName;
  state.currentPrefix = prefix;
  state.searchQuery = "";
  state.isSearchMode = false;
  if (searchInputEl) {
    searchInputEl.value = "";
  }
  searchStateEl.textContent = "";
  state.nextToken = null;
  state.isTruncated = false;
  state.objectsCount = 0;
  state.displayRows = [];
  state.selectedObjectKey = null;
  objectsBodyEl.innerHTML = "";
  selectedObjectLabelEl.textContent = "Select an object to inspect details.";
  detailsOutputEl.textContent = "Select an object to inspect details.";
  setActiveBucketButton(bucketName);
  setActiveTab("meta");
  selectedBucketLabelEl.textContent = bucketName;
  selectedPrefixLabelEl.textContent = prefix || "/";
  renderBreadcrumb();
  if (pushHistory) {
    pushHistoryState(bucketName, prefix);
  }
  updateNavButtons();
  loadGovernance(bucketName);
  loadObjects(true);
}

async function loadObjects(reset) {
  try {
    ensureConnected();
    if (!state.selectedBucket) {
      throw new Error("Select a bucket first.");
    }

    loadMoreButton.disabled = true;
    if (reset) {
      state.nextToken = null;
      state.isTruncated = false;
      state.objectsCount = 0;
      objectsBodyEl.innerHTML = "";
    }

    const query = new URLSearchParams({ sessionId: state.sessionId, bucket: state.selectedBucket, maxKeys: "50" });
    if (state.isSearchMode) {
      query.set("query", state.searchQuery);
      query.set("prefix", state.currentPrefix);
    } else {
      query.set("prefix", state.currentPrefix);
    }
    if (!reset && state.nextToken) {
      query.set("continuationToken", state.nextToken);
    }

    const endpoint = state.isSearchMode ? "/api/search" : "/api/objects";
    const response = await fetchJson(`${endpoint}?${query.toString()}`);
    buildDisplayRows(response.commonPrefixes || [], response.objects || []);
    resetVirtualWindow();
    renderVirtualRows();

    state.nextToken = response.nextToken || null;
    state.isTruncated = !!response.isTruncated;
    loadMoreButton.disabled = !state.isTruncated;
    if (state.isSearchMode) {
      summaryEl.textContent = `${response.objects?.length || 0} matched objects loaded in this page`;
      if (response.scanLimitReached) {
        searchStateEl.textContent = `Partial results (${response.scannedCount} scanned, cap reached)`;
      } else {
        searchStateEl.textContent = `${response.scannedCount || 0} scanned`;
      }
    } else {
      summaryEl.textContent = `${response.commonPrefixes?.length || 0} folders, ${response.objects?.length || 0} objects loaded in this page`;
      searchStateEl.textContent = "";
    }
    selectedPrefixLabelEl.textContent = state.currentPrefix || "/";
    visibleCountLabelEl.textContent = String(state.objectsCount);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function buildDisplayRows(prefixes, objects) {
  state.displayRows = [];
  state.objectsCount = 0;
  if (!state.isSearchMode) {
    prefixes.forEach((prefix) => {
      state.displayRows.push({
        kind: "folder",
        prefix,
        displayName: simplifyName(prefix, state.currentPrefix)
      });
    });
  }

  objects.forEach((object) => {
    state.displayRows.push({
      kind: "object",
      object,
      key: object.key,
      displayName: simplifyName(object.key, state.currentPrefix)
    });
  });

  state.objectsCount = state.displayRows.length;
}

function resetVirtualWindow() {
  state.virtual.start = 0;
  state.virtual.end = 0;
  tableWrapEl.scrollTop = 0;
}

function renderVirtualRows() {
  const rows = state.displayRows;
  if (!rows.length) {
    objectsSpacerTopEl.innerHTML = "";
    objectsSpacerBottomEl.innerHTML = "";
    objectsBodyEl.innerHTML = `<tr><td colspan="4" class="muted-text">${state.isSearchMode ? "No matching objects found." : "No objects found in this prefix."}</td></tr>`;
    return;
  }

  const viewportHeight = tableWrapEl.clientHeight || 440;
  const scrollTop = tableWrapEl.scrollTop;
  const rowsPerViewport = Math.ceil(viewportHeight / state.virtual.rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / state.virtual.rowHeight) - state.virtual.overscan);
  const end = Math.min(rows.length, start + rowsPerViewport + state.virtual.overscan * 2);

  state.virtual.start = start;
  state.virtual.end = end;
  const visible = rows.slice(start, end);

  objectsBodyEl.innerHTML = "";
  visible.forEach((entry) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    if (entry.kind === "folder") {
      tr.innerHTML = `<td>[DIR] ${escapeHtml(entry.displayName)}</td><td>folder</td><td>-</td><td>-</td>`;
      tr.addEventListener("click", () => navigateTo(state.selectedBucket, entry.prefix, true));
    } else {
      tr.innerHTML = `
        <td>[OBJ] ${escapeHtml(entry.displayName)}</td>
        <td>object</td>
        <td>${formatBytes(entry.object.size)}</td>
        <td>${escapeHtml(entry.object.lastModified || "-")}</td>
      `;
      tr.addEventListener("click", () => selectObject(entry.key));
    }
    objectsBodyEl.appendChild(tr);
  });

  const topPx = start * state.virtual.rowHeight;
  const bottomPx = Math.max(0, (rows.length - end) * state.virtual.rowHeight);
  objectsSpacerTopEl.innerHTML = topPx > 0 ? `<tr class="spacer-row"><td colspan="4" style="height:${topPx}px"></td></tr>` : "";
  objectsSpacerBottomEl.innerHTML = bottomPx > 0 ? `<tr class="spacer-row"><td colspan="4" style="height:${bottomPx}px"></td></tr>` : "";
}

async function selectObject(key) {
  state.selectedObjectKey = key;
  selectedObjectLabelEl.textContent = key;
  ensureDetailCache();
  const cache = state.detailsByObject[key];
  cache.meta = null;
  cache.tags = null;
  cache.content = null;
  cache.contentLoaded = false;
  setActiveTab("meta");

  try {
    await Promise.all([loadMetadata(key), loadTags(key)]);
  } catch (_error) {
    // Each loader already writes a readable error in tab output.
  }
  renderActiveTab();
}

async function loadMetadata(key) {
  const query = new URLSearchParams({ sessionId: state.sessionId, bucket: state.selectedBucket, key });
  const cache = state.detailsByObject[key];
  try {
    cache.meta = await fetchJson(`/api/object/meta?${query.toString()}`);
  } catch (error) {
    cache.meta = { error: "Metadata error: " + error.message };
    throw error;
  }
}

async function loadTags(key) {
  const query = new URLSearchParams({ sessionId: state.sessionId, bucket: state.selectedBucket, key });
  const cache = state.detailsByObject[key];
  try {
    cache.tags = await fetchJson(`/api/object/tags?${query.toString()}`);
  } catch (error) {
    cache.tags = { error: "Tags error: " + error.message };
    throw error;
  }
}

async function loadContent(key) {
  const query = new URLSearchParams({
    sessionId: state.sessionId,
    bucket: state.selectedBucket,
    key,
    maxBytes: "262144"
  });
  const cache = state.detailsByObject[key];
  try {
    cache.content = await fetchJson(`/api/object/content?${query.toString()}`);
    cache.contentLoaded = true;
  } catch (error) {
    cache.content = { error: "Content preview error: " + error.message };
    cache.contentLoaded = true;
    throw error;
  }
}

function ensureDetailCache() {
  if (!state.selectedObjectKey) {
    return;
  }
  if (!state.detailsByObject[state.selectedObjectKey]) {
    state.detailsByObject[state.selectedObjectKey] = {
      meta: null,
      tags: null,
      content: null,
      contentLoaded: false
    };
  }
}

function setActiveTab(tab) {
  state.selectedTab = tab;
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  renderActiveTab();
  if (tab === "content" && state.selectedObjectKey) {
    ensureDetailCache();
    const cache = state.detailsByObject[state.selectedObjectKey];
    if (!cache.contentLoaded) {
      detailsOutputEl.textContent = "Loading content preview...";
      loadContent(state.selectedObjectKey).then(renderActiveTab).catch(renderActiveTab);
    }
  }
}

function renderActiveTab() {
  if (!state.selectedObjectKey) {
    detailsOutputEl.textContent = "Select an object to inspect details.";
    return;
  }
  ensureDetailCache();
  const cache = state.detailsByObject[state.selectedObjectKey];

  if (state.selectedTab === "meta") {
    if (!cache.meta) {
      detailsOutputEl.textContent = "Loading metadata...";
      return;
    }
    detailsOutputEl.textContent = cache.meta.error || JSON.stringify(cache.meta, null, 2);
    return;
  }

  if (state.selectedTab === "tags") {
    if (!cache.tags) {
      detailsOutputEl.textContent = "Loading tags...";
      return;
    }
    if (cache.tags.error) {
      detailsOutputEl.textContent = cache.tags.error;
      return;
    }
    if (!cache.tags.tags?.length) {
      detailsOutputEl.textContent = "No tags on this object.";
      return;
    }
    detailsOutputEl.textContent = JSON.stringify(cache.tags.tags, null, 2);
    return;
  }

  if (!cache.contentLoaded) {
    detailsOutputEl.textContent = "Loading content preview...";
    return;
  }
  if (cache.content?.error) {
    detailsOutputEl.textContent = cache.content.error;
    return;
  }
  if (!cache.content?.isText) {
    detailsOutputEl.textContent =
      `Binary or non-text object.\n` +
      `contentType=${cache.content?.contentType || "application/octet-stream"}\n` +
      `size=${cache.content?.size || 0} bytes`;
    return;
  }
  const suffix = cache.content.isTruncated ? "\n\n[Preview truncated]" : "";
  detailsOutputEl.textContent = `${cache.content.previewText || ""}${suffix}`;
}

function pushHistoryState(bucket, prefix) {
  const current = state.history[state.historyIndex];
  if (current && current.bucket === bucket && current.prefix === prefix) {
    return;
  }
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push({ bucket, prefix });
  state.historyIndex = state.history.length - 1;
}

function applyHistoryState(entry) {
  if (!entry) {
    return;
  }
  navigateTo(entry.bucket, entry.prefix, false);
}

function goBack() {
  if (state.historyIndex <= 0) {
    return;
  }
  state.historyIndex -= 1;
  applyHistoryState(state.history[state.historyIndex]);
}

function goForward() {
  if (state.historyIndex >= state.history.length - 1) {
    return;
  }
  state.historyIndex += 1;
  applyHistoryState(state.history[state.historyIndex]);
}

function goUp() {
  if (!state.selectedBucket) {
    return;
  }
  if (!state.currentPrefix) {
    return;
  }
  const trimmed = state.currentPrefix.endsWith("/") ? state.currentPrefix.slice(0, -1) : state.currentPrefix;
  const lastSlash = trimmed.lastIndexOf("/");
  const parent = lastSlash >= 0 ? `${trimmed.slice(0, lastSlash + 1)}` : "";
  navigateTo(state.selectedBucket, parent, true);
}

function onSearchInput() {
  state.searchQuery = searchInputEl.value.trim();
  state.isSearchMode = state.searchQuery.length > 0;
  if (state.searchDebounceTimer) {
    clearTimeout(state.searchDebounceTimer);
  }
  state.searchDebounceTimer = setTimeout(() => {
    state.nextToken = null;
    loadObjects(true);
  }, 300);
}

function renderBreadcrumb() {
  if (!state.selectedBucket) {
    breadcrumbEl.textContent = "/";
    return;
  }

  const parts = state.currentPrefix.split("/").filter(Boolean);
  breadcrumbEl.innerHTML = "";

  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = `crumb ${parts.length === 0 ? "current" : ""}`;
  rootButton.textContent = state.selectedBucket;
  if (parts.length > 0) {
    rootButton.addEventListener("click", () => navigateTo(state.selectedBucket, "", true));
  }
  breadcrumbEl.appendChild(rootButton);

  let running = "";
  parts.forEach((part, index) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    breadcrumbEl.appendChild(sep);

    running += `${part}/`;
    const button = document.createElement("button");
    button.type = "button";
    const isCurrent = index === parts.length - 1;
    button.className = `crumb ${isCurrent ? "current" : ""}`;
    button.textContent = part;
    if (!isCurrent) {
      const targetPrefix = running;
      button.addEventListener("click", () => navigateTo(state.selectedBucket, targetPrefix, true));
    }
    breadcrumbEl.appendChild(button);
  });
}

function updateNavButtons() {
  navBackButton.disabled = state.historyIndex <= 0;
  navForwardButton.disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  navUpButton.disabled = !state.selectedBucket || !state.currentPrefix;
}

function setActiveBucketButton(bucketName) {
  bucketListEl.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bucket === bucketName);
  });
}

function resetNavigation() {
  state.selectedBucket = null;
  state.currentPrefix = "";
  state.nextToken = null;
  state.isTruncated = false;
  state.objectsCount = 0;
  state.history = [];
  state.historyIndex = -1;
  state.displayRows = [];
  state.selectedObjectKey = null;
  state.detailsByObject = {};
  state.governanceByBucket = {};
  state.searchQuery = "";
  state.isSearchMode = false;
  searchStateEl.textContent = "";
  if (searchInputEl) {
    searchInputEl.value = "";
  }
  clearObjects();
  updateNavButtons();
  renderBreadcrumb();
}

function simplifyName(fullPath, basePrefix) {
  if (!basePrefix) {
    return fullPath;
  }
  if (fullPath.startsWith(basePrefix)) {
    return fullPath.slice(basePrefix.length);
  }
  return fullPath;
}

function ensureConnected() {
  if (!state.sessionId) {
    throw new Error("Connect to Ceph first.");
  }
}

function setStatus(message, isError = false, isSuccess = false) {
  statusEl.textContent = message;
  statusEl.classList.remove("error", "success");
  if (isError) {
    statusEl.classList.add("error");
  }
  if (isSuccess) {
    statusEl.classList.add("success");
  }
}

function updateSessionState(connected) {
  sessionStateEl.textContent = connected ? "Connected" : "Disconnected";
  sessionStateEl.classList.toggle("connected", connected);
}

function clearObjects() {
  objectsBodyEl.innerHTML = "";
  objectsSpacerTopEl.innerHTML = "";
  objectsSpacerBottomEl.innerHTML = "";
  summaryEl.textContent = "Select a bucket to begin.";
  loadMoreButton.disabled = true;
  selectedObjectLabelEl.textContent = "Select an object to inspect details.";
  detailsOutputEl.textContent = "Select an object to inspect details.";
  selectedBucketLabelEl.textContent = "-";
  selectedPrefixLabelEl.textContent = "/";
  visibleCountLabelEl.textContent = "0";
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const pieces = [data.error || `Request failed (${response.status})`];
    if (data.code) {
      pieces.push(`code=${data.code}`);
    }
    if (data.requestId) {
      pieces.push(`requestId=${data.requestId}`);
    }
    throw new Error(pieces.join(" | "));
  }
  return data;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setGovernanceTab(tab) {
  state.governanceTab = tab;
  governanceTabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.govTab === tab);
  });
  renderGovernance();
}

async function loadGovernance(bucket) {
  if (!bucket) {
    governanceOutputEl.textContent = "Select a bucket to load lifecycle/policy details.";
    return;
  }
  if (!state.governanceByBucket[bucket]) {
    state.governanceByBucket[bucket] = {
      lifecycle: { loading: true, data: null, error: null },
      policy: { loading: true, data: null, error: null }
    };
  } else {
    state.governanceByBucket[bucket].lifecycle.loading = true;
    state.governanceByBucket[bucket].policy.loading = true;
    state.governanceByBucket[bucket].lifecycle.error = null;
    state.governanceByBucket[bucket].policy.error = null;
  }
  renderGovernance();

  const lifecycleQuery = new URLSearchParams({ sessionId: state.sessionId, bucket });
  const policyQuery = new URLSearchParams({ sessionId: state.sessionId, bucket });

  try {
    const lifecycle = await fetchJson(`/api/bucket/lifecycle?${lifecycleQuery.toString()}`);
    state.governanceByBucket[bucket].lifecycle.data = lifecycle;
  } catch (error) {
    state.governanceByBucket[bucket].lifecycle.error = error.message;
  } finally {
    state.governanceByBucket[bucket].lifecycle.loading = false;
  }

  try {
    const policy = await fetchJson(`/api/bucket/policy?${policyQuery.toString()}`);
    state.governanceByBucket[bucket].policy.data = policy;
  } catch (error) {
    state.governanceByBucket[bucket].policy.error = error.message;
  } finally {
    state.governanceByBucket[bucket].policy.loading = false;
  }

  renderGovernance();
}

function renderGovernance() {
  const bucket = state.selectedBucket;
  if (!bucket) {
    governanceOutputEl.textContent = "Select a bucket to load lifecycle/policy details.";
    return;
  }
  const governance = state.governanceByBucket[bucket];
  if (!governance) {
    governanceOutputEl.textContent = "Loading governance details...";
    return;
  }
  const section = state.governanceTab === "lifecycle" ? governance.lifecycle : governance.policy;
  if (section.loading) {
    governanceOutputEl.textContent = "Loading...";
    return;
  }
  if (section.error) {
    governanceOutputEl.textContent = `Access or fetch error: ${section.error}`;
    return;
  }

  if (!section.data || section.data.status === "not_configured") {
    governanceOutputEl.textContent = state.governanceTab === "lifecycle"
      ? "No lifecycle rules configured for this bucket."
      : "No bucket policy configured.";
    return;
  }

  if (state.governanceTab === "policy") {
    if (typeof section.data.policy === "string") {
      try {
        governanceOutputEl.textContent = JSON.stringify(JSON.parse(section.data.policy), null, 2);
      } catch (_error) {
        governanceOutputEl.textContent = section.data.policy;
      }
    } else {
      governanceOutputEl.textContent = JSON.stringify(section.data.policy, null, 2);
    }
    return;
  }
  governanceOutputEl.textContent = JSON.stringify(section.data.rules || [], null, 2);
}

function initTheme() {
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  const theme = saved === "dark" ? "dark" : "light";
  applyTheme(theme);
}

function toggleTheme() {
  const current = document.body.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  window.localStorage.setItem(THEME_STORAGE_KEY, next);
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  themeToggleEl.textContent = theme === "dark" ? "Light mode" : "Dark mode";
}
