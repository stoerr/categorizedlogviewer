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
  const addCategoryButton = document.getElementById("add-category");
  const categoryList = document.getElementById("category-list");
  const categoryEmpty = document.getElementById("category-empty");

  const ESTIMATED_BYTES_PER_LINE = 80;
  const CATEGORY_STORAGE_PREFIX =
    "net.stoerr.Categorizedlogfileviewer.categories.com";

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
  let rawChunkText = "";
  let rawChunkStart = 0;
  let metaPollTimer = null;
  let prefetched = null;
  let prefetchStart = null;
  let prefetchPromise = null;
  let categories = [];
  let categoryMatchers = [];
  let categoriesKey = null;
  let soloRestoreScrollTop = null;

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
    if (meta.lineCount != null) {
      return Math.max(1, meta.lineCount);
    }
    return Math.max(1, Math.ceil(meta.fileSize / ESTIMATED_BYTES_PER_LINE));
  }

  function setSpacerHeight() {
    const lineCount = getEffectiveLineCount();
    const height = Math.max(1, Math.ceil(lineCount * lineHeight));
    spacer.style.height = `${height}px`;
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
      name: category.name || "",
      pattern: category.pattern || "",
      color: category.color || randomColor(),
      hidden: Boolean(category.hidden),
      solo: Boolean(category.solo),
    }));
    normalizeSolo();
    compileCategories();
    renderCategoryList();
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
          regex = new RegExp(category.pattern);
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
    categories = nextCategories;
    normalizeSolo();
    compileCategories();
    saveCategories();
    renderCategoryList();
    renderChunk(rawChunkText, rawChunkStart);
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
        renderChunk(rawChunkText, rawChunkStart);
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
        renderChunk(rawChunkText, rawChunkStart);
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
          await scrollToFirstMatch(category);
        } else if (soloRestoreScrollTop != null) {
          scrollArea.scrollTop = soloRestoreScrollTop;
          soloRestoreScrollTop = null;
          const restoreLine = Math.floor(scrollArea.scrollTop / lineHeight);
          await loadChunk(restoreLine, { force: true });
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
        name: "",
        pattern: "",
        color: randomColor(),
        hidden: false,
        solo: false,
      },
    ];
    updateCategories(next);
  }

  async function scrollToFirstMatch(category) {
    if (!meta) {
      return;
    }
    const matcher = categoryMatchers.find(
      (entry) => entry.category.id === category.id
    );
    if (!matcher || !matcher.regex) {
      scrollArea.scrollTop = 0;
      await loadChunk(0, { force: true });
      return;
    }
    const chunkLines = meta.chunkLines || 200;
    const maxLines = meta.lineCount != null ? meta.lineCount : null;
    let startLine = 0;
    while (maxLines == null || startLine < maxLines) {
      // eslint-disable-next-line no-await-in-loop
      const text = await fetchChunk(startLine);
      const lines = text.split("\n");
      if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
        break;
      }
      if (text.endsWith("\n")) {
        lines.pop();
      }
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (matcher.regex.global) {
          matcher.regex.lastIndex = 0;
        }
        if (matcher.regex.test(line)) {
          const targetLine = startLine + index;
          const targetTop = targetLine * lineHeight;
          scrollArea.scrollTop = targetTop;
          await loadChunk(targetLine, { force: true });
          await new Promise((resolve) => {
            window.requestAnimationFrame(() => resolve());
          });
          scrollArea.scrollTop = targetTop;
          return;
        }
      }
      if (lines.length < chunkLines) {
        break;
      }
      startLine += chunkLines;
    }
    scrollArea.scrollTop = 0;
  }

  function renderChunk(text, startLine) {
    rawChunkText = text || "";
    rawChunkStart = startLine;
    let lines = rawChunkText.split("\n");
    if (rawChunkText.endsWith("\n")) {
      lines = lines.slice(0, -1);
    }
    const soloCategory = categories.find((category) => category.solo);
    const totalLines =
      meta && meta.lineCount != null ? meta.lineCount : startLine + lines.length;
    const width = String(Math.max(1, totalLines)).length;
    const lineNumbersBuffer = [];
    const contentBuffer = [];
    const visibleLineNumbers = [];

    lines.forEach((line, index) => {
      const lineNo = startLine + index + 1;
      const matches = categoryMatchers.filter((matcher) => {
        if (!matcher.regex) {
          return false;
        }
        if (matcher.regex.global) {
          matcher.regex.lastIndex = 0;
        }
        return matcher.regex.test(line);
      });
      const hiddenMatch = matches.find((matcher) => matcher.category.hidden);
      if (hiddenMatch) {
        return;
      }
      const soloMatch =
        !soloCategory ||
        matches.some((matcher) => matcher.category.id === soloCategory.id);

      if (!soloMatch) {
        return;
      }

      const marked = soloCategory
        ? matches.find((matcher) => matcher.category.id === soloCategory.id)
        : matches[0];
      const classes = ["log-line"];
      let style = "";
      if (marked) {
        classes.push("marked");
        style = ` style="--mark-color: ${marked.category.color}"`;
      }
      const safeLine = line.length === 0 ? "&nbsp;" : escapeHtml(line);
      contentBuffer.push(
        `<span class="${classes.join(" ")}"${style}>${safeLine}</span>`
      );
      if (lineNumbersEnabled) {
        lineNumbersBuffer.push(String(lineNo).padStart(width, " "));
      }
      visibleLineNumbers.push(lineNo);
    });

    logContent.innerHTML = contentBuffer.join("");
    logRow.style.top = `${startLine * lineHeight}px`;
    logRow.style.transform = "translateY(0)";
    if (lineNumbersEnabled) {
      lineNumbers.textContent = lineNumbersBuffer.join("\n");
    } else {
      lineNumbers.textContent = "";
    }
    const lineCount = countLinesInText(rawChunkText);
    currentRangeStart = startLine;
    currentRangeEnd = startLine + lineCount;
    if (soloCategory && visibleLineNumbers.length > 0) {
      const first = visibleLineNumbers[0];
      const last = visibleLineNumbers[visibleLineNumbers.length - 1];
      if (meta && meta.lineCount != null) {
        rangeMeta.textContent = `Lines ${first.toLocaleString()} - ${last.toLocaleString()} of ${meta.lineCount.toLocaleString()} (solo)`;
      } else {
        rangeMeta.textContent = `Lines ${first.toLocaleString()} - ${last.toLocaleString()} (solo)`;
      }
    } else if (soloCategory) {
      rangeMeta.textContent = "No matching lines in view (solo)";
    } else {
      updateRange(startLine, lineCount);
    }
  }

  function normalizeWindowStart(startLine) {
    if (!meta) {
      return 0;
    }
    const chunkLines = meta.chunkLines || 200;
    return Math.max(0, Math.floor(startLine / chunkLines) * chunkLines);
  }

  async function fetchChunk(startLine) {
    const chunkLines = meta.chunkLines || 200;
    const url = `/api/chunk?file=${encodeURIComponent(
      currentFileId || ""
    )}&line=${startLine}&lines=${chunkLines}&charset=${encodeURIComponent(
      currentCharset || ""
    )}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Chunk fetch failed");
    }
    return response.text();
  }

  function startPrefetch(startLine) {
    if (!meta) {
      return;
    }
    const normalizedStart = normalizeWindowStart(startLine);
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
    if (!force && (normalizedStart === currentRangeStart || normalizedStart === pendingStart)) {
      return;
    }

    pending = true;
    pendingStart = normalizedStart;

    try {
      if (!force && prefetched && prefetched.start === normalizedStart) {
        renderChunk(prefetched.text, normalizedStart);
        prefetched = null;
        return;
      }
      if (!force && prefetchPromise && prefetchStart === normalizedStart) {
        const chunk = await prefetchPromise;
        if (chunk && chunk.start === normalizedStart) {
          renderChunk(chunk.text, normalizedStart);
          prefetched = null;
          return;
        }
      }
      const text = await fetchChunk(normalizedStart);
      renderChunk(text, normalizedStart);
    } catch (err) {
      renderChunk("(failed to load log chunk)", normalizedStart);
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

  function onScroll() {
    if (!meta) {
      return;
    }
    const line = Math.floor(scrollArea.scrollTop / lineHeight);
    const chunkLines = meta.chunkLines || 200;
    const preloadLines = Math.max(20, Math.floor(chunkLines / 4));
    if (line >= currentRangeEnd - preloadLines) {
      startPrefetch(currentRangeStart + chunkLines);
    }
    if (line <= currentRangeStart + preloadLines && line > 0) {
      startPrefetch(Math.max(0, currentRangeStart - chunkLines));
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
      renderChunk(rawChunkText, rawChunkStart);
    });
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
      rawChunkText = "";
      prefetched = null;
      prefetchPromise = null;
      pendingStart = null;
      loadChunk(currentLine, { force: true });
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
      rawChunkText = "";
      queuedStart = null;
      prefetched = null;
      prefetchPromise = null;
      pending = false;
      scrollArea.scrollTop = 0;
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
      lineNumbersEnabled = Boolean(meta.lineNumbers);
      lineHeight = getLineHeightPx();
      updateFileMeta();
      setSpacerHeight();
      loadCategories();
      renderChunk("", 0);
      await loadChunk(0, { force: true });
      applyWrapToggle();
      applyLineNumbersToggle();
      populateCharsetOptions();
      populateFileOptions();
      if (addCategoryButton) {
        addCategoryButton.onclick = addCategory;
      }
      if (!meta.lineCountReady) {
        metaPollTimer = setTimeout(refreshMeta, 1000);
      }
      scrollArea.addEventListener("scroll", () => {
        window.requestAnimationFrame(onScroll);
      });
    } catch (err) {
      fileMeta.textContent = "Failed to load metadata";
    }
  }

  init();
})();
