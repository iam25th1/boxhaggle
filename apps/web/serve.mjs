// Zero-dependency static server for the built spectator UI (self-hosted runtime; the
// Railway Dockerfile is the alternate). Serves ./dist (or WEB_DIST), SPA
// fallback to index.html, strict security headers. Binds loopback by default.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(process.env.WEB_DIST ?? "dist");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const MERCHANT_ORIGIN = (() => {
  try {
    return process.env.MERCHANT_ORIGIN ? new URL(process.env.MERCHANT_ORIGIN).origin : "";
  } catch {
    return "";
  }
})();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `connect-src 'self'${MERCHANT_ORIGIN ? ` ${MERCHANT_ORIGIN}` : ""}`,
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=15552000",
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}

function fileFor(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const target = normalize(join(ROOT, decoded));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  try {
    const stat = statSync(target);
    if (stat.isFile()) return target;
    if (stat.isDirectory()) {
      const index = join(target, "index.html");
      if (statSync(index).isFile()) return index;
    }
  } catch {
    // fall through to SPA fallback
  }
  return undefined;
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD" }, "method not allowed");
  const url = req.url ?? "/";
  if (url === "/healthz") return send(res, 200, { "Content-Type": "text/plain" }, "ok");
  let file = fileFor(url);
  if (file === null) return send(res, 400, { "Content-Type": "text/plain" }, "bad request");
  if (file === undefined) {
    if (extname(url.split("?")[0] ?? "")) return send(res, 404, { "Content-Type": "text/plain" }, "not found");
    file = join(ROOT, "index.html");
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    ...SECURITY,
    "Content-Type": type,
    // no-transform stops the CDN rewriting responses, e.g. injecting an analytics script the CSP would block.
    "Cache-Control": immutable ? "public, max-age=31536000, immutable, no-transform" : "no-cache, no-transform",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`web listening on ${HOST}:${PORT}, serving ${ROOT}\n`);
});
