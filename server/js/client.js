(() => {
  "use strict";

  const scrollArea = document.getElementById("scroll-area");
  const spacer = document.getElementById("spacer");
  const logContent = document.getElementById("log-content");
  const fileMeta = document.getElementById("file-meta");
  const rangeMeta = document.getElementById("range-meta");
  const wrapToggle = document.getElementById("wrap-toggle");
  const charsetSelect = document.getElementById("charset-select");

  const ESTIMATED_BYTES_PER_LINE = 80;

  let meta = null;
  let pending = false;
  let queuedLine = null;
  let lineHeight = 16;
  let currentRangeStart = 0;
  let currentRangeEnd = 0;
  let currentCharset = null;
  let metaPollTimer = null;

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
    logContent.textContent = text || "";
    logContent.style.top = `${startLine * lineHeight}px`;
    logContent.style.transform = "translateY(0)";
    const lines = countLinesInText(text);
    currentRangeStart = startLine;
    currentRangeEnd = startLine + lines;
    updateRange(startLine, lines);
  }

  async function loadChunk(line) {
    if (!meta) {
      return;
    }

    if (pending) {
      queuedLine = line;
      return;
    }

    if (line >= currentRangeStart && line < currentRangeEnd) {
      return;
    }

    pending = true;
    const chunkLines = meta.chunkLines || 200;
    const startLine = Math.max(0, line - Math.floor(chunkLines / 2));

    try {
      const url = `/api/chunk?line=${startLine}&lines=${chunkLines}&charset=${encodeURIComponent(
        currentCharset || ""
      )}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Chunk fetch failed");
      }
      const text = await response.text();
      renderChunk(text, startLine);
    } catch (err) {
      renderChunk("(failed to load log chunk)", startLine);
    } finally {
      pending = false;
      if (queuedLine !== null) {
        const nextLine = queuedLine;
        queuedLine = null;
        loadChunk(nextLine);
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
      loadChunk(line + preloadLines);
      return;
    }
    if (line <= currentRangeStart + preloadLines && line > 0) {
      loadChunk(Math.max(0, line - preloadLines));
      return;
    }
    loadChunk(line);
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
    charsetSelect.addEventListener("change", () => {
      currentCharset = charsetSelect.value;
      const currentLine = Math.floor(scrollArea.scrollTop / lineHeight);
      currentRangeStart = 0;
      currentRangeEnd = 0;
      loadChunk(currentLine);
    });
  }

  async function refreshMeta() {
    try {
      const response = await fetch("/api/meta", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Meta fetch failed");
      }
      const updated = await response.json();
      meta = { ...meta, ...updated };
      updateFileMeta();
      setSpacerHeight();
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
      lineHeight = getLineHeightPx();
      updateFileMeta();
      setSpacerHeight();
      renderChunk("", 0);
      await loadChunk(0);
      applyWrapToggle();
      populateCharsetOptions();
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
