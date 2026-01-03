"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const CHUNK_SIZE = 64 * 1024; // 64KB default chunk
const BYTES_PER_PIXEL = 256; // virtual scroll scale

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

function start({ port, filePath, wrap, verbose }) {
  const serverRoot = path.resolve(__dirname, "..", "..");
  const htmlPath = path.join(serverRoot, "server", "html", "index.html");
  const clientPath = path.join(serverRoot, "server", "js", "client.js");
  const stylePath = path.join(serverRoot, "server", "css", "style.css");

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const fileName = path.basename(filePath);

  const server = http.createServer((req, res) => {
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
        const html = readTemplate(htmlPath, {
          FILE_NAME: fileName,
          FILE_SIZE: String(fileSize),
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
        const payload = JSON.stringify({
          fileName,
          fileSize,
          chunkSize: CHUNK_SIZE,
          bytesPerPixel: BYTES_PER_PIXEL,
        });
        send(res, 200, payload, "application/json; charset=utf-8");
        return;
      }

      if (parsed.pathname === "/api/chunk") {
        const offset = Number(parsed.searchParams.get("offset") || 0);
        const length = Number(parsed.searchParams.get("length") || CHUNK_SIZE);

        if (Number.isNaN(offset) || Number.isNaN(length)) {
          send(res, 400, "Invalid offset or length");
          return;
        }

        const safeOffset = Math.max(0, Math.min(offset, fileSize));
        const safeLength = Math.max(0, Math.min(length, fileSize - safeOffset));

        if (safeLength === 0) {
          send(res, 200, "", "text/plain; charset=utf-8");
          return;
        }

        const stream = fs.createReadStream(filePath, {
          start: safeOffset,
          end: safeOffset + safeLength - 1,
          encoding: "utf8",
        });

        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });

        stream.on("error", (err) => {
          if (verbose) {
            process.stderr.write(`[error] ${err.stack || err.message}\n`);
          }
          res.end("");
        });

        stream.pipe(res);
        return;
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
