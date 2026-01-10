(() => {
  "use strict";

  const scrollArea = document.getElementById("scroll-area");
  const spacer = document.getElementById("spacer");
  const logRow = document.getElementById("log-row");
  const lineNumbers = document.getElementById("line-numbers");
  const logContent = document.getElementById("log-content");
  const fileMeta = document.getElementById("file-meta");
  const rangeMeta = document.getElementById("range-meta");
  const wrapToggle = document.getElementById("wrap-toggle");
  const charsetSelect = document.getElementById("charset-select");
  const fileSelect = document.getElementById("file-select");
  const lineNumbersToggle = document.getElementById("line-numbers-toggle");
  const searchInput = document.getElementById("search-input");
  const tailModeSelect = document.getElementById("tail-mode");
  const uncategorizedToggle = document.getElementById("uncategorized-toggle");
  const addCategoryButton = document.getElementById("add-category");
  const categoryList = document.getElementById("category-list");
  const categoryEmpty = document.getElementById("category-empty");
  const aiSuggestButton = document.getElementById("ai-suggest");
  const aiDialog = document.getElementById("ai-dialog");
  const aiCloseButton = document.getElementById("ai-close");
  const aiSelection = document.getElementById("ai-selection");
  const aiSuggestionList = document.getElementById("ai-suggestion-list");
  const aiSuggestionStatus = document.getElementById("ai-suggestion-status");
  const aiApplyButton = document.getElementById("ai-apply");
  const aiRefreshButton = document.getElementById("ai-refresh");
  const aiDialogBackdrop = aiDialog ? aiDialog.querySelector(".ai-dialog-backdrop") : null;

  const ESTIMATED_BYTES_PER_LINE = 80;
  const CATEGORY_STORAGE_PREFIX =
    "net.stoerr.Categorizedlogfileviewer.categories.com";
  const HIDE_UNCATEGORIZED_STORAGE_KEY =
    "net.stoerr.Categorizedlogfileviewer.hideUncategorized";
  const TAIL_MODE_STORAGE_KEY = "net.stoerr.Categorizedlogfileviewer.tailMode";
  const TAIL_POLL_INTERVAL_MS = 2000;
  const TAIL_MODES = ["snapshot", "follow", "since-open"];
  const MAX_AI_LINES = 50;
  const MAX_AI_TOTAL_CHARS = 8000;
  const MAX_AI_LINE_LENGTH = 1000;

  let meta = null;
  let pending = false;
  let queuedStart = null;
  let pendingStart = null;
  let lineHeight = 16;
  let currentRangeStart = 0;
  let currentRangeEnd = 0;
  let currentCharset = null;
  let currentFileId = null;
  let lineNumbersEnabled = false;
  let metaPollTimer = null;
  let prefetched = null;
  let prefetchStart = null;
  let prefetchPromise = null;
  let categories = [];
  let categoryMatchers = [];
  let categoriesKey = null;
  let soloRestoreScrollTop = null;
  let soloCategoryId = null;
  let soloRefreshTimer = null;
  let filterMode = null;
  let filterPattern = null;
  let filterMatchCount = null;
  let filterChunkLines = [];
  let filterChunkLineNumbers = [];
  let filterChunkStart = 0;
  let filterPrefetched = null;
  let filterPrefetchStart = null;
  let filterPrefetchPromise = null;
  let renderedFilterChunks = [];
  let renderedChunks = [];
  let aiSelectionLines = [];
  let aiSuggestions = [];
  let aiSelectedPattern = null;
  let aiRequestInFlight = false;
  let selectedLines = new Map();
  let searchPattern = "";
  let searchDebounce = null;
  let hideUncategorized = false;
  let tailMode = "snapshot";
  let tailPollTimer = null;
  let tailUpdateInFlight = false;
  let sinceOpenBaseLine = null;
  const MAX_RENDERED_CHUNKS = 4;
  const debug = new URLSearchParams(window.location.search).has("debug");
  const logDebug = (...args) => {
    if (debug) {
      console.log("[logviewer]", ...args);
    }
  };
  logDebug("debug-enabled");

  function getViewBaseLine() {
    if (tailMode !== "since-open") {
      return 0;
    }
    if (typeof sinceOpenBaseLine !== "number") {
      return 0;
    }
    return Math.max(0, sinceOpenBaseLine);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }

  function formatLineCount(lines) {
    if (lines == null) {
      return "counting lines...";
    }
    return `${lines.toLocaleString()} lines`;
  }

  function countLinesInText(text) {
    if (!text) {
      return 0;
    }
    let count = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\n") {
        count += 1;
      }
    }
    if (text[text.length - 1] !== "\n") {
      count += 1;
    }
    return count;
  }

  function getLineHeightPx() {
    const style = window.getComputedStyle(logContent);
    const lineHeightValue = parseFloat(style.lineHeight);
    if (!Number.isNaN(lineHeightValue)) {
      return lineHeightValue;
    }
    const fontSize = parseFloat(style.fontSize) || 16;
    return fontSize * 1.4;
  }

  function getEffectiveLineCount() {
    if (!meta) {
      return 1;
    }
    if (filterMode) {
      if (filterMatchCount != null) {
        return Math.max(1, filterMatchCount);
      }
      return Math.max(1, currentRangeEnd - currentRangeStart);
    }
    const baseLine = getViewBaseLine();
    if (meta.lineCount != null) {
      const visible = Math.max(0, meta.lineCount - baseLine);
      return Math.max(1, visible);
    }
    const estimate = Math.ceil(meta.fileSize / ESTIMATED_BYTES_PER_LINE);
    return Math.max(1, estimate);
  }

  function getCurrentChunkSpan() {
    const fallback = meta && meta.chunkLines ? meta.chunkLines : 200;
    const span = currentRangeEnd > currentRangeStart ? currentRangeEnd - currentRangeStart : fallback;
    return Math.max(1, span);
  }

  function hasChunkCovering(line) {
    return renderedChunks.some((chunk) => line >= chunk.start && line < chunk.end);
  }

  function hasFilterChunkCovering(matchIndex) {
    return renderedFilterChunks.some((chunk) => matchIndex >= chunk.start && matchIndex < chunk.end);
  }

  function setSpacerHeight() {
    const lineCount = getEffectiveLineCount();
    const height = Math.max(1, Math.ceil(lineCount * lineHeight));
    spacer.style.height = `${height}px`;
    logDebug("spacer", { lineCount, height, lineHeight, filterMode, filterMatchCount });
  }

  function updateFileMeta() {
    if (!meta) {
      return;
    }
    fileMeta.textContent = `${formatBytes(meta.fileSize)} total • ${formatLineCount(
      meta.lineCount
    )}`;
  }

  function updateRange(startLine, linesInText) {
    if (!meta) {
      return;
    }
    const endLine = startLine + Math.max(0, linesInText - 1);
    const startLabel = startLine + 1;
    const endLabel = Math.max(startLabel, endLine + 1);
    if (meta.lineCount != null) {
      rangeMeta.textContent = `Lines ${startLabel.toLocaleString()} - ${endLabel.toLocaleString()} of ${meta.lineCount.toLocaleString()}`;
    } else {
      rangeMeta.textContent = `Lines ${startLabel.toLocaleString()} - ${endLabel.toLocaleString()}`;
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function randomColor() {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 65;
    const lightness = 55;
    const toRgb = (l, s, h) => {
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const hp = h / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      let r = 0;
      let g = 0;
      let b = 0;
      if (hp >= 0 && hp < 1) {
        r = c;
        g = x;
      } else if (hp >= 1 && hp < 2) {
        r = x;
        g = c;
      } else if (hp >= 2 && hp < 3) {
        g = c;
        b = x;
      } else if (hp >= 3 && hp < 4) {
        g = x;
        b = c;
      } else if (hp >= 4 && hp < 5) {
        r = x;
        b = c;
      } else if (hp >= 5 && hp < 6) {
        r = c;
        b = x;
      }
      const m = l - c / 2;
      return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255),
      };
    };
    const rgb = toRgb(lightness / 100, saturation / 100, hue);
    const toHex = (value) => value.toString(16).padStart(2, "0");
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
  }

  function categoryStorageKey() {
    const fileKey = meta && meta.filePath ? meta.filePath : meta?.fileName || "unknown";
    return `${CATEGORY_STORAGE_PREFIX}:${fileKey}`;
  }

  function loadCategories() {
    if (!meta) {
      categories = [];
      categoryMatchers = [];
      return;
    }
    const key = categoryStorageKey();
    categoriesKey = key;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        categories = JSON.parse(raw);
      } else {
        categories = [];
      }
    } catch (err) {
      categories = [];
    }
    categories = categories.map((category) => ({
      id: category.id || String(Math.random()),
      pattern: category.pattern || "",
      color: category.color || randomColor(),
      hidden: Boolean(category.hidden),
      solo: Boolean(category.solo),
    }));
    normalizeSolo();
    compileCategories();
    renderCategoryList();
    const config = getFilterConfig();
    const previousFilterMode = filterMode;
    applyFilterConfigChange(previousFilterMode, config);
  }

  function saveCategories() {
    if (!meta) {
      return;
    }
    const key = categoryStorageKey();
    try {
      localStorage.setItem(key, JSON.stringify(categories));
    } catch (err) {
      // Ignore storage failures.
    }
  }

  function compileCategories() {
    categoryMatchers = categories.map((category) => {
      let regex = null;
      let error = null;
      if (category.pattern) {
        try {
          regex = new RegExp(category.pattern, "i");
        } catch (err) {
          error = err.message;
        }
      }
      return { category, regex, error };
    });
  }

  function normalizeSolo() {
    const solo = categories.find((category) => category.solo);
    if (!solo) {
      categories.forEach((category) => {
        category.solo = false;
      });
    } else {
      categories.forEach((category) => {
        category.solo = category.id === solo.id;
      });
    }
  }

  function updateCategories(nextCategories) {
    const previousFilterMode = filterMode;
    categories = nextCategories;
    normalizeSolo();
    soloCategoryId = categories.find((category) => category.solo)?.id || null;
    compileCategories();
    const config = getFilterConfig();
    saveCategories();
    renderCategoryList();
    applyFilterConfigChange(previousFilterMode, config);
  }

  function renderCategoryList() {
    if (!categoryList || !categoryEmpty) {
      return;
    }
    categoryList.innerHTML = "";
    categoryEmpty.style.display = categories.length === 0 ? "block" : "none";

    categories.forEach((category, index) => {
      const card = document.createElement("div");
      card.className = "category-card";
      card.dataset.index = String(index);

      const patternRow = document.createElement("div");
      patternRow.className = "category-row";
      const patternInput = document.createElement("input");
      patternInput.type = "text";
      patternInput.className = "form-control form-control-sm";
      patternInput.value = category.pattern;
      patternInput.placeholder = "Regex";
      patternInput.oninput = () => {
        categories[index].pattern = patternInput.value;
        compileCategories();
        saveCategories();
        rerenderCurrentView();
        const matcher = categoryMatchers[index];
        if (matcher && matcher.error) {
          patternInput.classList.add("is-invalid");
          patternInput.title = matcher.error;
        } else {
          patternInput.classList.remove("is-invalid");
          patternInput.title = "";
        }
      };
      const matcher = categoryMatchers[index];
      if (matcher && matcher.error) {
        patternInput.classList.add("is-invalid");
        patternInput.title = matcher.error;
      }
      patternRow.appendChild(patternInput);
      card.appendChild(patternRow);

      const actionRow = document.createElement("div");
      actionRow.className = "category-actions";

      const dragHandle = document.createElement("button");
      dragHandle.type = "button";
      dragHandle.className = "category-action drag-handle";
      dragHandle.title = "Reorder";
      dragHandle.draggable = true;
      dragHandle.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 7h2v2H9V7zm4 0h2v2h-2V7zM9 11h2v2H9v-2zm4 0h2v2h-2v-2zM9 15h2v2H9v-2zm4 0h2v2h-2v-2z"/></svg>';
      dragHandle.ondragstart = (event) => {
        event.dataTransfer.setData("text/plain", String(index));
        event.dataTransfer.effectAllowed = "move";
      };
      actionRow.appendChild(dragHandle);

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.className = "category-color";
      colorInput.value = category.color;
      colorInput.oninput = () => {
        categories[index].color = colorInput.value;
        saveCategories();
        rerenderCurrentView();
      };
      actionRow.appendChild(colorInput);

      const hideButton = document.createElement("button");
      hideButton.type = "button";
      hideButton.className = `category-action${category.hidden ? " is-active" : ""}`;
      hideButton.title = "Hide";
      hideButton.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 12c2.5-4 6-6 10-6s7.5 2 10 6c-1 1.6-2.2 2.9-3.6 3.9l2 2-1.4 1.4-18-18L2 3.4l3 3C3.8 7.1 2.8 9.4 2 12zm6.1-2.9 2.1 2.1a2 2 0 0 0 2.6 2.6l2.1 2.1A6 6 0 0 1 8.1 9.1z"/></svg>';
      hideButton.onclick = () => {
        categories[index].hidden = !categories[index].hidden;
        updateCategories([...categories]);
      };
      actionRow.appendChild(hideButton);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "category-action";
      deleteButton.title = "Delete";
      deleteButton.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9z"/></svg>';
      deleteButton.onclick = () => {
        const next = categories.filter((_, i) => i !== index);
        updateCategories(next);
      };
      actionRow.appendChild(deleteButton);

      const soloButton = document.createElement("button");
      soloButton.type = "button";
      soloButton.className = `category-action${category.solo ? " is-active" : ""}`;
      soloButton.title = "Solo";
      soloButton.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>';
      soloButton.onclick = async () => {
        const wasSolo = Boolean(category.solo);
        categories.forEach((item) => {
          item.solo = item.id === category.id ? !category.solo : false;
        });
        if (!wasSolo && soloRestoreScrollTop == null) {
          soloRestoreScrollTop = scrollArea.scrollTop;
        }
        updateCategories([...categories]);
        if (!wasSolo) {
          await activateSolo(category);
        } else {
          await deactivateSolo();
        }
      };
      actionRow.appendChild(soloButton);

      card.appendChild(actionRow);
      card.ondragover = (event) => {
        event.preventDefault();
        card.classList.add("drag-over");
      };
      card.ondragleave = () => {
        card.classList.remove("drag-over");
      };
      card.ondrop = (event) => {
        event.preventDefault();
        card.classList.remove("drag-over");
        const sourceIndex = Number(event.dataTransfer.getData("text/plain"));
        if (Number.isNaN(sourceIndex) || sourceIndex === index) {
          return;
        }
        const reordered = [...categories];
        const [moved] = reordered.splice(sourceIndex, 1);
        reordered.splice(index, 0, moved);
        updateCategories(reordered);
      };
      categoryList.appendChild(card);
    });
  }

  function addCategory() {
    const next = [
      ...categories,
      {
        id: String(Date.now() + Math.random()),
        pattern: "",
        color: randomColor(),
        hidden: false,
        solo: false,
      },
    ];
    updateCategories(next);
  }

  function normalizeSelectedLines(rawLines) {
    const filtered = rawLines
      .map((line) => line.replace(/\r/g, ""))
      .map((line) => line.slice(0, MAX_AI_LINE_LENGTH))
      .filter((line) => line.trim().length > 0);
    const sliced = filtered.slice(0, MAX_AI_LINES);
    let truncated = filtered.length > sliced.length;
    let remaining = MAX_AI_TOTAL_CHARS;
    const lines = [];
    sliced.forEach((line) => {
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const portion = line.slice(0, remaining);
      if (portion.length !== line.length) {
        truncated = true;
      }
      lines.push(portion);
      remaining -= portion.length;
    });
    return { lines, truncated };
  }

  function captureSelectedLines() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return { lines: [], truncated: false };
    }
    const range = selection.getRangeAt(0);
    const insideLog =
      logContent.contains(range.startContainer) && logContent.contains(range.endContainer);
    if (!insideLog) {
      return { lines: [], truncated: false };
    }
    const text = selection.toString() || "";
    const rawLines = text.split("\n");
    return normalizeSelectedLines(rawLines);
  }

  function handleLineCheckboxChange(event) {
    const target = event.target;
    if (!target || target.type !== "checkbox" || !target.classList.contains("line-select")) {
      return;
    }
    const lineNo = Number(target.dataset.line);
    if (Number.isNaN(lineNo)) {
      return;
    }
    const row = target.closest(".log-line-row");
    const lineSpan = row ? row.querySelector(".log-line") : null;
    const lineText = lineSpan ? lineSpan.textContent || "" : "";
    if (target.checked) {
      selectedLines.set(lineNo, lineText);
    } else {
      selectedLines.delete(lineNo);
    }
    if (aiSuggestButton) {
      aiSuggestButton.disabled = selectedLines.size === 0;
    }
  }

  function closeAiDialog() {
    if (!aiDialog) {
      return;
    }
    aiDialog.hidden = true;
    aiSelectionLines = [];
    aiSuggestions = [];
    aiSelectedPattern = null;
    aiRequestInFlight = false;
    if (aiSuggestionList) {
      aiSuggestionList.innerHTML = "";
    }
    if (aiSuggestionStatus) {
      aiSuggestionStatus.textContent = "Choose lines in the log, then request suggestions.";
    }
    if (aiApplyButton) {
      aiApplyButton.disabled = true;
    }
  }

  function selectAiSuggestion(pattern, element) {
    aiSelectedPattern = pattern;
    if (aiSuggestionList) {
      const children = aiSuggestionList.querySelectorAll(".ai-suggestion");
      children.forEach((node) => {
        node.classList.toggle("is-selected", node === element);
      });
    }
    if (aiApplyButton) {
      aiApplyButton.disabled = !aiSelectedPattern;
    }
  }

  function renderAiSuggestions(rejected, totalReturned) {
    if (!aiSuggestionList || !aiSuggestionStatus) {
      return;
    }
    aiSuggestionList.innerHTML = "";
    if (!aiSuggestions || aiSuggestions.length === 0) {
      const hadResults = typeof totalReturned === "number" && totalReturned > 0;
      const message = hadResults
        ? "No suggestions matched all selected lines."
        : "No suggestions returned. Try selecting a different slice of lines.";
      aiSuggestionStatus.textContent = message;
      if (aiApplyButton) {
        aiApplyButton.disabled = true;
      }
      return;
    }
    if (aiApplyButton) {
      aiApplyButton.disabled = !aiSelectedPattern;
    }
    if (typeof rejected === "number" && rejected > 0) {
      aiSuggestionStatus.textContent = `${aiSuggestions.length} patterns match all selected lines (${rejected} discarded).`;
    } else {
      aiSuggestionStatus.textContent = `${aiSuggestions.length} patterns match all selected lines.`;
    }
    aiSuggestions.forEach((pattern, index) => {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "ai-suggestion";
      entry.dataset.pattern = pattern;
      const text = document.createElement("div");
      text.className = "ai-suggestion-text";
      text.textContent = pattern;
      const meta = document.createElement("div");
      meta.className = "ai-suggestion-meta";
      meta.textContent = `Option ${index + 1}`;
      entry.appendChild(text);
      entry.appendChild(meta);
      entry.onclick = () => selectAiSuggestion(pattern, entry);
      aiSuggestionList.appendChild(entry);
    });
  }

  async function requestAiSuggestions() {
    if (!aiSelectionLines || aiSelectionLines.length === 0) {
      if (aiSuggestionStatus) {
        aiSuggestionStatus.textContent = "Select some log lines first.";
      }
      return;
    }
    if (aiRequestInFlight) {
      return;
    }
    aiRequestInFlight = true;
    aiSuggestions = [];
    aiSelectedPattern = null;
    if (aiApplyButton) {
      aiApplyButton.disabled = true;
    }
    if (aiSuggestionList) {
      aiSuggestionList.innerHTML = "";
    }
    if (aiSuggestionStatus) {
      aiSuggestionStatus.textContent = "Requesting suggestions...";
    }
    try {
      const response = await fetch("/api/ai-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: aiSelectionLines }),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (err) {
        payload = null;
      }
      if (!response.ok) {
        const message = payload && payload.error ? payload.error : "Failed to fetch suggestions";
        throw new Error(message);
      }
      if (aiDialog && aiDialog.hidden) {
        return;
      }
      aiSuggestions = Array.isArray(payload?.suggestions)
        ? payload.suggestions.filter((entry) => typeof entry === "string")
        : [];
      aiSuggestions = Array.from(new Set(aiSuggestions));
      const rejected = typeof payload?.rejected === "number" ? payload.rejected : 0;
      const totalReturned =
        typeof payload?.totalReturned === "number"
          ? payload.totalReturned
          : aiSuggestions.length;
      renderAiSuggestions(rejected, totalReturned);
    } catch (err) {
      if (aiSuggestionStatus) {
        aiSuggestionStatus.textContent = err && err.message ? err.message : "Request failed";
      }
    } finally {
      aiRequestInFlight = false;
    }
  }

  function openAiDialogFromSelection() {
    if (!aiDialog || !aiSelection || !aiSuggestionStatus) {
      return;
    }
    if (selectedLines.size === 0) {
      return;
    }
    const ordered = Array.from(selectedLines.entries()).sort((a, b) => a[0] - b[0]);
    const captured = normalizeSelectedLines(ordered.map((entry) => entry[1] || ""));
    aiSelectionLines = captured.lines;
    aiSelectedPattern = null;
    aiSuggestions = [];
    aiSelection.textContent =
      aiSelectionLines.length > 0 ? aiSelectionLines.join("\n") : "(no lines selected)";
    if (aiSuggestionList) {
      aiSuggestionList.innerHTML = "";
    }
    if (aiApplyButton) {
      aiApplyButton.disabled = true;
    }
    aiDialog.hidden = false;
    if (captured.lines.length === 0) {
      aiSuggestionStatus.textContent =
        "No selected lines. Check the boxes beside log lines, then try again.";
      return;
    }
    if (captured.truncated) {
      aiSuggestionStatus.textContent = "Selection truncated; requesting suggestions...";
    } else {
      aiSuggestionStatus.textContent = "Requesting suggestions...";
    }
    requestAiSuggestions();
  }

  function applySelectedSuggestion() {
    if (!aiSelectedPattern) {
      return;
    }
    const next = [
      ...categories,
      {
        id: String(Date.now() + Math.random()),
        pattern: aiSelectedPattern,
        color: randomColor(),
        hidden: false,
        solo: false,
      },
    ];
    updateCategories(next);
    closeAiDialog();
  }

  function resetFilterState() {
    filterMatchCount = null;
    filterChunkLines = [];
    filterChunkLineNumbers = [];
    filterChunkStart = 0;
    filterPrefetched = null;
    filterPrefetchPromise = null;
    filterPrefetchStart = null;
    renderedFilterChunks = [];
  }

  function applyFilterConfigChange(previousFilterMode, config) {
    filterMode = config ? config.mode : null;
    filterPattern = config ? config.includePattern || config.excludePattern || null : null;
    logDebug("filter-config", { filterMode, filterPattern, soloCategoryId, searchPattern });
    if (filterMode) {
      resetFilterState();
      renderedChunks = [];
      renderChunks();
      scheduleFilterRefresh();
      return;
    }
    if (previousFilterMode) {
      resetFilterState();
      renderedChunks = [];
      setSpacerHeight();
      renderChunks();
      const currentLine = Math.floor(scrollArea.scrollTop / lineHeight);
      loadChunk(currentLine, { force: true });
      return;
    }
    rerenderCurrentView();
  }

  function applySearch(value) {
    const previousFilterMode = filterMode;
    searchPattern = value.trim();
    const config = getFilterConfig();
    applyFilterConfigChange(previousFilterMode, config);
  }

  function onSearchInput() {
    if (!searchInput) {
      return;
    }
    if (searchDebounce) {
      clearTimeout(searchDebounce);
    }
    searchDebounce = setTimeout(() => {
      applySearch(searchInput.value || "");
    }, 200);
  }

  function scheduleFilterRefresh() {
    if (!filterMode) {
      return;
    }
    if (soloRefreshTimer) {
      clearTimeout(soloRefreshTimer);
    }
    soloRefreshTimer = setTimeout(async () => {
      filterMatchCount = null;
      logDebug("filter-refresh", { filterMode, filterPattern });
      await fetchMatchCount();
      setSpacerHeight();
      scrollArea.scrollTop = 0;
      currentRangeStart = 0;
      currentRangeEnd = 0;
      renderedChunks = [];
      renderedFilterChunks = [];
      renderChunks();
      await loadFilteredChunk(0, { force: true });
    }, 200);
  }

  async function activateSolo(category) {
    if (!meta) {
      return;
    }
    soloCategoryId = category.id;
    const previousFilterMode = filterMode;
    const config = getFilterConfig();
    applyFilterConfigChange(previousFilterMode, config);
  }

  async function deactivateSolo() {
    const previousFilterMode = filterMode;
    soloCategoryId = null;
    const config = getFilterConfig();
    if (config) {
      applyFilterConfigChange(previousFilterMode, config);
      return;
    }
    resetFilterState();
    renderedChunks = [];
    currentRangeStart = 0;
    currentRangeEnd = 0;
    setSpacerHeight();
    renderChunks();
    if (soloRestoreScrollTop != null) {
      scrollArea.scrollTop = soloRestoreScrollTop;
      soloRestoreScrollTop = null;
      const restoreLine = Math.floor(scrollArea.scrollTop / lineHeight);
      await loadChunk(restoreLine, { force: true });
    } else {
      await loadChunk(currentRangeStart, { force: true });
    }
  }

  function renderChunkContent(chunk) {
    const rawText = chunk.text || "";
    let lines = rawText.split("\n");
    if (rawText.endsWith("\n")) {
      lines = lines.slice(0, -1);
    }
    const lineNumbersList = [];
    const contentBuffer = [];

    lines.forEach((line, index) => {
      const lineNo = chunk.start + index + 1 + getViewBaseLine();
      const matches = categoryMatchers.filter((matcher) => {
        if (!matcher.regex) {
          return false;
        }
        if (matcher.regex.global) {
          matcher.regex.lastIndex = 0;
        }
        return matcher.regex.test(line);
      });
      const marked = matches.length > 0 ? matches[0] : null;
      const classes = ["log-line"];
      let style = "";
      if (marked) {
        classes.push("marked");
        style = ` style="--mark-color: ${marked.category.color}"`;
      }
      const safeLine = line.length === 0 ? "&nbsp;" : escapeHtml(line);
      contentBuffer.push(
        `<label class="log-line-row"><input type="checkbox" class="line-select"${selectedLines.has(lineNo) ? " checked" : ""} data-line="${lineNo}" /><span class="${classes.join(" ")}"${style}>${safeLine}</span></label>`
      );
      lineNumbersList.push(lineNo);
    });

    const baseLine = getViewBaseLine();
    const totalLines =
      meta && meta.lineCount != null ? meta.lineCount : chunk.start + lines.length + baseLine;
    const width = String(Math.max(1, totalLines)).length;
    const lineNumbersText = lineNumbersEnabled
      ? lineNumbersList.map((lineNo) => String(lineNo).padStart(width, " ")).join("\n")
      : "";

    return {
      html: contentBuffer.join(""),
      lineNumbersText,
      lineCount: lineNumbersList.length,
    };
  }

  function renderChunks() {
    if (renderedChunks.length === 0) {
      currentRangeStart = 0;
      currentRangeEnd = 0;
      logContent.innerHTML = "";
      lineNumbers.textContent = "";
      rangeMeta.textContent = "";
      return;
    }
    renderedChunks.sort((a, b) => a.start - b.start);
    const htmlParts = [];
    const lineNumberParts = [];

    renderedChunks.forEach((chunk) => {
      const rendered = renderChunkContent(chunk);
      chunk.lineCount = rendered.lineCount;
      chunk.end = chunk.start + rendered.lineCount;
      htmlParts.push(rendered.html);
      if (lineNumbersEnabled && rendered.lineNumbersText) {
        lineNumberParts.push(rendered.lineNumbersText);
      }
    });

    currentRangeStart = renderedChunks[0].start;
    currentRangeEnd = renderedChunks[renderedChunks.length - 1].end;
    logRow.style.top = `${currentRangeStart * lineHeight}px`;
    logRow.style.transform = "translateY(0)";
    logContent.innerHTML = htmlParts.join("");
    lineNumbers.textContent = lineNumbersEnabled ? lineNumberParts.join("\n") : "";
    rangeMeta.textContent = buildRangeLabel(
      currentRangeStart,
      Math.max(0, currentRangeEnd - currentRangeStart)
    );
  }

  function upsertChunk(text, startLine, directionHint) {
    const cleanText = text || "";
    const lineCount = countLinesInText(cleanText);
    const chunk = {
      start: startLine,
      end: startLine + lineCount,
      lineCount,
      text: cleanText,
    };
    const direction =
      directionHint ||
      (renderedChunks.length > 0 && startLine < renderedChunks[0].start ? "up" : "down");

    renderedChunks = renderedChunks.filter((entry) => entry.start !== chunk.start);
    renderedChunks.push(chunk);
    renderedChunks.sort((a, b) => a.start - b.start);

    while (renderedChunks.length > MAX_RENDERED_CHUNKS) {
      if (direction === "up") {
        renderedChunks.pop();
      } else {
        renderedChunks.shift();
      }
    }

    renderChunks();
  }

  function renderFilteredChunks() {
    if (renderedFilterChunks.length === 0) {
      currentRangeStart = 0;
      currentRangeEnd = 0;
      logContent.innerHTML = "";
      lineNumbers.textContent = "";
      rangeMeta.textContent = "";
      return;
    }
    renderedFilterChunks.sort((a, b) => a.start - b.start);
    const totalMatches =
      filterMatchCount || renderedFilterChunks[renderedFilterChunks.length - 1].end;
    const width = String(Math.max(1, totalMatches || 1)).length;
    const lineNumberParts = [];
    const htmlParts = [];
    const config = getFilterConfig();
    const highlight = config?.highlightId
      ? categories.find((category) => category.id === config.highlightId)
      : null;

    renderedFilterChunks.forEach((chunk) => {
      const lines = chunk.lines || [];
      const lineNumbersList = chunk.lineNumbers || [];
      chunk.lineCount = lines.length;
      chunk.end = chunk.start + chunk.lineCount;

      lines.forEach((line, index) => {
        let color = highlight ? highlight.color : null;
        if (!color) {
          const matches = categoryMatchers.filter((matcher) => {
            if (!matcher.regex) {
              return false;
            }
            if (matcher.regex.global) {
              matcher.regex.lastIndex = 0;
            }
            return matcher.regex.test(line);
          });
          const visible = matches.find((matcher) => !matcher.category.hidden);
          color = visible ? visible.category.color : null;
        }
        const classes = ["log-line"];
        let style = "";
        if (color) {
          classes.push("marked");
          style = ` style="--mark-color: ${color}"`;
        }
        const lineNo = lineNumbersList[index];
        const safeLine = line.length === 0 ? "&nbsp;" : escapeHtml(line);
        htmlParts.push(
          `<label class="log-line-row"><input type="checkbox" class="line-select"${selectedLines.has(lineNo) ? " checked" : ""} data-line="${lineNo}" /><span class="${classes.join(" ")}"${style}>${safeLine}</span></label>`
        );
        if (lineNumbersEnabled) {
          lineNumberParts.push(String(lineNo).padStart(width, " "));
        }
      });
    });

    currentRangeStart = renderedFilterChunks[0].start;
    currentRangeEnd = renderedFilterChunks[renderedFilterChunks.length - 1].end;
    logRow.style.top = `${currentRangeStart * lineHeight}px`;
    logRow.style.transform = "translateY(0)";
    logContent.innerHTML = htmlParts.join("");
    lineNumbers.textContent = lineNumbersEnabled ? lineNumberParts.join("\n") : "";
    const rangeLabel =
      config && config.mode === "exclude"
        ? buildMatchRangeLabel(
            currentRangeStart,
            Math.max(0, currentRangeEnd - currentRangeStart),
            totalMatches
          ).replace("Matches", "Filtered")
        : buildMatchRangeLabel(
            currentRangeStart,
            Math.max(0, currentRangeEnd - currentRangeStart),
            totalMatches
          );
    rangeMeta.textContent = rangeLabel;
  }

  function upsertFilteredChunk(lines, lineNumbersList, startMatch, directionHint) {
    const chunk = {
      start: startMatch,
      end: startMatch + lines.length,
      lineCount: lines.length,
      lines,
      lineNumbers: lineNumbersList,
    };
    const direction =
      directionHint ||
      (renderedFilterChunks.length > 0 && startMatch < renderedFilterChunks[0].start
        ? "up"
        : "down");
    renderedFilterChunks = renderedFilterChunks.filter((entry) => entry.start !== chunk.start);
    renderedFilterChunks.push(chunk);
    renderedFilterChunks.sort((a, b) => a.start - b.start);

    while (renderedFilterChunks.length > MAX_RENDERED_CHUNKS) {
      if (direction === "up") {
        renderedFilterChunks.pop();
      } else {
        renderedFilterChunks.shift();
      }
    }
    renderFilteredChunks();
  }

  function renderFilteredChunk(lines, lineNumbersList, startMatch) {
    filterChunkLines = lines;
    filterChunkLineNumbers = lineNumbersList;
    filterChunkStart = startMatch;
    const totalMatches = filterMatchCount || startMatch + lines.length;
    currentRangeStart = startMatch;
    currentRangeEnd = startMatch + lines.length;
    const config = getFilterConfig();
    const rangeLabel =
      config && config.mode === "exclude"
        ? buildMatchRangeLabel(startMatch, lines.length, totalMatches).replace(
            "Matches",
            "Filtered"
          )
        : buildMatchRangeLabel(startMatch, lines.length, totalMatches);

    const width = String(Math.max(1, totalMatches || 1)).length;
    const lineNumbersBuffer = [];
    const contentBuffer = [];
    const highlight = config?.highlightId
      ? categories.find((category) => category.id === config.highlightId)
      : null;

    lines.forEach((line, index) => {
      let color = highlight ? highlight.color : null;
      if (!color) {
        const matches = categoryMatchers.filter((matcher) => {
          if (!matcher.regex) {
            return false;
          }
          if (matcher.regex.global) {
            matcher.regex.lastIndex = 0;
          }
          return matcher.regex.test(line);
        });
        const visible = matches.find((matcher) => !matcher.category.hidden);
        color = visible ? visible.category.color : null;
      }
      const classes = ["log-line"];
      let style = "";
      if (color) {
        classes.push("marked");
        style = ` style="--mark-color: ${color}"`;
      }
      const lineNo = lineNumbersList[index];
      const safeLine = line.length === 0 ? "&nbsp;" : escapeHtml(line);
      contentBuffer.push(
        `<label class="log-line-row"><input type="checkbox" class="line-select"${selectedLines.has(lineNo) ? " checked" : ""} data-line="${lineNo}" /><span class="${classes.join(" ")}"${style}>${safeLine}</span></label>`
      );
      if (lineNumbersEnabled) {
        lineNumbersBuffer.push(String(lineNo).padStart(width, " "));
      }
    });

    logContent.innerHTML = contentBuffer.join("");
    logRow.style.top = `${startMatch * lineHeight}px`;
    logRow.style.transform = "translateY(0)";
    if (lineNumbersEnabled) {
      lineNumbers.textContent = lineNumbersBuffer.join("\n");
    } else {
      lineNumbers.textContent = "";
    }
    rangeMeta.textContent = rangeLabel;
  }

  function rerenderCurrentView() {
    if (filterMode) {
      renderFilteredChunks();
    } else {
      renderChunks();
    }
  }

  function buildRangeLabel(startLine, lineCount) {
    const baseLine = getViewBaseLine();
    const endLine = startLine + Math.max(0, lineCount - 1);
    const startLabel = startLine + 1 + baseLine;
    const endLabel = Math.max(startLabel, endLine + 1 + baseLine);
    if (meta && meta.lineCount != null) {
      return `Lines ${startLabel.toLocaleString()} - ${endLabel.toLocaleString()} of ${meta.lineCount.toLocaleString()}`;
    }
    return `Lines ${startLabel.toLocaleString()} - ${endLabel.toLocaleString()}`;
  }

  function buildMatchRangeLabel(startMatch, count, totalMatches) {
    if (count === 0) {
      return "No matching lines";
    }
    const startLabel = startMatch + 1;
    const endLabel = startMatch + count;
    if (totalMatches != null) {
      return `Matches ${startLabel.toLocaleString()} - ${endLabel.toLocaleString()} of ${totalMatches.toLocaleString()}`;
    }
    return `Matches ${startLabel.toLocaleString()} - ${endLabel.toLocaleString()}`;
  }

  function normalizeWindowStart(startLine) {
    if (!meta) {
      return 0;
    }
    const chunkLines = meta.chunkLines || 200;
    let normalized = Math.max(0, Math.floor(startLine / chunkLines) * chunkLines);
    const currentSpan = currentRangeEnd - currentRangeStart;
    if (currentSpan > 0 && startLine >= currentRangeEnd && normalized <= currentRangeStart) {
      normalized = currentRangeEnd;
    }
    return normalized;
  }

  async function fetchChunk(startLine) {
    const chunkLines = meta.chunkLines || 200;
    const baseLine = getViewBaseLine();
    const fileLine = startLine + baseLine;
    const url = `/api/chunk?file=${encodeURIComponent(
      currentFileId || ""
    )}&line=${fileLine}&lines=${chunkLines}&charset=${encodeURIComponent(
      currentCharset || ""
    )}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Chunk fetch failed");
    }
    return response.text();
  }

  function getFilterConfig() {
    const soloCategory = categories.find((category) => category.solo);
    const soloMatcher = categoryMatchers.find(
      (matcher) => matcher.category.id === soloCategory?.id
    );
    const hidden = categoryMatchers
      .filter((matcher) => matcher.category.hidden && matcher.regex)
      .map((matcher) => matcher.category);
    const hiddenPattern =
      hidden.length > 0 ? hidden.map((item) => `(?:${item.pattern})`).join("|") : "";
    const categorizedPatterns = categoryMatchers
      .filter((matcher) => matcher.regex && matcher.category.pattern)
      .map((matcher) => matcher.category.pattern);
    const categorizedPattern =
      categorizedPatterns.length > 0
        ? categorizedPatterns.map((pattern) => `(?:${pattern})`).join("|")
        : "";
    const searchValue = searchPattern ? searchPattern.trim() : "";

    let includePattern = "";
    let highlightId = null;
    if (soloCategory && soloCategory.pattern && soloMatcher && soloMatcher.regex) {
      includePattern = soloCategory.pattern;
      highlightId = soloCategory.id;
    } else if (hideUncategorized) {
      includePattern = categorizedPattern || "(?!)";
    }
    if (searchValue) {
      includePattern = includePattern
        ? `(?=${searchValue})${includePattern}`
        : searchValue;
    }

    if (includePattern) {
      return {
        mode: "include",
        includePattern,
        excludePattern: hiddenPattern || null,
        highlightId,
      };
    }
    if (hiddenPattern) {
      return { mode: "exclude", excludePattern: hiddenPattern, highlightId: null };
    }
    return null;
  }

  async function fetchFilteredChunk(startMatch) {
    const chunkLines = meta.chunkLines || 200;
    const config = getFilterConfig();
    const includePattern = config ? config.includePattern || "" : "";
    const excludePattern = config ? config.excludePattern || "" : "";
    const mode = config ? config.mode : "include";
    const minLine = getViewBaseLine();
    const minLineParam =
      tailMode === "since-open" && minLine > 0 ? `&minLine=${minLine}` : "";
    const url = `/api/filter?file=${encodeURIComponent(
      currentFileId || ""
    )}&include=${encodeURIComponent(includePattern)}&exclude=${encodeURIComponent(
      excludePattern
    )}&mode=${encodeURIComponent(
      mode
    )}&startMatch=${startMatch}&matches=${chunkLines}&charset=${encodeURIComponent(
      currentCharset || ""
    )}${minLineParam}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Filtered fetch failed");
    }
    return response.json();
  }

  async function fetchMatchCount() {
    const config = getFilterConfig();
    if (!config || (!config.includePattern && !config.excludePattern)) {
      filterMatchCount = 0;
      return;
    }
    const minLine = getViewBaseLine();
    const minLineParam =
      tailMode === "since-open" && minLine > 0 ? `&minLine=${minLine}` : "";
    const url = `/api/match-count?file=${encodeURIComponent(
      currentFileId || ""
    )}&include=${encodeURIComponent(config.includePattern || "")}&exclude=${encodeURIComponent(
      config.excludePattern || ""
    )}&mode=${encodeURIComponent(
      config.mode
    )}&charset=${encodeURIComponent(
      currentCharset || ""
    )}${minLineParam}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    if (typeof payload.count === "number") {
      filterMatchCount = payload.count;
      setSpacerHeight();
    }
  }

  function startPrefetch(startLine) {
    if (!meta) {
      return;
    }
    const normalizedStart = normalizeWindowStart(startLine);
    if (renderedChunks.some((chunk) => chunk.start === normalizedStart)) {
      return;
    }
    if (prefetched && prefetched.start === normalizedStart) {
      return;
    }
    if (prefetchPromise && prefetchStart === normalizedStart) {
      return;
    }
    prefetchStart = normalizedStart;
    prefetchPromise = fetchChunk(normalizedStart)
      .then((text) => {
        prefetched = { start: normalizedStart, text };
        return prefetched;
      })
      .catch(() => null)
      .finally(() => {
        prefetchPromise = null;
        prefetchStart = null;
      });
  }

  async function loadChunk(startLine, options) {
    if (!meta) {
      return;
    }
    const force = options && options.force;

    if (pending) {
      queuedStart = startLine;
      return;
    }

    const normalizedStart = normalizeWindowStart(startLine);
    if (
      !force &&
      (renderedChunks.some((chunk) => chunk.start === normalizedStart) ||
        normalizedStart === pendingStart)
    ) {
      return;
    }

    pending = true;
    pendingStart = normalizedStart;
    const direction = startLine < currentRangeStart ? "up" : "down";

    try {
      if (!force && prefetched && prefetched.start === normalizedStart) {
        upsertChunk(prefetched.text, normalizedStart, direction);
        prefetched = null;
        return;
      }
      if (!force && prefetchPromise && prefetchStart === normalizedStart) {
        const chunk = await prefetchPromise;
        if (chunk && chunk.start === normalizedStart) {
          upsertChunk(chunk.text, normalizedStart, direction);
          prefetched = null;
          return;
        }
      }
      const text = await fetchChunk(normalizedStart);
      upsertChunk(text, normalizedStart, direction);
    } catch (err) {
      upsertChunk("(failed to load log chunk)", normalizedStart, direction);
    } finally {
      pending = false;
      pendingStart = null;
      if (queuedStart !== null) {
        const nextStart = queuedStart;
        queuedStart = null;
        loadChunk(nextStart);
      }
    }
  }

  async function loadFilteredChunk(startMatch, options) {
    if (!meta) {
      return;
    }
    const force = options && options.force;
    if (pending) {
      queuedStart = startMatch;
      return;
    }
    const normalizedStart = normalizeWindowStart(startMatch);
    if (
      !force &&
      (renderedFilterChunks.some((chunk) => chunk.start === normalizedStart) ||
        normalizedStart === pendingStart)
    ) {
      return;
    }
    pending = true;
    pendingStart = normalizedStart;
    logDebug("filter-request", {
      startMatch,
      normalizedStart,
      currentRangeStart,
      currentRangeEnd,
      filterMatchCount,
      filterMode,
    });
    try {
      if (filterPrefetched && filterPrefetched.start === normalizedStart && !force) {
        const result = filterPrefetched.result;
        filterPrefetched = null;
        logDebug("filter-prefetch-hit", { start: normalizedStart });
        upsertFilteredChunk(
          result.matches.map((entry) => entry.text),
          result.matches.map((entry) => entry.lineNo),
          normalizedStart,
          startMatch < currentRangeStart ? "up" : "down"
        );
        return;
      }
      if (filterPrefetchPromise && filterPrefetchStart === normalizedStart && !force) {
        const prefetched = await filterPrefetchPromise;
        if (prefetched && prefetched.start === normalizedStart) {
          logDebug("filter-prefetch-promise", { start: normalizedStart });
          upsertFilteredChunk(
            prefetched.result.matches.map((entry) => entry.text),
            prefetched.result.matches.map((entry) => entry.lineNo),
            normalizedStart,
            startMatch < currentRangeStart ? "up" : "down"
          );
          filterPrefetched = null;
          return;
        }
      }
      logDebug("filter-load", { start: normalizedStart });
      const result = await fetchFilteredChunk(normalizedStart);
      const lines = result.matches.map((entry) => entry.text);
      const lineNumbersList = result.matches.map((entry) => entry.lineNo);
      upsertFilteredChunk(
        lines,
        lineNumbersList,
        normalizedStart,
        startMatch < currentRangeStart ? "up" : "down"
      );
    } catch (err) {
      upsertFilteredChunk([], [], normalizedStart, startMatch < currentRangeStart ? "up" : "down");
    } finally {
      pending = false;
      pendingStart = null;
      logDebug("filter-rendered", {
        start: normalizedStart,
        lines: currentRangeEnd - currentRangeStart,
      });
      if (queuedStart !== null) {
        const nextStart = queuedStart;
        queuedStart = null;
        loadFilteredChunk(nextStart);
      }
    }
  }

  function startFilterPrefetch(startMatch) {
    if (!meta || !filterMode) {
      return;
    }
    const normalizedStart = normalizeWindowStart(startMatch);
    if (renderedFilterChunks.some((chunk) => chunk.start === normalizedStart)) {
      return;
    }
    if (filterPrefetched && filterPrefetched.start === normalizedStart) {
      return;
    }
    if (filterPrefetchPromise && filterPrefetchStart === normalizedStart) {
      return;
    }
    filterPrefetchStart = normalizedStart;
    filterPrefetchPromise = fetchFilteredChunk(normalizedStart)
      .then((result) => {
        filterPrefetched = { start: normalizedStart, result };
        return filterPrefetched;
      })
      .catch(() => null)
      .finally(() => {
        filterPrefetchPromise = null;
        filterPrefetchStart = null;
      });
  }

  function onScroll() {
    if (!meta) {
      return;
    }
    const line = Math.floor(scrollArea.scrollTop / lineHeight);
    const bottomLine = Math.floor((scrollArea.scrollTop + scrollArea.clientHeight) / lineHeight);
    logDebug("scroll", {
      line,
      scrollTop: scrollArea.scrollTop,
      scrollHeight: scrollArea.scrollHeight,
      clientHeight: scrollArea.clientHeight,
      filterMode,
      currentRangeStart,
      currentRangeEnd,
    });
    if (filterMode) {
      logDebug("filter-scroll", {
        line,
        currentRangeStart,
        currentRangeEnd,
        filterMatchCount,
      });
      const chunkSpan = getCurrentChunkSpan();
      const preloadLines = Math.max(20, Math.floor(chunkSpan / 3));
      if (bottomLine >= currentRangeEnd - preloadLines && !hasFilterChunkCovering(currentRangeEnd)) {
        loadFilteredChunk(currentRangeEnd);
      } else if (bottomLine >= currentRangeEnd - preloadLines) {
        startFilterPrefetch(currentRangeEnd);
      }
      if (line <= currentRangeStart + preloadLines && line > 0) {
        const target = Math.max(0, currentRangeStart - chunkSpan);
        if (!hasFilterChunkCovering(target)) {
          loadFilteredChunk(target);
        } else {
          startFilterPrefetch(target);
        }
      }
      if (line < currentRangeStart || line >= currentRangeEnd) {
        loadFilteredChunk(line);
      }
      return;
    }
    const chunkSpan = getCurrentChunkSpan();
    const preloadLines = Math.max(20, Math.floor(chunkSpan / 3));
    if (bottomLine >= currentRangeEnd - preloadLines && !hasChunkCovering(currentRangeEnd)) {
      loadChunk(currentRangeEnd);
    } else if (bottomLine >= currentRangeEnd - preloadLines) {
      startPrefetch(currentRangeEnd);
    }
    if (line <= currentRangeStart + preloadLines && line > 0) {
      const target = Math.max(0, currentRangeStart - chunkSpan);
      if (!hasChunkCovering(target)) {
        loadChunk(target);
      } else {
        startPrefetch(target);
      }
    }
    if (line < currentRangeStart || line >= currentRangeEnd) {
      loadChunk(line);
    }
  }

  function applyWrapToggle() {
    if (!wrapToggle) {
      return;
    }
    wrapToggle.checked = document.body.classList.contains("wrap-on");
    wrapToggle.addEventListener("change", () => {
      document.body.classList.toggle("wrap-on", wrapToggle.checked);
      document.body.classList.toggle("wrap-off", !wrapToggle.checked);
    });
  }

  function applyLineNumbersToggle() {
    if (!lineNumbersToggle) {
      return;
    }
    lineNumbersEnabled = Boolean(meta && meta.lineNumbers);
    lineNumbersToggle.checked = lineNumbersEnabled;
    document.body.classList.toggle("line-numbers-off", !lineNumbersEnabled);
    lineNumbersToggle.addEventListener("change", () => {
      lineNumbersEnabled = lineNumbersToggle.checked;
      document.body.classList.toggle("line-numbers-off", !lineNumbersEnabled);
      rerenderCurrentView();
    });
  }

  function normalizeTailMode(value) {
    if (TAIL_MODES.includes(value)) {
      return value;
    }
    return "snapshot";
  }

  function readStorageValue(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function writeStorageValue(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      // Ignore storage failures.
    }
  }

  function setHideUncategorized(nextValue) {
    const previousFilterMode = filterMode;
    hideUncategorized = Boolean(nextValue);
    writeStorageValue(HIDE_UNCATEGORIZED_STORAGE_KEY, hideUncategorized ? "1" : "0");
    if (uncategorizedToggle) {
      uncategorizedToggle.checked = hideUncategorized;
    }
    const config = getFilterConfig();
    applyFilterConfigChange(previousFilterMode, config);
  }

  function resetViewState() {
    resetFilterState();
    renderedChunks = [];
    renderedFilterChunks = [];
    currentRangeStart = 0;
    currentRangeEnd = 0;
    selectedLines.clear();
    if (aiSuggestButton) {
      aiSuggestButton.disabled = true;
    }
  }

  function resetViewForTailMode() {
    resetViewState();
    setSpacerHeight();
    const previousFilterMode = filterMode;
    const config = getFilterConfig();
    applyFilterConfigChange(previousFilterMode, config);
    if (!filterMode) {
      renderChunks();
      loadChunk(0, { force: true });
    }
  }

  function setTailMode(nextMode, options) {
    const normalized = normalizeTailMode(nextMode);
    if (tailMode === normalized && !(options && options.force)) {
      return;
    }
    tailMode = normalized;
    writeStorageValue(TAIL_MODE_STORAGE_KEY, tailMode);
    if (tailModeSelect) {
      tailModeSelect.value = tailMode;
    }
    if (tailMode === "since-open") {
      sinceOpenBaseLine = meta && meta.lineCount != null ? meta.lineCount : null;
    } else {
      sinceOpenBaseLine = null;
    }
    if (meta) {
      resetViewForTailMode();
    }
    updateTailPolling();
  }

  function applyTailModeSelect() {
    if (!tailModeSelect) {
      return;
    }
    tailModeSelect.value = tailMode;
    tailModeSelect.addEventListener("change", () => {
      setTailMode(tailModeSelect.value);
    });
  }

  function applyHideUncategorizedToggle() {
    if (!uncategorizedToggle) {
      return;
    }
    uncategorizedToggle.checked = hideUncategorized;
    uncategorizedToggle.addEventListener("change", () => {
      setHideUncategorized(uncategorizedToggle.checked);
    });
  }

  function isNearBottom() {
    if (!scrollArea) {
      return false;
    }
    const threshold = lineHeight * 2;
    return scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight - threshold;
  }

  async function checkTailUpdates() {
    if (!meta || tailUpdateInFlight) {
      return;
    }
    tailUpdateInFlight = true;
    const previousLineCount = meta.lineCount;
    const previousFileSize = meta.fileSize;
    const stickToBottom = isNearBottom();
    try {
      await refreshMeta();
      if (tailMode === "since-open" && sinceOpenBaseLine == null && meta.lineCount != null) {
        sinceOpenBaseLine = meta.lineCount;
        resetViewForTailMode();
        return;
      }
      const lineCountChanged =
        typeof previousLineCount === "number" &&
        typeof meta.lineCount === "number" &&
        meta.lineCount > previousLineCount;
      const fileSizeChanged = meta.fileSize !== previousFileSize;
      if (!lineCountChanged && !fileSizeChanged) {
        return;
      }
      setSpacerHeight();
      if (filterMode) {
        await fetchMatchCount();
        return;
      }
      if (stickToBottom) {
        const chunkSpan = meta.chunkLines || 200;
        const totalLines = getEffectiveLineCount();
        const startLine = Math.max(0, totalLines - chunkSpan);
        await loadChunk(startLine, { force: true });
        scrollArea.scrollTop = scrollArea.scrollHeight;
      }
    } finally {
      tailUpdateInFlight = false;
    }
  }

  function updateTailPolling() {
    if (tailPollTimer) {
      clearInterval(tailPollTimer);
      tailPollTimer = null;
    }
    if (tailMode === "snapshot") {
      return;
    }
    tailPollTimer = setInterval(checkTailUpdates, TAIL_POLL_INTERVAL_MS);
  }

  function populateCharsetOptions() {
    if (!charsetSelect || !meta || !Array.isArray(meta.charsetOptions)) {
      return;
    }
    charsetSelect.innerHTML = "";
    meta.charsetOptions.forEach((option) => {
      const entry = document.createElement("option");
      entry.value = option;
      entry.textContent = option;
      charsetSelect.appendChild(entry);
    });
    charsetSelect.value = currentCharset || meta.charset;
    charsetSelect.onchange = () => {
      currentCharset = charsetSelect.value;
      const currentLine = Math.floor(scrollArea.scrollTop / lineHeight);
      currentRangeStart = 0;
      currentRangeEnd = 0;
      renderedChunks = [];
      renderedFilterChunks = [];
      selectedLines.clear();
      if (aiSuggestButton) {
        aiSuggestButton.disabled = true;
      }
      if (tailMode === "since-open") {
        sinceOpenBaseLine = null;
      }
      prefetched = null;
      prefetchPromise = null;
      pendingStart = null;
      if (filterMode) {
        scheduleFilterRefresh();
      } else {
        renderChunks();
        loadChunk(currentLine, { force: true });
      }
    };
  }

  function populateFileOptions() {
    if (!fileSelect || !meta || !Array.isArray(meta.files)) {
      return;
    }
    fileSelect.innerHTML = "";
    meta.files.forEach((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name;
      fileSelect.appendChild(option);
    });
    fileSelect.disabled = meta.files.length <= 1;
    fileSelect.value = currentFileId || meta.fileId;
    fileSelect.onchange = async () => {
      currentFileId = fileSelect.value;
      currentRangeStart = 0;
      currentRangeEnd = 0;
      renderedChunks = [];
      renderedFilterChunks = [];
      selectedLines.clear();
      if (aiSuggestButton) {
        aiSuggestButton.disabled = true;
      }
      queuedStart = null;
      prefetched = null;
      prefetchPromise = null;
      pending = false;
      soloCategoryId = null;
      filterMode = null;
      filterPattern = null;
      filterMatchCount = null;
      filterChunkLines = [];
      filterChunkLineNumbers = [];
      filterChunkStart = 0;
      if (tailMode === "since-open") {
        sinceOpenBaseLine = null;
      }
      scrollArea.scrollTop = 0;
      renderChunks();
      await refreshMeta();
      await loadChunk(0, { force: true });
    };
  }

  async function refreshMeta() {
    try {
      const response = await fetch(`/api/meta?file=${encodeURIComponent(
        currentFileId || ""
      )}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Meta fetch failed");
      }
      const updated = await response.json();
      meta = { ...meta, ...updated };
      currentFileId = meta.fileId;
      currentCharset = currentCharset || meta.charset;
      if (categoryStorageKey() !== categoriesKey) {
        loadCategories();
      }
      updateFileMeta();
      setSpacerHeight();
      if (tailMode === "since-open" && sinceOpenBaseLine == null && meta.lineCount != null) {
        sinceOpenBaseLine = meta.lineCount;
        resetViewForTailMode();
        return;
      }
      populateFileOptions();
      if (meta.lineCountReady) {
        if (metaPollTimer) {
          clearTimeout(metaPollTimer);
          metaPollTimer = null;
        }
      } else {
        metaPollTimer = setTimeout(refreshMeta, 1000);
      }
    } catch (err) {
      fileMeta.textContent = "Failed to load metadata";
    }
  }

  async function init() {
    try {
      const response = await fetch("/api/meta", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Meta fetch failed");
      }
      meta = await response.json();
      currentCharset = meta.charset;
      currentFileId = meta.fileId;
      tailMode = normalizeTailMode(readStorageValue(TAIL_MODE_STORAGE_KEY) || "snapshot");
      hideUncategorized = ["1", "true"].includes(readStorageValue(HIDE_UNCATEGORIZED_STORAGE_KEY));
      if (tailMode === "since-open" && meta.lineCount != null) {
        sinceOpenBaseLine = meta.lineCount;
      }
      lineNumbersEnabled = Boolean(meta.lineNumbers);
      soloCategoryId = null;
      filterMode = null;
      filterPattern = null;
      filterMatchCount = null;
      filterChunkLines = [];
      filterChunkLineNumbers = [];
      filterChunkStart = 0;
      renderedChunks = [];
      renderedFilterChunks = [];
      lineHeight = getLineHeightPx();
      updateFileMeta();
      setSpacerHeight();
      loadCategories();
      renderChunks();
      await loadChunk(0, { force: true });
      applyWrapToggle();
      applyLineNumbersToggle();
      applyTailModeSelect();
      applyHideUncategorizedToggle();
      populateCharsetOptions();
      populateFileOptions();
      if (addCategoryButton) {
        addCategoryButton.onclick = addCategory;
      }
      if (searchInput) {
        searchInput.addEventListener("input", onSearchInput);
      }
      if (aiSuggestButton) {
        aiSuggestButton.onclick = openAiDialogFromSelection;
        aiSuggestButton.disabled = selectedLines.size === 0;
      }
      if (aiCloseButton) {
        aiCloseButton.onclick = closeAiDialog;
      }
      if (aiRefreshButton) {
        aiRefreshButton.onclick = () => {
          requestAiSuggestions();
        };
      }
      if (aiApplyButton) {
        aiApplyButton.onclick = applySelectedSuggestion;
      }
      if (aiDialog) {
        aiDialog.addEventListener("click", (event) => {
          if (event.target === aiDialog) {
            closeAiDialog();
          }
        });
      }
      if (aiDialogBackdrop) {
        aiDialogBackdrop.onclick = () => closeAiDialog();
      }
      if (logContent) {
        logContent.addEventListener("change", handleLineCheckboxChange);
      }
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && aiDialog && !aiDialog.hidden) {
          closeAiDialog();
        }
      });
      if (!meta.lineCountReady) {
        metaPollTimer = setTimeout(refreshMeta, 1000);
      }
      scrollArea.addEventListener("scroll", () => {
        window.requestAnimationFrame(onScroll);
      });
      updateTailPolling();
    } catch (err) {
      fileMeta.textContent = "Failed to load metadata";
    }
  }

  init();
})();
