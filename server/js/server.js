"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { TextDecoder } = require("util");
const CHUNK_LINES = 400;
const INDEX_STRIDE = 1000;
const MAX_CHUNK_BYTES = 512 * 1024;
const DEFAULT_CHARSET = "utf-8";
const CHARSET_OPTIONS = [
  "utf-8",
  "iso-8859-1",
  "iso-8859-15",
  "windows-1252",
];
const MATCH_COUNT_CACHE = new Map();

function normalizeCharset(value) {
  if (!value) {
    return DEFAULT_CHARSET;
  }
  const lower = value.toLowerCase();
  if (CHARSET_OPTIONS.includes(lower)) {
    return lower;
  }
  return DEFAULT_CHARSET;
}

function buildLineIndex(filePath, verbose) {
  const state = {
    offsets: [0],
    lineCount: 0,
    ready: false,
    error: null,
  };

  let bytesRead = 0;
  let endsWithNewline = false;
  const stream = fs.createReadStream(filePath);

  stream.on("data", (buffer) => {
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] === 10) {
        state.lineCount += 1;
        if (state.lineCount % INDEX_STRIDE === 0) {
          state.offsets.push(bytesRead + i + 1);
        }
      }
    }
    bytesRead += buffer.length;
    endsWithNewline = buffer[buffer.length - 1] === 10;
  });

  stream.on("end", () => {
    if (bytesRead > 0 && !endsWithNewline) {
      state.lineCount += 1;
    }
    state.ready = true;
  });

  stream.on("error", (err) => {
    state.error = err;
    state.ready = true;
    if (verbose) {
      process.stderr.write(`[error] ${err.stack || err.message}\n`);
    }
  });

  return state;
}

function getBaseOffset(lineIndex, targetLine) {
  const strideIndex = Math.max(0, Math.floor(targetLine / INDEX_STRIDE));
  const safeIndex = Math.min(strideIndex, lineIndex.offsets.length - 1);
  const baseLine = safeIndex * INDEX_STRIDE;
  const baseOffset = lineIndex.offsets[safeIndex];
  return { baseLine, baseOffset };
}

function getDecoder(charset) {
  const normalized = normalizeCharset(charset);
  try {
    return new TextDecoder(normalized);
  } catch (err) {
    return new TextDecoder(DEFAULT_CHARSET);
  }
}

function scanFileLines(filePath, charset, onLine) {
  const decoder = getDecoder(charset);
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    let buffer = "";
    let lineNo = 0;
    let stopped = false;
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(lineNo);
    };

    stream.on("data", (chunk) => {
      if (stopped) {
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1 && !stopped) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        lineNo += 1;
        const keepGoing = onLine(line, lineNo);
        if (keepGoing === false) {
          stopped = true;
          stream.destroy();
          return;
        }
        idx = buffer.indexOf("\n");
      }
    });

    stream.on("end", () => {
      if (stopped) {
        finish();
        return;
      }
      buffer += decoder.decode();
      if (buffer.length > 0) {
        lineNo += 1;
        onLine(buffer, lineNo);
      }
      finish();
    });

    stream.on("close", () => {
      if (stopped) {
        finish();
      }
    });

    stream.on("error", (err) => {
      if (stopped) {
        finish();
        return;
      }
      reject(err);
    });
  });
}

function readFilteredMatches({
  filePath,
  pattern,
  startMatch,
  matchLimit,
  charset,
  mode,
  verbose,
}) {
  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch (err) {
    return Promise.reject(new Error("Invalid regex"));
  }

  const matches = [];
  let matchIndex = 0;
  let stopped = false;

  return scanFileLines(filePath, charset, (line, lineNo) => {
    if (regex.global) {
      regex.lastIndex = 0;
    }
    const isMatch = regex.test(line);
    const include = mode === "exclude" ? !isMatch : isMatch;
    if (include) {
      if (matchIndex >= startMatch && matches.length < matchLimit) {
        matches.push({ lineNo, text: line });
      }
      matchIndex += 1;
      if (matches.length >= matchLimit) {
        stopped = true;
        return false;
      }
    }
    return true;
  })
    .then(() => ({
      matches,
      startMatch,
      hasMore: stopped,
    }))
    .catch((err) => {
      if (verbose) {
        process.stderr.write(`[error] ${err.stack || err.message}\n`);
      }
      throw err;
    });
}

function countMatches({ filePath, pattern, charset, mode, verbose }) {
  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch (err) {
    return Promise.reject(new Error("Invalid regex"));
  }

  let count = 0;
  return scanFileLines(filePath, charset, (line) => {
    if (regex.global) {
      regex.lastIndex = 0;
    }
    const isMatch = regex.test(line);
    const include = mode === "exclude" ? !isMatch : isMatch;
    if (include) {
      count += 1;
    }
    return true;
  })
    .then(() => count)
    .catch((err) => {
      if (verbose) {
        process.stderr.write(`[error] ${err.stack || err.message}\n`);
      }
      throw err;
    });
}

function readLineChunk({
  filePath,
  lineIndex,
  startLine,
  lineCount,
  charset,
  verbose,
}) {
  if (lineCount <= 0) {
    return Promise.resolve({ text: "", lines: 0 });
  }

  if (lineIndex.ready && startLine >= lineIndex.lineCount) {
    return Promise.resolve({ text: "", lines: 0 });
  }

  const { baseLine, baseOffset } = getBaseOffset(lineIndex, startLine);
  const decoder = getDecoder(charset);

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start: baseOffset });
    const buffers = [];
    let currentLine = baseLine;
    let collecting = false;
    let collectedLines = 0;
    let totalBytes = 0;
    let done = false;

    stream.on("data", (buffer) => {
      if (done) {
        return;
      }

      let collectStart = collecting ? 0 : null;
      let lineStart = 0;

      if (!collecting && currentLine === startLine) {
        collecting = true;
        collectStart = 0;
      }

      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] !== 10) {
          continue;
        }

        if (!collecting && currentLine === startLine) {
          collecting = true;
          collectStart = lineStart;
        }

        if (collecting) {
          collectedLines += 1;
          if (collectedLines >= lineCount) {
            const endIndex = i + 1;
            if (collectStart !== null && collectStart < endIndex) {
              buffers.push(buffer.slice(collectStart, endIndex));
              totalBytes += endIndex - collectStart;
            }
            done = true;
            stream.destroy();
            return;
          }
        }

        currentLine += 1;
        lineStart = i + 1;

        if (!collecting && currentLine === startLine) {
          collecting = true;
          collectStart = lineStart;
        }
      }

      if (collecting) {
        const start = collectStart ?? 0;
        if (start < buffer.length) {
          buffers.push(buffer.slice(start));
          totalBytes += buffer.length - start;
        }
      }

      if (totalBytes > MAX_CHUNK_BYTES) {
        done = true;
        stream.destroy();
      }
    });

    stream.on("error", (err) => {
      if (verbose) {
        process.stderr.write(`[error] ${err.stack || err.message}\n`);
      }
      reject(err);
    });

    stream.on("close", () => {
      if (buffers.length === 0) {
        resolve({ text: "", lines: 0 });
        return;
      }
      const combined = Buffer.concat(buffers);
      const text = decoder.decode(combined);
      resolve({ text, lines: collectedLines });
    });
  });
}

function readTemplate(templatePath, replacements) {
  let html = fs.readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return html;
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    send(res, 200, body, contentType);
  } catch (err) {
    send(res, 404, "Not found");
  }
}

function start({ port, filePaths, wrap, verbose, charset, lineNumbers }) {
  const serverRoot = path.resolve(__dirname, "..", "..");
  const htmlPath = path.join(serverRoot, "server", "html", "index.html");
  const clientPath = path.join(serverRoot, "server", "js", "client.js");
  const stylePath = path.join(serverRoot, "server", "css", "style.css");

  const files = filePaths.map((filePath, index) => ({
    id: String(index),
    path: filePath,
    name: path.basename(filePath),
  }));
  const fileState = new Map();
  const defaultFileId = files.length > 0 ? files[0].id : null;

  function getFileInfo(fileId) {
    const selected = files.find((entry) => entry.id === fileId);
    if (!selected) {
      return null;
    }
    if (!fileState.has(selected.id)) {
      const stat = fs.statSync(selected.path);
      fileState.set(selected.id, {
        filePath: selected.path,
        fileName: selected.name,
        fileSize: stat.size,
        lineIndex: buildLineIndex(selected.path, verbose),
      });
    }
    return fileState.get(selected.id);
  }

  const defaultCharset = normalizeCharset(charset);

  const server = http.createServer(async (req, res) => {
    if (verbose) {
      process.stdout.write(`[request] ${req.method} ${req.url}\n`);
    }

    let parsed;
    try {
      parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    } catch (err) {
      if (verbose) {
        process.stderr.write(`[error] ${err.stack || err.message}\n`);
      }
      send(res, 400, "Bad request");
      return;
    }

    try {
      if (parsed.pathname === "/") {
        const selected = getFileInfo(defaultFileId);
        if (!selected) {
          send(res, 500, "No files configured");
          return;
        }
        const html = readTemplate(htmlPath, {
          FILE_NAME: selected.fileName,
          FILE_SIZE: String(selected.fileSize),
          WRAP_CLASS: wrap ? "wrap-on" : "wrap-off",
        });
        send(res, 200, html, "text/html; charset=utf-8");
        return;
      }

      if (parsed.pathname === "/js/client.js") {
        serveFile(res, clientPath, "application/javascript; charset=utf-8");
        return;
      }

      if (parsed.pathname === "/css/style.css") {
        serveFile(res, stylePath, "text/css; charset=utf-8");
        return;
      }

      if (parsed.pathname === "/api/meta") {
        const fileId = parsed.searchParams.get("file") || defaultFileId;
        const selected = getFileInfo(fileId);
        if (!selected) {
          send(res, 400, "Unknown file");
          return;
        }
        const payload = JSON.stringify({
          fileId: fileId,
          fileName: selected.fileName,
          filePath: selected.filePath,
          fileSize: selected.fileSize,
          chunkLines: CHUNK_LINES,
          lineCount: selected.lineIndex.ready ? selected.lineIndex.lineCount : null,
          lineCountReady: selected.lineIndex.ready,
          lineIndexStride: INDEX_STRIDE,
          charset: defaultCharset,
          charsetOptions: CHARSET_OPTIONS,
          wrap,
          lineNumbers,
          files: files.map((entry) => ({ id: entry.id, name: entry.name })),
        });
        send(res, 200, payload, "application/json; charset=utf-8");
        return;
      }

      if (parsed.pathname === "/api/chunk") {
        const fileId = parsed.searchParams.get("file") || defaultFileId;
        const selected = getFileInfo(fileId);
        if (!selected) {
          send(res, 400, "Unknown file");
          return;
        }
        const line = Number(parsed.searchParams.get("line") || 0);
        const lines = Number(parsed.searchParams.get("lines") || CHUNK_LINES);
        const charsetParam = normalizeCharset(
          parsed.searchParams.get("charset") || defaultCharset
        );

        if (Number.isNaN(line) || Number.isNaN(lines)) {
          send(res, 400, "Invalid line or lines");
          return;
        }

        const safeLine = Math.max(0, line);
        const safeLines = Math.max(1, Math.min(lines, CHUNK_LINES * 2));

        try {
          const chunk = await readLineChunk({
            filePath: selected.filePath,
            lineIndex: selected.lineIndex,
            startLine: safeLine,
            lineCount: safeLines,
            charset: charsetParam,
            verbose,
          });
          send(res, 200, chunk.text, "text/plain; charset=utf-8");
          return;
        } catch (err) {
          if (verbose) {
            process.stderr.write(`[error] ${err.stack || err.message}\n`);
          }
          send(res, 500, "Failed to read log");
          return;
        }
      }

      if (parsed.pathname === "/api/filter") {
        const fileId = parsed.searchParams.get("file") || defaultFileId;
        const selected = getFileInfo(fileId);
        if (!selected) {
          send(res, 400, "Unknown file");
          return;
        }
        const pattern = parsed.searchParams.get("pattern") || "";
        const mode = parsed.searchParams.get("mode") || "include";
        const startMatch = Number(parsed.searchParams.get("startMatch") || 0);
        const matchLimit = Number(parsed.searchParams.get("matches") || CHUNK_LINES);
        const charsetParam = normalizeCharset(
          parsed.searchParams.get("charset") || defaultCharset
        );

        if (!pattern) {
          send(res, 400, "Missing pattern");
          return;
        }
        if (mode !== "include" && mode !== "exclude") {
          send(res, 400, "Invalid mode");
          return;
        }
        if (Number.isNaN(startMatch) || Number.isNaN(matchLimit)) {
          send(res, 400, "Invalid startMatch or matches");
          return;
        }

        try {
          const result = await readFilteredMatches({
            filePath: selected.filePath,
            pattern,
            startMatch: Math.max(0, startMatch),
            matchLimit: Math.max(1, Math.min(matchLimit, CHUNK_LINES * 2)),
            charset: charsetParam,
            mode,
            verbose,
          });
          send(res, 200, JSON.stringify(result), "application/json; charset=utf-8");
          return;
        } catch (err) {
          if (verbose) {
            process.stderr.write(`[error] ${err.stack || err.message}\n`);
          }
          send(res, 400, "Invalid filter");
          return;
        }
      }

      if (parsed.pathname === "/api/match-count") {
        const fileId = parsed.searchParams.get("file") || defaultFileId;
        const selected = getFileInfo(fileId);
        if (!selected) {
          send(res, 400, "Unknown file");
          return;
        }
        const pattern = parsed.searchParams.get("pattern") || "";
        const mode = parsed.searchParams.get("mode") || "include";
        const charsetParam = normalizeCharset(
          parsed.searchParams.get("charset") || defaultCharset
        );
        if (!pattern) {
          send(res, 400, "Missing pattern");
          return;
        }
        if (mode !== "include" && mode !== "exclude") {
          send(res, 400, "Invalid mode");
          return;
        }
        const cacheKey = `${selected.filePath}::${charsetParam}::${mode}::${pattern}`;
        if (MATCH_COUNT_CACHE.has(cacheKey)) {
          const cached = MATCH_COUNT_CACHE.get(cacheKey);
          send(res, 200, JSON.stringify({ count: cached }), "application/json; charset=utf-8");
          return;
        }
        try {
          const count = await countMatches({
            filePath: selected.filePath,
            pattern,
            charset: charsetParam,
            mode,
            verbose,
          });
          MATCH_COUNT_CACHE.set(cacheKey, count);
          send(res, 200, JSON.stringify({ count }), "application/json; charset=utf-8");
          return;
        } catch (err) {
          if (verbose) {
            process.stderr.write(`[error] ${err.stack || err.message}\n`);
          }
          send(res, 400, "Invalid filter");
          return;
        }
      }

      send(res, 404, "Not found");
    } catch (err) {
      if (verbose) {
        process.stderr.write(`[error] ${err.stack || err.message}\n`);
      }
      send(res, 500, "Server error");
    }
  });

  if (verbose) {
    server.on("clientError", (err) => {
      process.stderr.write(`[error] ${err.stack || err.message}\n`);
    });
  }

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(server);
    });
  });
}

module.exports = { start };
