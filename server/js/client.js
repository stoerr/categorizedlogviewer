(() => {
  "use strict";

  const scrollArea = document.getElementById("scroll-area");
  const spacer = document.getElementById("spacer");
  const logContent = document.getElementById("log-content");
  const fileMeta = document.getElementById("file-meta");
  const rangeMeta = document.getElementById("range-meta");
  const wrapToggle = document.getElementById("wrap-toggle");

  let meta = null;
  let lastOffset = null;
  let pending = false;

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

  function setSpacerHeight() {
    const height = Math.max(1, Math.ceil(meta.fileSize / meta.bytesPerPixel));
    spacer.style.height = `${height}px`;
  }

  function updateRange(offset, length) {
    if (!meta) {
      return;
    }
    const end = Math.min(meta.fileSize, offset + length);
    rangeMeta.textContent = `Bytes ${offset.toLocaleString()} - ${end.toLocaleString()}`;
  }

  function renderChunk(text, offset) {
    logContent.textContent = text || "";
    if (meta) {
      const top = Math.floor(offset / meta.bytesPerPixel);
      logContent.style.top = `${top}px`;
      logContent.style.transform = "translateY(0)";
    }
    updateRange(offset, text.length);
  }

  async function loadChunk(offset) {
    if (!meta || pending) {
      return;
    }
    pending = true;

    const alignedOffset = Math.max(0, offset - (offset % meta.chunkSize));
    if (alignedOffset === lastOffset) {
      pending = false;
      return;
    }
    lastOffset = alignedOffset;

    try {
      const url = `/api/chunk?offset=${alignedOffset}&length=${meta.chunkSize}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Chunk fetch failed");
      }
      const text = await response.text();
      renderChunk(text, alignedOffset);
    } catch (err) {
      renderChunk("(failed to load log chunk)", alignedOffset);
    } finally {
      pending = false;
    }
  }

  function onScroll() {
    if (!meta) {
      return;
    }
    const offset = Math.floor(scrollArea.scrollTop * meta.bytesPerPixel);
    loadChunk(offset);
  }

  async function init() {
    try {
      const response = await fetch("/api/meta", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Meta fetch failed");
      }
      meta = await response.json();
      fileMeta.textContent = `${formatBytes(meta.fileSize)} total`;
      setSpacerHeight();
      renderChunk("", 0);
      await loadChunk(0);
      if (wrapToggle) {
        wrapToggle.checked = document.body.classList.contains("wrap-on");
        wrapToggle.addEventListener("change", () => {
          document.body.classList.toggle("wrap-on", wrapToggle.checked);
          document.body.classList.toggle("wrap-off", !wrapToggle.checked);
        });
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
