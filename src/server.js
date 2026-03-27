/**
 * Web Proxy Server - server.js
 * Auto-hébergé, toutes les requêtes passent par ce backend.
 *
 * Installation : npm install express node-fetch
 * Lancement    : node server.js
 * Accès        : http://localhost:3000
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import http from "http";
import net from "net";
import tls from "tls";
import { URL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function encodeTarget(url) {
  return Buffer.from(url).toString("base64url");
}

function decodeTarget(encoded) {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function decodeTargetLoose(encoded) {
  try {
    const url = decodeTarget(encoded);
    new URL(url);
    return url;
  } catch {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const url = Buffer.from(b64, "base64").toString("utf8");
    new URL(url);
    return url;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

function rewriteUrl(href, baseUrl) {
  if (!href || href.startsWith("data:") || href.startsWith("blob:") || href.startsWith("javascript:") || href.startsWith("#") || href.startsWith("mailto:")) {
    return href;
  }
  try {
    const absolute = new URL(href, baseUrl).toString();
    return "/proxy/" + encodeTarget(absolute);
  } catch {
    return href;
  }
}

function rewriteCss(css, baseUrl) {
  css = css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, href) => {
    const rewritten = rewriteUrl(href.trim(), baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, href) => {
    const rewritten = rewriteUrl(href.trim(), baseUrl);
    return `@import ${quote}${rewritten}${quote}`;
  });
  return css;
}

function rewriteHtml(html, baseUrl) {
  html = html.replace(/<base[^>]+>/gi, "");

  const attrRegex = /(\s(?:src|href|action|data-src|data-href))\s*=\s*(['"])([^'"]*)\2/gi;
  html = html.replace(attrRegex, (match, attr, quote, val) => {
    const rewritten = rewriteUrl(val, baseUrl);
    return `${attr}=${quote}${rewritten}${quote}`;
  });

  html = html.replace(/(\ssrcset)\s*=\s*(['"])([^'"]*)\2/gi, (match, attr, quote, val) => {
    const rewritten = val.replace(/([^\s,]+)(\s+\S+)?/g, (part, url, descriptor) => {
      return rewriteUrl(url, baseUrl) + (descriptor || "");
    });
    return `${attr}=${quote}${rewritten}${quote}`;
  });

  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
    return open + rewriteCss(css, baseUrl) + close;
  });

  html = html.replace(/(\sstyle)\s*=\s*(['"])([\s\S]*?)\2/gi, (match, attr, quote, css) => {
    return `${attr}=${quote}${rewriteCss(css, baseUrl)}${quote}`;
  });

  // Désactiver les ServiceWorkers
const swBlock = `
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
  Object.defineProperty(navigator, 'serviceWorker', { get: () => ({ register: () => Promise.resolve({}), getRegistrations: () => Promise.resolve([]) }) });
}
</script>`;


  const injectedScript = `
<script>
(function() {
  /* ── Encodage base64url côté client ── */
  function enc(url) {
    try {
      var b = encodeURIComponent(url).replace(/%([0-9A-F]{2})/g, function(_, p){ return String.fromCharCode(parseInt(p,16)); });
      return btoa(b).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
    } catch(e) { return null; }
  }
  function dec(input) {
    try {
      var b64 = input.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = atob(b64);
      return decodeURIComponent(Array.prototype.map.call(bin, function(c) {
        return '%' + c.charCodeAt(0).toString(16).padStart(2, '0');
      }).join(''));
    } catch (e) {
      return null;
    }
  }
  function currentTargetUrl() {
    var m = window.location.pathname.match(/^\/proxy\/([^/?#]+)/);
    if (!m) return null;
    return dec(m[1]);
  }
  var pageTarget = currentTargetUrl();
  var resolveBase = pageTarget || window.location.href;

  function proxyUrl(url, base) {
    if (!url) return url;
    if (url.startsWith('/proxy/') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
    try {
      var abs = new URL(url, base || resolveBase).toString();
      if (abs.startsWith(window.location.origin)) return url;
      var e = enc(abs);
      return e ? '/proxy/' + e : url;
    } catch(err) { return url; }
  }

  /* ── XHR ── */
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = proxyUrl(url);
    return _open.apply(this, arguments);
  };

  /* ── fetch ── */
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = proxyUrl(input);
    else if (input instanceof Request) {
      var pu = proxyUrl(input.url);
      if (pu !== input.url) input = new Request(pu, input);
    }
    return _fetch.call(window, input, init);
  };

  /* ── WebSocket ── */
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    try {
      var abs = new URL(url, resolveBase);
      if (abs.origin === window.location.origin && !abs.pathname.startsWith('/proxy/')) {
        return protocols ? new _WS(url, protocols) : new _WS(url);
      }
      abs.protocol = abs.protocol === 'wss:' ? 'https:' : 'http:';
      var e = enc(abs.toString());
      if (e) url = window.location.origin + '/proxy/' + e;
    } catch(err) {}
    return protocols ? new _WS(url, protocols) : new _WS(url);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN       = _WS.OPEN;
  window.WebSocket.CLOSING    = _WS.CLOSING;
  window.WebSocket.CLOSED     = _WS.CLOSED;

  /* ── Clics sur liens ── */
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    var pu = proxyUrl(href);
    if (pu !== href) { e.preventDefault(); window.location.href = pu; }
  }, true);

  /* ── history ── */
  ['pushState','replaceState'].forEach(function(m) {
    var orig = history[m];
    history[m] = function(st, ti, url) {
      if (url) url = proxyUrl(url);
      return orig.call(this, st, ti, url);
    };
  });
})();
</script>`;

  if (html.match(/<head[^>]*>/i)) {
    html = html.replace(/(<head[^>]*>)/i, "$1" + swBlock + injectedScript);
  } else {
    html = swBlock + injectedScript + html;
  }

  return html;
}

// ─── Headers ─────────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
  "host", "content-length",
  "content-encoding",
]);

function filterHeaders(headers) {
  const result = {};
  for (const [k, v] of Object.entries(headers)) {
    const kl = k.toLowerCase();
    if (HOP_BY_HOP.has(kl)) continue;
    if (kl === "accept-encoding") continue;
    result[k] = v;
  }
  result["accept-encoding"] = "gzip, deflate, br";
  return result;
}

// ─── Route principale : /proxy/<encoded> ─────────────────────────────────────

async function proxyToTarget(req, res, targetUrl) {
  try {
    const target = new URL(targetUrl);
    const targetOrigin = target.origin;
    const encodedOrigin = encodeTarget(targetOrigin);
    res.setHeader("set-cookie", `__proxy_origin=${encodedOrigin}; Path=/; HttpOnly; SameSite=Lax`);

    const upstreamHeaders = filterHeaders(req.headers);
    upstreamHeaders["host"] = target.host;

    // Certains backends refusent les POST si Origin/Referer pointent localhost.
    if (typeof upstreamHeaders.origin === "string") {
      try {
        const o = new URL(upstreamHeaders.origin);
        if (o.host === req.headers.host) upstreamHeaders.origin = targetOrigin;
      } catch {
        upstreamHeaders.origin = targetOrigin;
      }
    }
    if (typeof upstreamHeaders.referer === "string") {
      try {
        const r = new URL(upstreamHeaders.referer);
        if (r.host === req.headers.host) upstreamHeaders.referer = targetOrigin + "/";
      } catch {
        upstreamHeaders.referer = targetOrigin + "/";
      }
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "manual",
      body: hasBody ? req : undefined,
    });

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get("location");
      if (location) {
        const absolute = new URL(location, targetUrl).toString();
        return res.redirect(upstream.status, "/proxy/" + encodeTarget(absolute));
      }
    }

    for (const [k, v] of upstream.headers.entries()) {
      const kl = k.toLowerCase();
      if (HOP_BY_HOP.has(kl)) continue;
      if (kl === "set-cookie") {
        const cleaned = v
          .replace(/;\s*secure/gi, "")
          .replace(/;\s*samesite=[^;]*/gi, "")
          .replace(/;\s*domain=[^;]*/gi, "");
        res.append("set-cookie", cleaned);
        continue;
      }
      if (kl === "content-security-policy" || kl === "x-frame-options" || kl === "x-content-type-options") continue;
      res.setHeader(k, v);
    }

    res.status(upstream.status);

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const isHtml = contentType.includes("text/html");
    const isCss  = contentType.includes("text/css");

    if (isHtml) {
      const html = await upstream.text();
      const rewritten = rewriteHtml(html, targetUrl);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.send(rewritten);
    }

    if (isCss) {
      const css = await upstream.text();
      const rewritten = rewriteCss(css, targetUrl);
      res.setHeader("content-type", contentType);
      return res.send(rewritten);
    }

    upstream.body.pipe(res);

  } catch (err) {
    console.error("[PROXY ERROR]", err.message);
    res.status(502).send(`
      <html><body style="font-family:monospace;padding:2rem">
        <h2>502 - Erreur de proxy</h2>
        <p>Impossible de joindre : <code>${targetUrl}</code></p>
        <p><code>${err.message}</code></p>
        <p><a href="/">← Retour</a></p>
      </body></html>
    `);
  }
}

app.all("/proxy/:encoded(*)", async (req, res) => {
  let targetUrl;
  try {
    targetUrl = decodeTargetLoose(req.params.encoded);
  } catch {
    return res.status(400).send("URL invalide.");
  }

  return proxyToTarget(req, res, targetUrl);
});

// Fallback: certains scripts front demandent encore /api/*, /text/*, /images/*
// sur l'origine du proxy; on les rattache au site cible via le Referer proxifie.
app.all("*", async (req, res, next) => {
  if (req.path === "/" || req.path === "/api/navigate" || req.path.startsWith("/proxy/")) {
    return next();
  }

  const referer = req.get("referer");
  let base;

  if (referer) {
    let refererUrl;
    try {
      refererUrl = new URL(referer);
    } catch {
      refererUrl = null;
    }

    if (refererUrl) {
      const m = refererUrl.pathname.match(/^\/proxy\/([^/?#]+)/);
      if (m) {
        try {
          const pageUrl = decodeTargetLoose(m[1]);
          base = new URL(pageUrl).origin;
        } catch {
          base = undefined;
        }
      }
    }
  }

  if (!base) {
    const cookies = parseCookies(req);
    const encodedOrigin = cookies.__proxy_origin;
    if (encodedOrigin) {
      try {
        const origin = decodeTargetLoose(encodedOrigin);
        base = new URL(origin).origin;
      } catch {
        base = undefined;
      }
    }
  }

  if (!base) return next();
  const targetUrl = new URL(req.originalUrl, base).toString();
  return proxyToTarget(req, res, targetUrl);
});

// ─── API navigate ─────────────────────────────────────────────────────────────

app.use(express.json());

app.post("/api/navigate", (req, res) => {
  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "URL manquante" });
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "URL invalide" });
  }
  res.json({ redirect: "/proxy/" + encodeTarget(url) });
});

// ─── Frontend ─────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── Serveur HTTP + WebSocket upgrade ────────────────────────────────────────

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  const match = req.url.match(/^\/proxy\/(.+)$/);
  if (!match) return socket.destroy();

  let targetUrl;
  try {
    targetUrl = decodeTarget(match[1]);
    new URL(targetUrl);
  } catch {
    return socket.destroy();
  }

  // Convertir https/http → wss/ws
  const wsUrl = new URL(targetUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  const isSecure = wsUrl.protocol === "wss:";
  const port = parseInt(wsUrl.port) || (isSecure ? 443 : 80);
  const host = wsUrl.hostname;
  const upgradePath = wsUrl.pathname + wsUrl.search;

  // Reconstruire les headers upstream
  const skipHeaders = new Set(["host", "origin"]);
  const headerLines = Object.entries(req.headers)
    .filter(([k]) => !skipHeaders.has(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");

  const connectAndUpgrade = (targetSocket) => {
    targetSocket.on("connect", () => {
      targetSocket.write(
        `GET ${upgradePath} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `${headerLines}\r\n` +
        `\r\n`
      );
      if (head && head.length) targetSocket.write(head);

      socket.pipe(targetSocket);
      targetSocket.pipe(socket);

      socket.on("error", () => targetSocket.destroy());
      targetSocket.on("error", () => socket.destroy());
      socket.on("close", () => targetSocket.destroy());
      targetSocket.on("close", () => socket.destroy());
    });

    targetSocket.on("error", (err) => {
      console.error("[WS ERROR]", err.message);
      socket.destroy();
    });
  };

  if (isSecure) {
    connectAndUpgrade(tls.connect({ host, port, servername: host }));
  } else {
    connectAndUpgrade(net.connect({ host, port }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🔒 Web Proxy démarré sur http://localhost:${PORT}\n`);
});