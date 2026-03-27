/**
 * Web Proxy Server - server.js
 * Auto-hébergé, toutes les requêtes passent par ce backend.
 * 
 * Installation : npm install express node-fetch cheerio
 * Lancement    : node server.js
 * Accès        : http://localhost:3000
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Encode une URL cible en base64 pour l'embarquer dans les URLs proxifiées.
 * On utilise base64url (sans +, /, =) pour rester URL-safe.
 */
function encodeTarget(url) {
  return Buffer.from(url).toString("base64url");
}

function decodeTarget(encoded) {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

/**
 * Réécrit une URL absolue ou relative en URL proxy.
 * Format : /proxy/<base64url(absoluteUrl)>
 */
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

/**
 * Réécrit les URLs dans du CSS (url(...), @import, etc.)
 */
function rewriteCss(css, baseUrl) {
  // url("...") ou url('...') ou url(...)
  css = css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, quote, href) => {
    const rewritten = rewriteUrl(href.trim(), baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  });
  // @import "..." ou @import '...'
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, href) => {
    const rewritten = rewriteUrl(href.trim(), baseUrl);
    return `@import ${quote}${rewritten}${quote}`;
  });
  return css;
}

/**
 * Réécrit les URLs dans du HTML via des regex légères
 * (pour éviter une dépendance lourde à cheerio sur les flux binaires).
 */
function rewriteHtml(html, baseUrl) {
  // <base href="..."> → on retire la balise pour ne pas casser nos rewrites
  html = html.replace(/<base[^>]+>/gi, "");

  // Attributs src / href / action / srcset
  const attrRegex = /(\s(?:src|href|action|data-src|data-href))\s*=\s*(['"])([^'"]*)\2/gi;
  html = html.replace(attrRegex, (match, attr, quote, val) => {
    const rewritten = rewriteUrl(val, baseUrl);
    return `${attr}=${quote}${rewritten}${quote}`;
  });

  // srcset="url 1x, url2 2x"
  html = html.replace(/(\ssrcset)\s*=\s*(['"])([^'"]*)\2/gi, (match, attr, quote, val) => {
    const rewritten = val.replace(/([^\s,]+)(\s+\S+)?/g, (part, url, descriptor) => {
      return rewriteUrl(url, baseUrl) + (descriptor || "");
    });
    return `${attr}=${quote}${rewritten}${quote}`;
  });

  // <style>...</style>
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
    return open + rewriteCss(css, baseUrl) + close;
  });

  // style="..." inline
  html = html.replace(/(\sstyle)\s*=\s*(['"])([\s\S]*?)\2/gi, (match, attr, quote, css) => {
    return `${attr}=${quote}${rewriteCss(css, baseUrl)}${quote}`;
  });

  // Injection du script client pour intercepter les navigations dynamiques
  const injectedScript = `
<script>
(function() {
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url && !url.startsWith('/proxy/') && !url.startsWith('/api/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      try {
        var abs = new URL(url, window.location.href).toString();
        if (!abs.startsWith(window.location.origin)) {
          url = '/proxy/' + btoa(abs).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        }
      } catch(e) {}
    }
    return _open.apply(this, arguments);
  };

  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : input.url;
    if (url && !url.startsWith('/proxy/') && !url.startsWith('/api/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      try {
        var abs = new URL(url, window.location.href).toString();
        if (!abs.startsWith(window.location.origin)) {
          var encoded = btoa(abs).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
          if (typeof input === 'string') input = '/proxy/' + encoded;
          else input = new Request('/proxy/' + encoded, input);
        }
      } catch(e) {}
    }
    return _fetch.call(window, input, init);
  };

  // Intercepte les clics pour réécrire les navigations
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('/proxy/')) return;
    try {
      var abs = new URL(href, window.location.href).toString();
      if (!abs.startsWith(window.location.origin)) {
        e.preventDefault();
        var encoded = btoa(abs).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        window.location.href = '/proxy/' + encoded;
      }
    } catch(e2) {}
  }, true);

  // Intercepte history.pushState / replaceState
  ['pushState', 'replaceState'].forEach(function(method) {
    var orig = history[method];
    history[method] = function(state, title, url) {
      if (url && !url.startsWith('/proxy/') && !url.startsWith('/') ) {
        try {
          var abs = new URL(url, window.location.href).toString();
          if (!abs.startsWith(window.location.origin)) {
            var encoded = btoa(abs).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
            url = '/proxy/' + encoded;
          }
        } catch(e) {}
      }
      return orig.call(this, state, title, url);
    };
  });
})();
</script>`;

  // Injecter juste après <head> ou avant </head>
  if (html.match(/<head[^>]*>/i)) {
    html = html.replace(/(<head[^>]*>)/i, "$1" + injectedScript);
  } else {
    html = injectedScript + html;
  }

  return html;
}

// ─── Headers à filtrer (hop-by-hop) ──────────────────────────────────────────


const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
  "host", "content-length",
  "content-encoding",   // ← ajouter cette ligne
]);

function filterHeaders(headers) {
  const result = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      result[k] = v;
    }
  }
  return result;
}

// ─── Route principale : /proxy/<encoded> ─────────────────────────────────────

app.get("/proxy/:encoded(*)", async (req, res) => {
  let targetUrl;
  try {
    targetUrl = decodeTarget(req.params.encoded);
    new URL(targetUrl); // validation
  } catch {
    return res.status(400).send("URL invalide.");
  }

  try {
    const upstreamHeaders = filterHeaders(req.headers);
    upstreamHeaders["host"] = new URL(targetUrl).host;

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "manual",
      // body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
    });

    // Gestion des redirections : on réécrit Location
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get("location");
      if (location) {
        const absolute = new URL(location, targetUrl).toString();
        return res.redirect(upstream.status, "/proxy/" + encodeTarget(absolute));
      }
    }

    // Copie des headers de réponse (sauf hop-by-hop + cookies tiers)
    for (const [k, v] of upstream.headers.entries()) {
      const kl = k.toLowerCase();
      if (HOP_BY_HOP.has(kl)) continue;
      if (kl === "set-cookie") {
        // Transmettre les cookies mais retirer Secure/SameSite pour fonctionner en HTTP local
        const cleaned = v
          .replace(/;\s*secure/gi, "")
          .replace(/;\s*samesite=[^;]*/gi, "");
        res.append("set-cookie", cleaned);
        continue;
      }
      if (kl === "content-security-policy" || kl === "x-frame-options" || kl === "x-content-type-options") continue;
      res.setHeader(k, v);
    }

    res.status(upstream.status);

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const isHtml = contentType.includes("text/html");
    const isCss = contentType.includes("text/css");
    const isJs = contentType.includes("javascript");
    const isText = contentType.includes("text/");

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

    // Pour tout le reste (images, fonts, JS, JSON, binaires...) → stream direct
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
});

// ─── API : /api/proxy (POST JSON) ────────────────────────────────────────────
// Utilisé par le frontend pour initier la navigation

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

// ─── Interface HTML principale ────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── Lancement ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🔒 Web Proxy démarré sur http://localhost:${PORT}\n`);
});
