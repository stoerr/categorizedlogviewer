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
