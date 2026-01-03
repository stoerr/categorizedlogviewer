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

  const ESTIMATED_BYTES_PER_LINE = 80;

  let meta = null;
  let pending = false;
  let queuedStart = null;
  let pendingStart = null;
  let lineHeight = 16;
  let currentRangeStart = 0;
  let currentRangeEnd = 0;
  let pendingStart = null;
  let currentCharset = null;
  let currentFileId = null;
  let lineNumbersEnabled = false;
  let rawChunkText = "";
  let rawChunkStart = 0;
  let metaPollTimer = null;
  let prefetched = null;
  let prefetchStart = null;
  let prefetchPromise = null;

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

  function renderChunk(text, startLine) {
    rawChunkText = text || "";
    rawChunkStart = startLine;
    logContent.textContent = rawChunkText;
    logRow.style.top = `${startLine * lineHeight}px`;
    logRow.style.transform = "translateY(0)";
    if (lineNumbersEnabled) {
      let lines = rawChunkText.split("\n");
      if (rawChunkText.endsWith("\n")) {
        lines = lines.slice(0, -1);
      }
      const totalLines =
        meta && meta.lineCount != null
          ? meta.lineCount
          : startLine + lines.length;
      const width = String(Math.max(1, totalLines)).length;
      lineNumbers.textContent = lines
        .map((_, index) => {
          const lineNo = startLine + index + 1;
          return String(lineNo).padStart(width, " ");
        })
        .join("\n");
    } else {
      lineNumbers.textContent = "";
    }
    const lines = countLinesInText(rawChunkText);
    currentRangeStart = startLine;
    currentRangeEnd = startLine + lines;
    updateRange(startLine, lines);
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
      renderChunk("", 0);
      await loadChunk(0, { force: true });
      applyWrapToggle();
      applyLineNumbersToggle();
      populateCharsetOptions();
      populateFileOptions();
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
