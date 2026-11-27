/* Service worker de la version de revue : déchiffre à la volée docs/d/*.bin. */
"use strict";
var BASE = "/revue-plateforme-m";
var enc = new TextEncoder();
var TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", avif: "image/avif", woff2: "font/woff2", woff: "font/woff", otf: "font/otf", ttf: "font/ttf",
  ico: "image/x-icon", map: "application/json", xml: "application/xml; charset=utf-8", webmanifest: "application/manifest+json",
  pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm"
};

self.addEventListener("install", function (e) { e.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

/* Rien en mémoire : le service worker peut être tué à tout moment. */
function ouvrirBase() {
  return new Promise(function (ok, ko) {
    var r = indexedDB.open("revue-plateforme-m", 1);
    r.onupgradeneeded = function () { r.result.createObjectStore("k"); };
    r.onsuccess = function () { ok(r.result); };
    r.onerror = function () { ko(r.error); };
  });
}
async function lireCles() {
  try {
    var db = await ouvrirBase();
    return await new Promise(function (ok) {
      var q = db.transaction("k", "readonly").objectStore("k").get("cles");
      q.onsuccess = function () { db.close(); ok(q.result || null); };
      q.onerror = function () { db.close(); ok(null); };
    });
  } catch (e) { return null; }
}
async function effacerCles() {
  try {
    var db = await ouvrirBase();
    await new Promise(function (ok) {
      var tx = db.transaction("k", "readwrite");
      tx.objectStore("k").delete("cles");
      tx.oncomplete = function () { db.close(); ok(); };
      tx.onerror = function () { db.close(); ok(); };
    });
  } catch (e) { /* ignore */ }
}

function hex(buf) {
  return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
}
async function nomDe(cles, chemin) {
  return hex(await crypto.subtle.sign("HMAC", cles.hmac, enc.encode(chemin))).slice(0, 32);
}
async function lire(cles, chemin) {
  var nom = await nomDe(cles, chemin);
  var r;
  /* Les noms des blocs ne changent pas d'une publication à l'autre (HMAC du
     chemin) : sans revalidation, le cache HTTP de GitHub Pages (10 min) sert
     l'ancienne page même après ⌘⇧R. Seuls les fichiers de /_next/static/,
     dont le chemin porte une empreinte, gardent le cache. 23/11/2026. */
  var fige = chemin.indexOf("/_next/static/") !== -1;
  try { r = await fetch(BASE + "/d/" + nom + ".bin", fige ? undefined : { cache: "no-cache" }); } catch (e) { return null; }
  if (!r.ok) return null;
  var d = new Uint8Array(await r.arrayBuffer());
  try {
    return await crypto.subtle.decrypt({ name: "AES-GCM", iv: d.slice(0, 12) }, cles.aes, d.slice(12));
  } catch (e) { return null; }
}
function typeDe(chemin) {
  var m = /\.([a-z0-9]+)$/i.exec(chemin);
  return (m && TYPES[m[1].toLowerCase()]) || "application/octet-stream";
}

function candidats(pathname) {
  var variantes = [pathname];
  try { var d = decodeURIComponent(pathname); if (d !== pathname) variantes.unshift(d); } catch (e) { /* ignore */ }
  var sortie = [];
  variantes.forEach(function (v) {
    if (v === BASE || v.indexOf(BASE + "/") === 0) v = v.slice(BASE.length);
    v = v.replace(/^\/+/, "").replace(/\/+$/, "");
    if (v === "") { sortie.push("index.html"); return; }
    var m = /\.([a-z0-9]+)$/i.exec(v);
    var connue = m && TYPES[m[1].toLowerCase()] && m[1].toLowerCase() !== "html";
    var liste = connue ? [v, v + ".html", v + "/index.html"] : [v + ".html", v + "/index.html", v];
    liste.forEach(function (c) { if (sortie.indexOf(c) < 0) sortie.push(c); });
  });
  return sortie;
}

function reponseApi() {
  return new Response(JSON.stringify({ ok: false, erreur: "Version de revue : lecture seule" }), {
    status: 503, headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function porte() {
  try {
    var r = await fetch(BASE + "/index.html", { cache: "no-store" });
    return new Response(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": TYPES.html } });
  } catch (e) {
    return new Response("Accès réservé : connexion requise.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function selCourant() {
  try {
    var r = await fetch(BASE + "/porte.json", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()).sel;
  } catch (e) { return null; } /* hors ligne : on garde les clés stockées */
}

async function servir(request) {
  var url = new URL(request.url);
  var navigation = request.mode === "navigate";
  var cles = await lireCles();

  if (navigation) {
    var sel = cles ? await selCourant() : null;
    if (!cles || (sel !== null && sel !== cles.sel)) {
      if (cles) await effacerCles();
      return porte();
    }
  }
  if (!cles) return fetch(request);

  var liste = candidats(url.pathname);
  for (var i = 0; i < liste.length; i++) {
    var clair = await lire(cles, liste[i]);
    if (clair) {
      return new Response(clair, { status: 200, headers: { "Content-Type": typeDe(liste[i]) } });
    }
  }
  if (navigation || (request.headers.get("accept") || "").indexOf("text/html") >= 0) {
    var page = await lire(cles, "404.html");
    if (page) return new Response(page, { status: 404, headers: { "Content-Type": TYPES.html } });
    /* Clés présentes mais aucun bloc lisible (déploiement partiel, cache périmé) :
       on repart de la porte plutôt que de laisser le visiteur dans une impasse. */
    if (navigation) { await effacerCles(); return porte(); }
  }
  return new Response("Introuvable", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  var chemin = url.pathname;
  if (chemin === BASE + "/sw.js" || chemin === BASE + "/porte.json" || chemin === "/sw.js" || chemin === "/porte.json") return;
  var rel = (chemin === BASE || chemin.indexOf(BASE + "/") === 0) ? chemin.slice(BASE.length) : chemin;
  if (rel === "/api" || rel.indexOf("/api/") === 0) { event.respondWith(reponseApi()); return; }
  if (request.method !== "GET" && request.method !== "HEAD") return;
  /* Les blocs chiffrés eux-mêmes et la porte passent tels quels. */
  if (rel.indexOf("/d/") === 0) return;
  event.respondWith(servir(request));
});
