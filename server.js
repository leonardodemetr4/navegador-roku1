const express = require("express");
const { chromium } = require("playwright");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.urlencoded({ extended: false, limit: "5mb" }));
app.use(express.json({ limit: "1mb" }));
const PORT = process.env.PORT || 10000;

const IPTV_M3U_URL = process.env.IPTV_M3U_URL || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const sessions = new Map();
let browser = null;

let iptvCache = "";
let iptvCacheTime = 0;
const IPTV_CACHE_MS = 5 * 60 * 1000;
const ELIN_PROXY_SECRET = crypto.randomBytes(32);

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
  }
  return browser;
}

function validSession(id) {
  return /^[A-Za-z0-9_-]{1,60}$/.test(id || "");
}

function validUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clean(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function createSession(id) {
  const old = sessions.get(id);

  if (old) {
    try {
      await old.context.close();
    } catch {}
    sessions.delete(id);
  }

  const b = await getBrowser();

  const context = await b.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "pt-BR",
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(35000);

  const session = { context, page, last: Date.now() };
  sessions.set(id, session);

  return session;
}

function getSession(id) {
  if (!validSession(id)) return null;

  const session = sessions.get(id);
  if (!session) return null;

  session.last = Date.now();
  return session;
}

async function waitVisual(page, maxWait = 3000) {
  try {
    await page.evaluate(() => {
      for (const img of Array.from(document.images || [])) {
        try {
          img.loading = "eager";
        } catch {}
      }
    });
  } catch {}

  const end = Date.now() + maxWait;

  while (Date.now() < end) {
    try {
      const pending = await page.evaluate(() => {
        return Array.from(document.images || []).filter(img => {
          return img.src && !img.complete;
        }).length;
      });

      if (pending === 0) break;
    } catch {
      break;
    }

    await page.waitForTimeout(250);
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: 1200 });
  } catch {}

  await page.waitForTimeout(250);
}

async function shot(page, res) {
  const png = await page.screenshot({
    type: "png",
    fullPage: false,
    animations: "disabled"
  });

  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });

  return res.status(200).type("png").send(png);
}

async function openUrl(page, raw) {
  const url = validUrl(raw);
  if (!url) return false;

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 35000
    });

    await waitVisual(page, 5000);
    return true;
  } catch (error) {
    console.log("Falha ao abrir:", error.message);

    try {
      return await page.evaluate(() => {
        if (!document.body) return false;

        return (
          (document.body.innerText || "").trim().length > 10 ||
          document.images.length > 0
        );
      });
    } catch {
      return false;
    }
  }
}

async function searchRss(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const url =
      "https://www.bing.com/search?format=rss&setlang=pt-BR&q=" +
      encodeURIComponent(query);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/131 Safari/537.36",
        "Accept": "application/rss+xml,text/xml,*/*"
      }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const xml = await response.text();
    const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    const results = [];

    for (const item of blocks.slice(0, 12)) {
      const title = item.match(/<title>([\s\S]*?)<\/title>/i);
      const link = item.match(/<link>([\s\S]*?)<\/link>/i);
      const description = item.match(/<description>([\s\S]*?)<\/description>/i);

      if (!title || !link) continue;

      const finalLink = clean(link[1]);
      if (!validUrl(finalLink)) continue;

      results.push({
        title: clean(title[1]),
        link: finalLink,
        description: description ? clean(description[1]) : "",
        thumb: ""
      });
    }

    return results;
  } finally {
    clearTimeout(timer);
  }
}

async function youtubeSearch(query) {
  if (YOUTUBE_API_KEY) {
    try {
      const url =
        "https://www.googleapis.com/youtube/v3/search" +
        "?part=snippet&type=video&maxResults=10&safeSearch=moderate&q=" +
        encodeURIComponent(query) +
        "&key=" +
        encodeURIComponent(YOUTUBE_API_KEY);

      const response = await fetch(url);

      if (response.ok) {
        const data = await response.json();

        const results = (data.items || [])
          .map(item => {
            const id =
              item.id && item.id.videoId
                ? item.id.videoId
                : "";

            const snippet = item.snippet || {};
            const thumbs = snippet.thumbnails || {};

            return {
              title: snippet.title || "Video do YouTube",
              link: id
                ? "https://www.youtube.com/watch?v=" + id
                : "",
              description: snippet.channelTitle || "YouTube",
              thumb:
                (thumbs.high && thumbs.high.url) ||
                (thumbs.medium && thumbs.medium.url) ||
                (thumbs.default && thumbs.default.url) ||
                ""
            };
          })
          .filter(item => item.link);

        if (results.length > 0) return results;
      }
    } catch (error) {
      console.log("YouTube API:", error.message);
    }
  }

  try {
    return (await searchRss("site:youtube.com/watch " + query)).slice(0, 10);
  } catch {
    return [];
  }
}

function resultsHtml(title, query, items) {
  const cards =
    items.length === 0
      ? `<div class="empty">Nenhum resultado encontrado.</div>`
      : items
          .map((item, index) => {
            const visual = item.thumb
              ? `<img src="${esc(item.thumb)}">`
              : `<div class="num">${index + 1}</div>`;

            return `
<a class="card" href="${esc(item.link)}">
${visual}
<div class="body">
<div class="title">${esc(item.title)}</div>
<div class="url">${esc(item.link)}</div>
<div class="desc">${esc(item.description)}</div>
</div>
</a>`;
          })
          .join("");

  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box}
body{margin:0;padding:24px 34px 60px;background:#f4f6f7;font-family:Arial;color:#1f343d}
.head,.card,.empty{background:white;border:2px solid #e0e5e8;border-radius:14px}
.head{padding:22px 26px;margin-bottom:18px}
.head h1{margin:0 0 5px;font-size:31px}
.head p{margin:0;font-size:21px;color:#606f76}
.card{display:flex;gap:18px;text-decoration:none;color:#1f343d;padding:16px;margin-bottom:14px}
.card img{width:210px;height:118px;object-fit:cover;border-radius:10px}
.num{min-width:48px;height:48px;line-height:48px;text-align:center;background:#e9f4f7;border-radius:12px;font-size:22px;font-weight:bold}
.title{font-size:24px;font-weight:bold;margin-bottom:5px}
.url{font-size:15px;color:#16819a;margin-bottom:7px}
.desc{font-size:18px;color:#52636b}
.empty{padding:30px;font-size:24px}
</style>
</head>
<body>
<div class="head">
<h1>${esc(title)}</h1>
<p>${esc(query)}</p>
</div>
${cards}
</body>
</html>`;
}

function cleanM3u(text) {
  if (!text) return "";

  const lines = String(text).replace(/\r/g, "").split("\n");
  const output = ["#EXTM3U"];

  let info = "";
  let count = 0;

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      info = line;
      continue;
    }

    if (info && !line.startsWith("#")) {
      output.push(info);
      output.push(line);

      info = "";
      count++;

      if (count >= 2500) break;
    }
  }

  if (count === 0) return "";

  console.log("IPTV itens preparados:", count);
  return output.join("\n") + "\n";
}

function requestText(rawUrl, timeoutMs = 25000, redirects = 0, userAgent = "") {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Muitos redirecionamentos"));
      return;
    }

    let parsed;

    try {
      parsed = new URL(rawUrl);
    } catch {
      reject(new Error("URL IPTV invalida"));
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent":
          userAgent ||
          "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 " +
          "Chrome/131.0.0.0 Safari/537.36",
        "Accept":
          "application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Connection": "close"
      },
      rejectUnauthorized: false
    };

    const req = client.request(options, res => {
      const status = res.statusCode || 0;

      if (
        status >= 300 &&
        status < 400 &&
        res.headers.location
      ) {
        const nextUrl =
          new URL(res.headers.location, rawUrl).toString();

        res.resume();

        requestText(
          nextUrl,
          timeoutMs,
          redirects + 1,
          userAgent
        )
          .then(resolve)
          .catch(reject);

        return;
      }

      const chunks = [];

      res.on("data", chunk => {
        chunks.push(chunk);
      });

      res.on("end", () => {
        const body =
          Buffer.concat(chunks).toString("utf8");

        resolve({
          status,
          body,
          contentType:
            String(
              res.headers["content-type"] || ""
            )
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error("Timeout ao conectar ao servidor IPTV")
      );
    });

    req.on("error", reject);
    req.end();
  });
}

function httpsVariant(rawUrl) {
  try {
    const u = new URL(rawUrl);

    if (
      u.protocol === "http:" &&
      u.port === "443"
    ) {
      u.protocol = "https:";
      return u.toString();
    }
  } catch {}

  return "";
}

async function fetchIptvCandidate(url, label, userAgent = "") {
  console.log("IPTV tentativa:", label);

  const result =
    await requestText(url, 25000, 0, userAgent);

  console.log(
    "IPTV",
    label,
    "HTTP",
    result.status,
    "bytes",
    result.body.length
  );

  if (
    result.status < 200 ||
    result.status >= 300
  ) {
    throw new Error(
      label +
      " respondeu HTTP " +
      result.status
    );
  }

  if (
    !result.body ||
    (
      !result.body.includes("#EXTM3U") &&
      !result.body.includes("#EXTINF")
    )
  ) {
    throw new Error(
      label +
      " nao retornou uma lista M3U"
    );
  }

  return result.body;
}


function sanitizeDiagnosticPreview(text) {
  let value = String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  value = value
    .replace(/([?&](?:username|user|password|pass)=)[^&\s"']+/gi, "$1***")
    .replace(/(https?:\/\/[^\/\s]+\/(?:live|movie|series)\/)[^\/\s]+\/[^\/\s]+/gi, "$1***/***");

  return value.slice(0, 220);
}

async function probeIptvUrl(url, label, userAgent = "") {
  const startedAt = Date.now();

  try {
    const result = await requestText(url, 25000, 0, userAgent);
    const body = String(result.body || "");
    const trimmed = body.trim();

    const info = {
      label,
      okHttp: result.status >= 200 && result.status < 300,
      status: result.status,
      contentType: result.contentType || "",
      bytes: Buffer.byteLength(body, "utf8"),
      startsWithExtm3u: trimmed.startsWith("#EXTM3U"),
      hasExtm3u: body.includes("#EXTM3U"),
      hasExtinf: body.includes("#EXTINF"),
      looksLikeHtml: /<html|<!doctype/i.test(body),
      elapsedMs: Date.now() - startedAt,
      preview: sanitizeDiagnosticPreview(body)
    };

    console.log(
      "IPTV DIAGNOSTICO",
      label,
      "HTTP",
      info.status,
      "type",
      info.contentType,
      "bytes",
      info.bytes,
      "extm3u",
      info.hasExtm3u,
      "extinf",
      info.hasExtinf,
      "html",
      info.looksLikeHtml,
      "ms",
      info.elapsedMs
    );

    return info;
  } catch (error) {
    const info = {
      label,
      okHttp: false,
      status: 0,
      contentType: "",
      bytes: 0,
      startsWithExtm3u: false,
      hasExtm3u: false,
      hasExtinf: false,
      looksLikeHtml: false,
      elapsedMs: Date.now() - startedAt,
      error: error.message
    };

    console.log(
      "IPTV DIAGNOSTICO",
      label,
      "ERRO",
      error.message
    );

    return info;
  }
}

async function downloadIptv() {
  if (!IPTV_M3U_URL) {
    throw new Error(
      "IPTV_M3U_URL nao configurada"
    );
  }

  if (
    iptvCache &&
    Date.now() - iptvCacheTime < IPTV_CACHE_MS
  ) {
    console.log("IPTV usando cache");
    return iptvCache;
  }

  let rawText = "";
  let firstError = "";

  try {
    rawText =
      await fetchIptvCandidate(
        IPTV_M3U_URL,
        "URL original"
      );
  } catch (error) {
    firstError = error.message;
    console.log(
      "IPTV URL original falhou:",
      firstError
    );
  }

  if (!rawText) {
    try {
      rawText =
        await fetchIptvCandidate(
          IPTV_M3U_URL,
          "URL original VLC",
          "VLC/3.0.20 LibVLC/3.0.20"
        );
    } catch (error) {
      console.log(
        "IPTV segunda tentativa HTTP falhou:",
        error.message
      );

      throw new Error(
        firstError +
        " | " +
        error.message
      );
    }
  }

  if (!rawText) {
    throw new Error(
      firstError ||
      "Nao foi possivel obter a lista IPTV"
    );
  }

  const cleaned =
    cleanM3u(rawText);

  if (!cleaned) {
    throw new Error(
      "Nenhum item valido encontrado na lista"
    );
  }

  iptvCache = cleaned;
  iptvCacheTime = Date.now();

  return cleaned;
}

app.get("/", (req, res) => {
  res.send(
    "<h1>Navegador Roku V6.3 + IPTV</h1>" +
    "<p>Servidor online</p>" +
    "<p>IPTV: /iptv/m3u</p>"
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "roku-v6.3-iptv",
    iptvConfigured: Boolean(IPTV_M3U_URL),
    sessions: sessions.size
  });
});

app.get("/iptv/status", async (req, res) => {
  const result = {
    ok: false,
    configured: Boolean(IPTV_M3U_URL),
    cached: Boolean(iptvCache),
    cacheAgeSeconds:
      iptvCacheTime > 0
        ? Math.round((Date.now() - iptvCacheTime) / 1000)
        : null
  };

  if (!IPTV_M3U_URL) {
    result.error = "IPTV_M3U_URL nao configurada";
    return res.status(500).json(result);
  }

  try {
    const m3u = await downloadIptv();
    const itemCount =
      (m3u.match(/#EXTINF/g) || []).length;

    result.ok = true;
    result.items = itemCount;

    return res.json(result);
  } catch (error) {
    result.error = error.message;
    return res.status(502).json(result);
  }
});

app.get("/iptv/m3u", async (req, res) => {
  try {
    const m3u = await downloadIptv();

    res.set({
      "Content-Type":
        "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control":
        "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });

    return res.status(200).send(m3u);
  } catch (error) {
    console.error("IPTV ERRO:", error.message);

    if (error.name === "AbortError") {
      return res
        .status(504)
        .type("text/plain")
        .send("Timeout ao conectar ao servidor IPTV");
    }

    return res
      .status(502)
      .type("text/plain")
      .send("Erro IPTV: " + error.message);
  }
});


// -----------------------------------------------------------------------------
// IPTV - cadastro pelo celular / pareamento com Roku
// -----------------------------------------------------------------------------

const DEVICE_CONFIG_FILE =
  process.env.DEVICE_CONFIG_FILE ||
  path.join(process.cwd(), "device-configs.json");

const deviceConfigs = new Map();
const deviceM3uCache = new Map();
const DEVICE_CACHE_MS = 5 * 60 * 1000;

function loadDeviceConfigs() {
  try {
    if (!fs.existsSync(DEVICE_CONFIG_FILE)) return;

    const raw = fs.readFileSync(
      DEVICE_CONFIG_FILE,
      "utf8"
    );

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    for (const code of Object.keys(parsed)) {
      if (
        parsed[code] &&
        typeof parsed[code] === "object"
      ) {
        deviceConfigs.set(code, parsed[code]);
      }
    }

    console.log(
      "IPTV dispositivos carregados:",
      deviceConfigs.size
    );
  } catch (error) {
    console.error(
      "Falha ao carregar device-configs.json:",
      error.message
    );
  }
}

function saveDeviceConfigs() {
  try {
    const obj = {};

    for (const [code, cfg] of deviceConfigs) {
      obj[code] = cfg;
    }

    fs.writeFileSync(
      DEVICE_CONFIG_FILE,
      JSON.stringify(obj, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Falha ao salvar device-configs.json:",
      error.message
    );
  }
}

function normalizeDeviceCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
}

function validDeviceCode(code) {
  return /^[A-Z0-9]{6,10}$/.test(code);
}

function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  try {
    const u = new URL(raw);

    if (
      u.protocol !== "http:" &&
      u.protocol !== "https:"
    ) {
      return "";
    }

    return u.toString();
  } catch {
    return "";
  }
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildXtreamM3u(server, username, password) {
  const base = normalizeHttpUrl(server);

  if (!base || !username || !password) {
    return "";
  }

  const u = new URL(base);

  u.pathname =
    u.pathname.replace(/\/+$/, "") +
    "/get.php";

  u.search = "";

  u.searchParams.set(
    "username",
    String(username)
  );

  u.searchParams.set(
    "password",
    String(password)
  );

  u.searchParams.set(
    "type",
    "m3u_plus"
  );

  u.searchParams.set(
    "output",
    "ts"
  );

  return u.toString();
}

function buildXtreamApiUrl(server, username, password, action = "") {
  const base = normalizeHttpUrl(server);
  if (!base || !username || !password) return "";

  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/+$/, "") + "/player_api.php";
  u.search = "";
  u.searchParams.set("username", String(username));
  u.searchParams.set("password", String(password));
  if (action) u.searchParams.set("action", action);
  return u.toString();
}

function buildXtreamGetUrl(server, username, password, output = "ts") {
  const base = normalizeHttpUrl(server);
  if (!base || !username || !password) return "";

  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/+$/, "") + "/get.php";
  u.search = "";
  u.searchParams.set("username", String(username));
  u.searchParams.set("password", String(password));
  u.searchParams.set("type", "m3u_plus");
  u.searchParams.set("output", output);
  return u.toString();
}

async function fetchXtreamJson(url, label) {
  const result = await requestText(url, 25000, 0, "VLC/3.0.20 LibVLC/3.0.20");

  console.log(
    "XTREAM",
    label,
    "HTTP",
    result.status,
    "bytes",
    result.body.length,
    "content-type",
    result.contentType
  );

  if (result.status < 200 || result.status >= 300) {
    throw new Error(label + " respondeu HTTP " + result.status);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new Error(label + " nao retornou JSON valido");
  }

  return parsed;
}

async function validateXtreamConfig(cfg) {
  if (!cfg || !cfg.server || !cfg.username || !cfg.password) {
    throw new Error("Dados Xtream incompletos");
  }

  const url = buildXtreamApiUrl(
    cfg.server,
    cfg.username,
    cfg.password
  );

  const data = await fetchXtreamJson(url, "player_api");

  const auth = data && data.user_info ? data.user_info : {};
  const authValue = String(auth.auth == null ? "" : auth.auth);
  const status = String(auth.status || "");

  const active =
    authValue === "1" ||
    status.toLowerCase() === "active";

  if (!active) {
    throw new Error(
      "Conta Xtream nao autenticada" +
      (status ? " (" + status + ")" : "")
    );
  }

  return {
    active: true,
    status: status || "Active",
    expDate: auth.exp_date || null,
    maxConnections: auth.max_connections || null,
    activeConnections: auth.active_cons || null,
    serverInfo: data.server_info || {}
  };
}

function m3uAttr(value) {
  return String(value == null ? "" : value)
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function m3uName(value) {
  return String(value == null ? "" : value)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

async function buildXtreamM3uFromApi(cfg) {
  const base = normalizeHttpUrl(cfg.server);
  if (!base) throw new Error("Servidor Xtream invalido");

  const baseUrl = new URL(base);
  const origin =
    baseUrl.protocol + "//" +
    baseUrl.hostname +
    (baseUrl.port ? ":" + baseUrl.port : "");

  const user = encodeURIComponent(cfg.username);
  const pass = encodeURIComponent(cfg.password);

  const liveUrl = buildXtreamApiUrl(
    cfg.server, cfg.username, cfg.password, "get_live_streams"
  );
  const vodUrl = buildXtreamApiUrl(
    cfg.server, cfg.username, cfg.password, "get_vod_streams"
  );

  let live = [];
  let vod = [];

  try {
    const v = await fetchXtreamJson(liveUrl, "get_live_streams");
    if (Array.isArray(v)) live = v;
  } catch (e) {
    console.log("XTREAM live falhou:", e.message);
  }

  try {
    const v = await fetchXtreamJson(vodUrl, "get_vod_streams");
    if (Array.isArray(v)) vod = v;
  } catch (e) {
    console.log("XTREAM vod falhou:", e.message);
  }

  if (!live.length && !vod.length) {
    throw new Error("API Xtream autenticou, mas nao retornou canais ou filmes");
  }

  const lines = ["#EXTM3U"];
  const maxItems = 2500;
  let count = 0;

  for (const item of live) {
    if (count >= maxItems) break;
    const id = item && item.stream_id;
    if (!id) continue;

    const name = m3uName(item.name || ("Canal " + id));
    const logo = m3uAttr(item.stream_icon || "");
    const group = m3uAttr(item.category_name || "TV ao vivo");

    lines.push(
      '#EXTINF:-1 tvg-logo="' + logo + '" group-title="' + group + '",' + name
    );
    lines.push(
      origin + "/live/" + user + "/" + pass + "/" + id + ".ts"
    );
    count++;
  }

  for (const item of vod) {
    if (count >= maxItems) break;
    const id = item && item.stream_id;
    if (!id) continue;

    const ext = String(item.container_extension || "mp4").replace(/[^a-zA-Z0-9]/g, "") || "mp4";
    const name = m3uName(item.name || ("Filme " + id));
    const logo = m3uAttr(item.stream_icon || "");
    const group = m3uAttr(item.category_name || "Filmes");

    lines.push(
      '#EXTINF:-1 tvg-logo="' + logo + '" group-title="' + group + '",' + name
    );
    lines.push(
      origin + "/movie/" + user + "/" + pass + "/" + id + "." + ext
    );
    count++;
  }

  if (count === 0) {
    throw new Error("API Xtream nao possui itens reproduziveis");
  }

  console.log("XTREAM M3U sintetizada:", count, "itens");
  return lines.join("\n") + "\n";
}

function setupPage(message = "", codeValue = "", m3uValue = "", rawValue = "") {
  const safeMessage = htmlEscape(message);
  const safeCode = htmlEscape(codeValue);
  const safeM3u = htmlEscape(m3uValue);
  const safeRaw = htmlEscape(rawValue);

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ELIN PLAY - M3U Universal</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:Arial,Helvetica,sans-serif;background:radial-gradient(circle at 15% 5%,#173a66 0,#08182c 35%,#040b16 100%);color:#eef9ff}
.wrap{width:min(760px,94%);margin:0 auto;padding:28px 0 60px}
.brand{text-align:center;font-size:34px;font-weight:800;letter-spacing:2px;margin-bottom:8px}
.sub{text-align:center;color:#9bcfe8;margin-bottom:24px}
.card{background:rgba(7,24,43,.95);border:1px solid #1f577c;border-radius:16px;padding:22px;box-shadow:0 18px 60px rgba(0,0,0,.35)}
.notice{margin:0 0 18px;padding:13px 15px;border-radius:10px;background:#0d3049;border:1px solid #1db9de;color:#d9f9ff}
label{display:block;font-weight:700;margin:16px 0 7px}
input,textarea{width:100%;border:1px solid #2c5973;background:#071827;color:white;border-radius:10px;padding:14px 13px;font-size:16px;outline:none}
textarea{min-height:150px;resize:vertical;font-family:monospace;font-size:13px}
input:focus,textarea:focus{border-color:#32d5ff;box-shadow:0 0 0 2px rgba(50,213,255,.15)}
.or{text-align:center;color:#6f8ea3;font-weight:700;margin:15px 0 0}
button.save{width:100%;margin-top:22px;padding:15px;border:0;border-radius:11px;background:#0bb6df;color:#03131e;font-size:17px;font-weight:800;cursor:pointer}
.hint{color:#9ab9c9;line-height:1.5;font-size:14px;margin-top:18px}
.delete{margin-top:16px;text-align:center}.delete button{border:1px solid #80505c;background:transparent;color:#ffb3c3;padding:10px 16px;border-radius:9px}
@media(max-width:650px){.wrap{padding-top:18px}.card{padding:18px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">ELIN PLAY</div>
  <div class="sub">M3U Universal • v15 Roku Fast</div>

  <div class="card">
    ${safeMessage ? `<div class="notice">${safeMessage}</div>` : ""}

    <form method="POST" action="/setup/save" enctype="application/x-www-form-urlencoded" id="setupForm">
      <label>Codigo exibido na TV</label>
      <input name="code" maxlength="10" autocomplete="off" required value="${safeCode}" placeholder="Ex.: ABCD2345" style="text-transform:uppercase">

      <label>URL M3U completa</label>
      <input name="m3u" type="url" autocomplete="off" value="${safeM3u}" placeholder="http://servidor/get.php?...">

      <div class="or">OU</div>

      <label>Conteudo M3U (opcional)</label>
      <textarea name="m3utext" placeholder="#EXTM3U&#10;#EXTINF:-1,Canal...&#10;http://...">${safeRaw}</textarea>

      <button class="save" type="submit">Salvar e enviar para a TV</button>
    </form>

    <div class="hint">
      Normalmente use apenas a URL. Se um provedor bloquear o acesso do servidor, voce tambem pode colar o conteudo de uma M3U que voce possui autorizacao para usar.
      O app nao depende de um provedor especifico.
    </div>

    <form class="delete" method="post" action="/setup/delete">
      <input type="hidden" name="code" id="deleteCode" value="${safeCode}">
      <button type="submit">Apagar configuracao deste codigo</button>
    </form>
  </div>
</div>

<script>
const code = document.querySelector('input[name="code"]');
const deleteCode = document.getElementById("deleteCode");
code.addEventListener("input", () => {
  code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  deleteCode.value = code.value;
});
const setupForm = document.getElementById("setupForm");
const saveButton = setupForm.querySelector('button[type="submit"]');
setupForm.addEventListener("submit", () => {
  saveButton.disabled = true;
  saveButton.textContent = "Salvando...";
});
</script>
</body>
</html>`;
}

loadDeviceConfigs();

app.get("/setup", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const code = normalizeDeviceCode(req.query.code);
  const saved = String(req.query.saved || "") === "1";
  const deleted = String(req.query.deleted || "") === "1";
  const methodError = String(req.query.method || "") === "1";

  let message = "";

  if (saved) {
    message =
      "M3U salva. Volte para a TV; o app vai detectar e carregar a lista.";
  } else if (deleted) {
    message =
      "Configuracao apagada.";
  } else if (methodError) {
    message =
      "Use o botao Salvar e enviar para a TV para cadastrar a M3U.";
  }

  return res
    .status(200)
    .type("html")
    .send(
      setupPage(message, code)
    );
});

app.get("/setup/save", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  return res.redirect(303, "/setup?method=1");
});

app.post("/setup/save/", (req, res, next) => {
  req.url = "/setup/save";
  next();
});

app.post("/setup/save", (req, res) => {
  res.set("Cache-Control", "no-store");

  const code = normalizeDeviceCode(req.body.code);

  if (!validDeviceCode(code)) {
    return res.status(400).type("html").send(
      setupPage(
        "Codigo invalido. Digite exatamente o codigo mostrado na TV.",
        code,
        String(req.body.m3u || ""),
        String(req.body.m3utext || "")
      )
    );
  }

  const rawInput = String(req.body.m3utext || "").trim();
  const rawM3u =
    rawInput &&
    (rawInput.includes("#EXTM3U") || rawInput.includes("#EXTINF"))
      ? rawInput
      : "";

  const m3uUrl = normalizeHttpUrl(req.body.m3u);

  if (!m3uUrl && !rawM3u) {
    return res.status(400).type("html").send(
      setupPage(
        "Informe uma URL M3U valida ou cole um conteudo M3U valido.",
        code,
        String(req.body.m3u || ""),
        String(req.body.m3utext || "")
      )
    );
  }

  if (rawInput && !rawM3u) {
    return res.status(400).type("html").send(
      setupPage(
        "O conteudo colado nao parece uma M3U valida.",
        code,
        String(req.body.m3u || ""),
        String(req.body.m3utext || "")
      )
    );
  }

  if (rawM3u && Buffer.byteLength(rawM3u, "utf8") > 4 * 1024 * 1024) {
    return res.status(413).type("html").send(
      setupPage(
        "A M3U colada e muito grande. Limite: 4 MB.",
        code,
        String(req.body.m3u || ""),
        ""
      )
    );
  }

  deviceConfigs.set(code, {
    name: "Minha IPTV",
    mode: rawM3u ? "m3u-text" : "m3u-url",
    m3uUrl: m3uUrl || "",
    m3uText: rawM3u || "",
    epgUrl: "",
    updatedAt: new Date().toISOString()
  });

  deviceM3uCache.delete(code);
  saveDeviceConfigs();

  return res.redirect(
    "/setup?code=" + encodeURIComponent(code) + "&saved=1"
  );
});

app.post("/setup/delete", (req, res) => {
  const code =
    normalizeDeviceCode(req.body.code);

  if (validDeviceCode(code)) {
    deviceConfigs.delete(code);
    deviceM3uCache.delete(code);
    saveDeviceConfigs();
  }

  return res.redirect(
    "/setup?code=" +
    encodeURIComponent(code) +
    "&deleted=1"
  );
});

app.get("/api/device/:code", (req, res) => {
  const code =
    normalizeDeviceCode(req.params.code);

  if (!validDeviceCode(code)) {
    return res.status(400).json({
      ok: false,
      configured: false,
      error: "Codigo invalido"
    });
  }

  const cfg =
    deviceConfigs.get(code);

  if (!cfg) {
    return res.json({
      ok: true,
      configured: false,
      code
    });
  }

  return res.json({
    ok: true,
    configured: true,
    code,
    name: cfg.name || "Minha IPTV",
    mode: cfg.mode || "m3u",
    epgConfigured:
      Boolean(cfg.epgUrl),
    updatedAt:
      cfg.updatedAt || null,
    sourceUrl: cfg.m3uUrl || ""
  });
});

async function downloadDeviceM3u(code) {
  const cfg = deviceConfigs.get(code);

  if (!cfg) {
    throw new Error("Nenhuma lista cadastrada para este dispositivo");
  }

  if (!cfg.m3uUrl) {
    throw new Error("Este dispositivo nao possui uma URL M3U cadastrada");
  }

  const cached = deviceM3uCache.get(code);

  if (
    cached &&
    Date.now() - cached.time < DEVICE_CACHE_MS
  ) {
    return cached.text;
  }

  const errors = [];
  let rawText = "";

  try {
    rawText = await fetchIptvCandidate(
      cfg.m3uUrl,
      "Dispositivo " + code
    );
  } catch (error) {
    errors.push(error.message);
  }

  if (!rawText) {
    try {
      rawText = await fetchIptvCandidate(
        cfg.m3uUrl,
        "Dispositivo " + code + " VLC",
        "VLC/3.0.20 LibVLC/3.0.20"
      );
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!rawText) {
    throw new Error(
      errors.filter(Boolean).join(" | ") ||
      "Nao foi possivel obter a lista M3U"
    );
  }

  const cleaned = cleanM3u(rawText);

  if (!cleaned) {
    throw new Error(
      "A URL respondeu, mas nao retornou itens M3U validos"
    );
  }

  deviceM3uCache.set(code, {
    time: Date.now(),
    text: cleaned
  });

  return cleaned;
}


app.get("/iptv/device/:code/xtream-status", (req, res) => {
  const code = normalizeDeviceCode(req.params.code);
  const cfg = deviceConfigs.get(code);

  return res.json({
    ok: Boolean(cfg && cfg.m3uUrl),
    configured: Boolean(cfg),
    mode: "m3u-direct",
    message:
      cfg && cfg.m3uUrl
        ? "Este dispositivo usa M3U direta. Xtream/player_api nao e necessario."
        : "Nenhuma M3U cadastrada para este dispositivo."
  });
});





function encodeProxyTarget(value) {
  return Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeProxyTarget(value) {
  try {
    let raw = String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    while (raw.length % 4) raw += "=";
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function signProxyTarget(code, targetUrl) {
  return crypto
    .createHmac("sha256", ELIN_PROXY_SECRET)
    .update(String(code) + "\n" + String(targetUrl))
    .digest("hex");
}

function validProxySignature(code, targetUrl, signature) {
  if (!signature) return false;

  const expected = signProxyTarget(code, targetUrl);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");

  if (a.length !== b.length) return false;

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function makeProxyUrl(publicBase, code, targetUrl) {
  const token = encodeProxyTarget(targetUrl);
  const sig = signProxyTarget(code, targetUrl);

  return (
    publicBase +
    "/iptv/device/" +
    encodeURIComponent(code) +
    "/stream?u=" +
    encodeURIComponent(token) +
    "&sig=" +
    encodeURIComponent(sig)
  );
}

function rewriteM3uForProxy(text, code, publicBase, sourceUrl) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  let count = 0;

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;

    if (line.startsWith("#")) {
      out.push(line);
      continue;
    }

    try {
      const absolute = new URL(line, sourceUrl).toString();
      out.push(makeProxyUrl(publicBase, code, absolute));
      count++;
    } catch {
      out.push(line);
    }
  }

  if (count === 0) return "";

  console.log("IPTV UNIVERSAL playlist reescrita:", code, count, "URLs");
  return out.join("\n") + "\n";
}

function publicBaseFromRequest(req) {
  const proto =
    String(req.headers["x-forwarded-proto"] || req.protocol || "https")
      .split(",")[0]
      .trim();

  const host =
    String(req.headers["x-forwarded-host"] || req.get("host") || "")
      .split(",")[0]
      .trim();

  return proto + "://" + host;
}

function streamM3uIncremental(rawUrl, userAgent = "", options = {}, redirects = 0) {
  const idleMs = Number(options.idleMs || 10000);
  const totalMs = Number(options.totalMs || 45000);
  const maxItems = Number(options.maxItems || 5000);

  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Muitos redirecionamentos"));
      return;
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("protocolo invalido");
      }
    } catch {
      reject(new Error("URL IPTV invalida"));
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const headers = {
      "User-Agent": userAgent || "VLC/3.0.20 LibVLC/3.0.20",
      "Accept": "application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Accept-Encoding": "identity",
      "Connection": "close"
    };

    let settled = false;
    let requestRef = null;
    let responseRef = null;
    let idleTimer = null;
    let totalTimer = null;
    let status = 0;
    let contentType = "";
    let receivedBytes = 0;
    let preview = "";
    let remainder = "";
    let pendingInfo = "";
    const output = ["#EXTM3U"];
    let itemCount = 0;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = null;
      totalTimer = null;
    };

    const finalize = (reason = "fim") => {
      if (settled) return;
      settled = true;
      cleanup();

      if (responseRef) {
        try { responseRef.destroy(); } catch {}
      }
      if (requestRef) {
        try { requestRef.destroy(); } catch {}
      }

      if (itemCount > 0) {
        resolve({
          ok: true,
          status,
          contentType,
          text: output.join("\n") + "\n",
          items: itemCount,
          bytes: receivedBytes,
          partial: reason !== "fim",
          reason
        });
        return;
      }

      const safePreview = sanitizeDiagnosticPreview(preview);
      const detail = [
        "HTTP " + status,
        contentType ? "tipo " + contentType : "",
        receivedBytes ? "bytes " + receivedBytes : "",
        safePreview ? "resposta: " + safePreview : ""
      ].filter(Boolean).join("; ");

      reject(new Error(
        "Nao foi encontrada nenhuma entrada M3U valida" +
        (detail ? " (" + detail + ")" : "")
      ));
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (itemCount > 0) {
          finalize("idle-timeout");
        } else if (!settled) {
          settled = true;
          cleanup();
          if (responseRef) {
            try { responseRef.destroy(); } catch {}
          }
          if (requestRef) {
            try { requestRef.destroy(); } catch {}
          }
          reject(new Error("Timeout sem receber entradas M3U validas"));
        }
      }, idleMs);
    };

    const processLine = rawLine => {
      const line = String(rawLine || "").replace(/\r/g, "").trim();
      if (!line) return;

      if (line.startsWith("#EXTINF")) {
        pendingInfo = line;
        return;
      }

      if (pendingInfo && !line.startsWith("#")) {
        output.push(pendingInfo);
        output.push(line);
        pendingInfo = "";
        itemCount++;

        if (itemCount >= maxItems) {
          finalize("limite-itens");
        }
      }
    };

    const optionsReq = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: "GET",
      family: 4,
      headers,
      rejectUnauthorized: false
    };

    requestRef = client.request(optionsReq, upstreamRes => {
      responseRef = upstreamRes;
      status = upstreamRes.statusCode || 0;
      contentType = String(upstreamRes.headers["content-type"] || "");

      if (
        status >= 300 &&
        status < 400 &&
        upstreamRes.headers.location
      ) {
        const nextUrl = new URL(upstreamRes.headers.location, rawUrl).toString();
        settled = true;
        cleanup();
        upstreamRes.resume();
        streamM3uIncremental(nextUrl, userAgent, options, redirects + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status < 200 || status >= 300) {
        upstreamRes.on("data", chunk => {
          receivedBytes += chunk.length;
          if (preview.length < 2048) preview += chunk.toString("utf8");
        });
        upstreamRes.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(
            "Servidor IPTV respondeu HTTP " + status +
            (preview ? " - " + sanitizeDiagnosticPreview(preview) : "")
          ));
        });
        resetIdle();
        return;
      }

      resetIdle();

      upstreamRes.on("data", chunk => {
        if (settled) return;
        receivedBytes += chunk.length;
        if (preview.length < 2048) preview += chunk.toString("utf8");
        resetIdle();

        remainder += chunk.toString("utf8");
        const lines = remainder.split(/\n/);
        remainder = lines.pop() || "";
        for (const line of lines) {
          processLine(line);
          if (settled) return;
        }
      });

      upstreamRes.on("end", () => {
        if (settled) return;
        if (remainder) processLine(remainder);
        finalize("fim");
      });

      upstreamRes.on("error", error => {
        if (settled) return;
        if (itemCount > 0) {
          finalize("erro-apos-dados");
        } else {
          settled = true;
          cleanup();
          reject(error);
        }
      });
    });

    requestRef.setTimeout(idleMs, () => {
      if (itemCount > 0) {
        finalize("socket-timeout");
      } else if (!settled) {
        requestRef.destroy(new Error("Timeout ao conectar ao servidor IPTV"));
      }
    });

    totalTimer = setTimeout(() => {
      if (itemCount > 0) {
        finalize("total-timeout");
      } else if (!settled) {
        settled = true;
        cleanup();
        try { requestRef.destroy(); } catch {}
        reject(new Error("Tempo total excedido sem entradas M3U validas"));
      }
    }, totalMs);

    requestRef.on("error", error => {
      if (settled) return;
      if (itemCount > 0) {
        finalize("erro-apos-dados");
      } else {
        settled = true;
        cleanup();
        reject(error);
      }
    });

    requestRef.end();
  });
}

async function fetchPlaylistUniversal(url, code) {
  const attempts = [
    ["VLC", "VLC/3.0.20 LibVLC/3.0.20"],
    ["Smarters", "IPTVSmartersPro"],
    ["OkHttp", "okhttp/4.12.0"],
    [
      "Android",
      "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36"
    ]
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const result = await streamM3uIncremental(url, attempt[1], {
        idleMs: 10000,
        totalMs: 45000,
        maxItems: 5000
      });

      console.log(
        "IPTV V14 M3U",
        code,
        attempt[0],
        "HTTP",
        result.status,
        "bytes",
        result.bytes,
        "items",
        result.items,
        "partial",
        result.partial,
        "reason",
        result.reason,
        "type",
        result.contentType
      );

      if (result.ok && result.items > 0) {
        return {
          ok: true,
          text: result.text,
          method: attempt[0],
          items: result.items,
          partial: result.partial,
          reason: result.reason
        };
      }
    } catch (error) {
      const safe = sanitizeDiagnosticPreview(error.message);
      errors.push(attempt[0] + ": " + safe);
      console.error("IPTV V14 M3U", code, attempt[0], safe);
    }
  }

  return {
    ok: false,
    text: "",
    method: "",
    error: errors.join(" | ")
  };
}

function relayUniversalStream(req, res, code, targetUrl, redirects = 0) {
  if (redirects > 5) {
    return res.status(502).type("text/plain").send("Muitos redirecionamentos");
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).type("text/plain").send("URL de stream invalida");
  }

  let parsed;

  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).type("text/plain").send("URL de stream invalida");
  }

  const client = parsed.protocol === "https:" ? https : http;

  const headers = {
    "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Connection": "close"
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  const options = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: parsed.pathname + parsed.search,
    method: "GET",
    family: 4,
    headers,
    rejectUnauthorized: false
  };

  const upstream = client.request(options, upstreamRes => {
    const status = upstreamRes.statusCode || 502;

    if (
      status >= 300 &&
      status < 400 &&
      upstreamRes.headers.location
    ) {
      const nextUrl = new URL(
        upstreamRes.headers.location,
        targetUrl
      ).toString();

      upstreamRes.resume();

      return relayUniversalStream(
        req,
        res,
        code,
        nextUrl,
        redirects + 1
      );
    }

    const contentType = String(upstreamRes.headers["content-type"] || "");
    const looksLikeHlsType =
      /mpegurl|m3u8/i.test(contentType) ||
      /\.m3u8(?:$|\?)/i.test(parsed.pathname + parsed.search);

    if (looksLikeHlsType) {
      const chunks = [];

      upstreamRes.on("data", chunk => {
        chunks.push(chunk);
      });

      upstreamRes.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");

        if (body.includes("#EXTM3U")) {
          const rewritten = rewriteM3uForProxy(
            body,
            code,
            publicBaseFromRequest(req),
            targetUrl
          );

          if (rewritten) {
            res.set({
              "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
              "Cache-Control": "no-store",
              "Access-Control-Allow-Origin": "*"
            });

            return res.status(status).send(rewritten);
          }
        }

        res.set({
          "Content-Type": contentType || "application/octet-stream",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        });

        return res.status(status).send(body);
      });

      return;
    }

    const responseHeaders = {};

    for (const key of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "last-modified",
      "etag"
    ]) {
      if (upstreamRes.headers[key] != null) {
        responseHeaders[key] = upstreamRes.headers[key];
      }
    }

    responseHeaders["access-control-allow-origin"] = "*";
    responseHeaders["connection"] = "close";

    res.writeHead(status, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstream.setTimeout(25000, () => {
    upstream.destroy(new Error("Timeout no stream IPTV"));
  });

  upstream.on("error", error => {
    console.error("IPTV UNIVERSAL STREAM:", error.message);

    if (!res.headersSent) {
      res.status(502).type("text/plain").send(
        "Erro no proxy IPTV: " + error.message
      );
    } else {
      res.destroy();
    }
  });

  req.on("close", () => {
    try {
      upstream.destroy();
    } catch {}
  });

  upstream.end();
}

app.get("/iptv/device/:code/diagnostico", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");

  const code = normalizeDeviceCode(req.params.code);

  if (!validDeviceCode(code)) {
    return res.status(400).json({
      ok: false,
      error: "Codigo invalido"
    });
  }

  const cfg = deviceConfigs.get(code);

  if (!cfg || !cfg.m3uUrl) {
    return res.status(404).json({
      ok: false,
      configured: Boolean(cfg),
      error: "Nenhuma URL M3U cadastrada para este dispositivo"
    });
  }

  const browser = await probeIptvUrl(
    cfg.m3uUrl,
    "Browser"
  );

  const vlc = await probeIptvUrl(
    cfg.m3uUrl,
    "VLC",
    "VLC/3.0.20 LibVLC/3.0.20"
  );

  const anyM3u =
    browser.hasExtm3u ||
    browser.hasExtinf ||
    vlc.hasExtm3u ||
    vlc.hasExtinf;

  return res.status(200).json({
    ok: anyM3u,
    configured: true,
    mode: "m3u-direct",
    code,
    summary: anyM3u
      ? "O servidor devolveu conteudo M3U em pelo menos uma tentativa."
      : "O servidor respondeu, mas nao devolveu uma playlist M3U reconhecivel.",
    attempts: [browser, vlc]
  });
});





function normalizeCatalogText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function extractM3uAttr(info, name) {
  const match = String(info || "").match(new RegExp(name + '="([^"]*)"', "i"));
  return match ? match[1] : "";
}

function classifyLibraryItemDetailed(info, targetUrl) {
  const rawInfo = String(info || "");
  const urlText = String(targetUrl || "").toLowerCase();

  let pathname = urlText;
  try {
    pathname = new URL(targetUrl).pathname.toLowerCase();
  } catch {}

  const comma = rawInfo.indexOf(",");
  const titleRaw = comma >= 0 ? rawInfo.slice(comma + 1) : "";
  const groupRaw = extractM3uAttr(rawInfo, "group-title");
  const tvgId = extractM3uAttr(rawInfo, "tvg-id");

  const title = normalizeCatalogText(titleRaw);
  const group = normalizeCatalogText(groupRaw);
  const labels = (group + " " + title).replace(/\s+/g, " ").trim();

  // Very strong Xtream-style route hints.
  if (/\/(series|series_streams?)\//i.test(pathname)) return { kind: 2, confidence: 100 };
  if (/\/(movie|movies|vod|vod_streams?)\//i.test(pathname)) return { kind: 1, confidence: 100 };

  // Episode naming is stronger than a generic live-looking URL.
  if (
    /\bs\d{1,2}\s*e\d{1,3}\b/i.test(titleRaw) ||
    /\b\d{1,2}x\d{1,3}\b/i.test(titleRaw) ||
    /\b(?:t|temp|temporada)\s*\d{1,2}\s*(?:e|ep|episodio)\s*\d{1,3}\b/i.test(normalizeCatalogText(titleRaw)) ||
    /\b(?:episodio|episode|ep)\s*\.?\s*\d{1,3}\b/i.test(normalizeCatalogText(titleRaw))
  ) {
    return { kind: 2, confidence: 98 };
  }

  const seriesWords =
    /\b(series|serie|seriados|seriado|episodios|episodio|temporadas|temporada|novelas|novela|animes|anime|doramas|dorama)\b/i;
  const movieWords =
    /\b(filmes|filme|movies|movie|cinema|vod|lancamentos|lancamento|premieres|premiere)\b/i;
  const liveWords =
    /\b(tv\s*ao\s*vivo|ao\s*vivo|canais|canal|abertos|aberto|esportes|esporte|sports|sport|noticias|noticia|news|24h|radio)\b/i;

  if (seriesWords.test(group)) return { kind: 2, confidence: 94 };
  if (movieWords.test(group)) return { kind: 1, confidence: 94 };
  if (liveWords.test(group)) return { kind: 0, confidence: 92 };

  // Prefixes commonly used by IPTV catalogs.
  if (/^(srs|serie|series|seriados)\s*[-|:]/i.test(group)) return { kind: 2, confidence: 94 };
  if (/^(filme|filmes|movie|movies|vod)\s*[-|:]/i.test(group)) return { kind: 1, confidence: 94 };
  if (/^(tv|live|canais)\s*[-|:]/i.test(group)) return { kind: 0, confidence: 92 };

  // Strong live route comes after explicit catalog metadata / episode detection.
  if (/\/(live|live_streams?)\//i.test(pathname)) return { kind: 0, confidence: 90 };

  // File extension: VOD container. Episode-shaped titles remain series.
  if (/\.(mp4|mkv|avi|mov|m4v)(?:\?|$)/i.test(urlText)) {
    if (seriesWords.test(labels)) return { kind: 2, confidence: 88 };
    return { kind: 1, confidence: 82 };
  }

  // Title-only hints are weaker than group metadata.
  if (seriesWords.test(title)) return { kind: 2, confidence: 76 };
  if (movieWords.test(title)) return { kind: 1, confidence: 74 };

  // A populated tvg-id is a useful fallback hint for real live channels.
  if (String(tvgId || "").trim()) return { kind: 0, confidence: 62 };

  // Unknown for now. Group-majority inference in the second pass decides it.
  return { kind: -1, confidence: 0 };
}

function classifyLibraryItem(info, targetUrl) {
  const result = classifyLibraryItemDetailed(info, targetUrl);
  return result.kind >= 0 ? result.kind : 0;
}

function detectRokuStreamFormat(targetUrl) {
  const value = String(targetUrl || "").toLowerCase();
  if (/\.m3u8(?:\?|$)/i.test(value)) return "hls";
  if (/\.mpd(?:\?|$)/i.test(value)) return "dash";
  if (/\.mp4(?:\?|$)/i.test(value)) return "mp4";
  if (/\.mkv(?:\?|$)/i.test(value)) return "mkv";

  // Do not label MPEG-TS as HLS. Roku can probe raw .ts streams itself.
  if (/\.ts(?:\?|$)/i.test(value)) return "";
  return "";
}

function parseM3uForRokuLibrary(text, code, publicBase, sourceUrl) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const rawItems = [];
  let info = "";

  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      info = line;
      continue;
    }

    if (!info || line.startsWith("#")) continue;

    let absolute;
    try {
      absolute = new URL(line, sourceUrl).toString();
    } catch {
      info = "";
      continue;
    }

    const comma = info.indexOf(",");
    const title = (comma >= 0 ? info.slice(comma + 1) : "Item").trim() || "Item";
    const groupTitle = extractM3uAttr(info, "group-title").slice(0, 120);
    const detail = classifyLibraryItemDetailed(info, absolute);

    rawItems.push({
      info,
      title,
      groupTitle,
      absolute,
      detail
    });
    info = "";
  }

  // Build a per-group profile from high-confidence entries. This fixes providers
  // that use opaque group names and the same .ts extension for TV, movies and series.
  const groupStats = new Map();

  for (const item of rawItems) {
    const key = normalizeCatalogText(item.groupTitle).trim();
    if (!key) continue;

    if (!groupStats.has(key)) {
      groupStats.set(key, { live: 0, movies: 0, series: 0, total: 0 });
    }

    const stat = groupStats.get(key);
    stat.total++;

    if (item.detail.confidence >= 74) {
      if (item.detail.kind === 0) stat.live += item.detail.confidence;
      if (item.detail.kind === 1) stat.movies += item.detail.confidence;
      if (item.detail.kind === 2) stat.series += item.detail.confidence;
    }
  }

  const groupKinds = new Map();
  for (const [key, stat] of groupStats) {
    const values = [
      { kind: 0, score: stat.live },
      { kind: 1, score: stat.movies },
      { kind: 2, score: stat.series }
    ].sort((a, b) => b.score - a.score);

    if (values[0].score > 0 && values[0].score >= values[1].score * 1.35) {
      groupKinds.set(key, values[0].kind);
    }
  }

  const buckets = { 0: [], 1: [], 2: [] };

  for (const item of rawItems) {
    let kind = item.detail.kind;
    const key = normalizeCatalogText(item.groupTitle).trim();

    // Only override weak/unknown classifications. Never override strong URL/group evidence.
    if ((kind < 0 || item.detail.confidence < 70) && key && groupKinds.has(key)) {
      kind = groupKinds.get(key);
    }

    if (kind < 0) {
      // Last-resort title heuristics for episodic content.
      const t = normalizeCatalogText(item.title);
      if (
        /\bs\d{1,2}\s*e\d{1,3}\b/i.test(item.title) ||
        /\b\d{1,2}x\d{1,3}\b/i.test(item.title) ||
        /\b(?:episodio|episode|ep)\s*\.?\s*\d{1,3}\b/i.test(t)
      ) {
        kind = 2;
      } else {
        kind = 0;
      }
    }

    const proxied = makeProxyUrl(publicBase, code, item.absolute);
    const format = detectRokuStreamFormat(item.absolute);

    buckets[kind].push({
      title: item.title.slice(0, 180),
      url: proxied,
      proxyUrl: proxied,
      directUrl: item.absolute,
      kind,
      groupTitle: item.groupTitle,
      logo: extractM3uAttr(item.info, "tvg-logo").slice(0, 500),
      streamFormat: format
    });
  }

  // Balanced payload: each tab receives its own catalog, preventing one huge TV
  // section from pushing movies/series out of the Roku response.
  const selected = [];
  const quotas = { 0: 300, 1: 300, 2: 300 };

  for (const kind of [0, 1, 2]) {
    selected.push(...buckets[kind].slice(0, quotas[kind]));
  }

  const maxTotal = 900;
  if (selected.length < maxTotal) {
    const used = new Set(selected.map(x => x.url));
    for (const kind of [2, 1, 0]) {
      for (const item of buckets[kind]) {
        if (selected.length >= maxTotal) break;
        if (!used.has(item.url)) {
          selected.push(item);
          used.add(item.url);
        }
      }
      if (selected.length >= maxTotal) break;
    }
  }

  console.log(
    "IPTV V15.3 CLASSIFICACAO:",
    "TV", buckets[0].length,
    "FILMES", buckets[1].length,
    "SERIES", buckets[2].length,
    "GRUPOS", groupKinds.size
  );

  return {
    items: selected,
    counts: {
      live: selected.filter(x => x.kind === 0).length,
      movies: selected.filter(x => x.kind === 1).length,
      series: selected.filter(x => x.kind === 2).length,
      total: selected.length
    },
    available: {
      live: buckets[0].length,
      movies: buckets[1].length,
      series: buckets[2].length,
      total: buckets[0].length + buckets[1].length + buckets[2].length
    }
  };
}

app.get("/iptv/device/:code/library.json", async (req, res) => {
  const code = normalizeDeviceCode(req.params.code);
  if (!validDeviceCode(code)) return res.status(400).json({ ok: false, error: "Codigo invalido" });

  const cfg = deviceConfigs.get(code);
  if (!cfg || (!cfg.m3uUrl && !cfg.m3uText)) {
    return res.status(404).json({ ok: false, error: "Nenhuma M3U cadastrada para este dispositivo" });
  }

  try {
    let playlistText = "";
    let sourceUrl = cfg.m3uUrl || "";

    if (cfg.m3uText) {
      playlistText = String(cfg.m3uText);
      sourceUrl = cfg.m3uUrl || "https://local.elin.invalid/list.m3u";
    } else {
      const fetched = await fetchPlaylistUniversal(cfg.m3uUrl, code);
      if (!fetched.ok) throw new Error(fetched.error || "M3U invalida");
      playlistText = fetched.text;
    }

    const library = parseM3uForRokuLibrary(
      playlistText,
      code,
      publicBaseFromRequest(req),
      sourceUrl
    );

    if (!library.items.length) {
      return res.status(422).json({ ok: false, error: "Nenhum item reproduzivel encontrado" });
    }

    console.log("IPTV V15 LIBRARY:", code, "enviando", library.counts.total, "de", library.available.total, "itens");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.status(200).json({ ok: true, name: cfg.name || "Minha IPTV", ...library });
  } catch (error) {
    console.error("IPTV V15 LIBRARY:", code, error.message);
    return res.status(502).json({ ok: false, error: "Falha ao preparar biblioteca IPTV" });
  }
});

app.get("/iptv/device/:code/proxy.m3u", async (req, res) => {
  const code = normalizeDeviceCode(req.params.code);

  if (!validDeviceCode(code)) {
    return res.status(400).type("text/plain").send("Codigo invalido");
  }

  const cfg = deviceConfigs.get(code);

  if (!cfg || (!cfg.m3uUrl && !cfg.m3uText)) {
    return res.status(404).type("text/plain").send(
      "Nenhuma M3U cadastrada para este dispositivo"
    );
  }

  let playlistText = "";
  let sourceUrl = cfg.m3uUrl || "";

  if (cfg.m3uText) {
    playlistText = String(cfg.m3uText);
    sourceUrl = cfg.m3uUrl || "https://local.elin.invalid/list.m3u";
    console.log("IPTV V14 usando M3U cadastrada em texto:", code);
  } else {
    const fetched = await fetchPlaylistUniversal(cfg.m3uUrl, code);

    if (!fetched.ok) {
      console.error("IPTV V14 M3U:", code, fetched.error);

      return res.status(502).type("text/plain").send(
        "O provedor respondeu, mas nao entregou uma M3U valida. " +
        fetched.error
      );
    }

    playlistText = fetched.text;
  }

  const rewritten = rewriteM3uForProxy(
    playlistText,
    code,
    publicBaseFromRequest(req),
    sourceUrl
  );

  if (!rewritten) {
    return res.status(422).type("text/plain").send(
      "A M3U foi recebida, mas nao contem URLs reproduziveis."
    );
  }

  res.set({
    "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });

  return res.status(200).send(rewritten);
});

app.get("/iptv/device/:code/stream", (req, res) => {
  const code = normalizeDeviceCode(req.params.code);

  if (!validDeviceCode(code)) {
    return res.status(400).type("text/plain").send("Codigo invalido");
  }

  const targetUrl = decodeProxyTarget(req.query.u);
  const signature = String(req.query.sig || "");

  if (!targetUrl) {
    return res.status(400).type("text/plain").send("Stream sem destino");
  }

  if (!validProxySignature(code, targetUrl, signature)) {
    return res.status(403).type("text/plain").send("Assinatura invalida");
  }

  return relayUniversalStream(req, res, code, targetUrl);
});

app.get("/iptv/device/:code/m3u", async (req, res) => {
  const code =
    normalizeDeviceCode(req.params.code);

  if (!validDeviceCode(code)) {
    return res
      .status(400)
      .type("text/plain")
      .send("Codigo invalido");
  }

  try {
    const m3u =
      await downloadDeviceM3u(code);

    res.set({
      "Content-Type":
        "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control":
        "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });

    return res
      .status(200)
      .send(m3u);
  } catch (error) {
    console.error(
      "IPTV DEVICE:",
      code,
      error.message
    );

    return res
      .status(502)
      .type("text/plain")
      .send(
        "Erro IPTV: " +
        error.message
      );
  }
});

app.get("/v5/open", async (req, res) => {
  const id = String(req.query.session || "").trim();
  const url = String(req.query.url || "").trim();

  if (!validSession(id)) {
    return res.status(400).send("Sessao invalida");
  }

  if (!validUrl(url)) {
    return res.status(400).send("URL invalida");
  }

  try {
    const session = await createSession(id);
    const ok = await openUrl(session.page, url);

    if (!ok) {
      await session.page.setContent(
        "<html><body style='font-family:Arial;padding:80px'>" +
        "<h1>Pagina indisponivel</h1>" +
        "<p>O site nao respondeu ou bloqueou o navegador remoto.</p>" +
        "</body></html>"
      );
    }

    return shot(session.page, res);
  } catch (error) {
    console.error("OPEN:", error);
    return res.status(500).send("Erro interno");
  }
});

app.get("/v5/search", async (req, res) => {
  const id = String(req.query.session || "").trim();
  const query = String(req.query.q || "").trim();

  if (!validSession(id)) {
    return res.status(400).send("Sessao invalida");
  }

  if (!query) {
    return res.status(400).send("Pesquisa vazia");
  }

  try {
    const session = await createSession(id);

    let items = [];

    try {
      items = await searchRss(query);
    } catch {}

    await session.page.setContent(
      resultsHtml("Pesquisa", query, items),
      { waitUntil: "domcontentloaded" }
    );

    await waitVisual(session.page, 2200);

    return shot(session.page, res);
  } catch (error) {
    console.error("SEARCH:", error);
    return res.status(500).send("Erro interno");
  }
});

app.get("/v6/youtube-search", async (req, res) => {
  const id = String(req.query.session || "").trim();
  const query = String(req.query.q || "").trim();

  if (!validSession(id)) {
    return res.status(400).send("Sessao invalida");
  }

  if (!query) {
    return res.status(400).send("Pesquisa vazia");
  }

  try {
    const session = await createSession(id);
    const items = await youtubeSearch(query);

    await session.page.setContent(
      resultsHtml("YouTube", query, items),
      { waitUntil: "domcontentloaded" }
    );

    await waitVisual(session.page, 4000);

    return shot(session.page, res);
  } catch (error) {
    console.error("YT SEARCH:", error);
    return res.status(500).send("Erro interno");
  }
});

app.get("/v5/click", async (req, res) => {
  const session =
    getSession(
      String(req.query.session || "").trim()
    );

  if (!session) {
    return res.status(404).send("Sessao nao encontrada");
  }

  const x = Number(req.query.x);
  const y = Number(req.query.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).send("Coordenadas invalidas");
  }

  try {
    const href = await session.page.evaluate(
      ({ x, y }) => {
        const elements = Array.from(
          document.querySelectorAll(
            "a,button,input,[role='button'],[onclick]"
          )
        );

        let best = null;
        let distance = Infinity;

        for (const element of elements) {
          const rect = element.getBoundingClientRect();

          if (rect.width < 2 || rect.height < 2) continue;

          const nx = Math.max(
            rect.left,
            Math.min(x, rect.right)
          );

          const ny = Math.max(
            rect.top,
            Math.min(y, rect.bottom)
          );

          const d = Math.hypot(nx - x, ny - y);

          if (d < distance) {
            distance = d;
            best = element;
          }
        }

        if (!best || distance > 170) return "";

        const anchor =
          best.tagName.toLowerCase() === "a"
            ? best
            : best.closest("a");

        return anchor && anchor.href
          ? anchor.href
          : "";
      },
      {
        x: Math.max(0, Math.min(1279, Math.round(x))),
        y: Math.max(0, Math.min(719, Math.round(y)))
      }
    );

    if (href) {
      await openUrl(session.page, href);
    } else {
      await session.page.mouse.click(
        Math.max(0, Math.min(1279, Math.round(x))),
        Math.max(0, Math.min(719, Math.round(y)))
      );

      await waitVisual(session.page, 1800);
    }

    return shot(session.page, res);
  } catch (error) {
    console.error("CLICK:", error);
    return res.status(500).send("Erro interno");
  }
});

app.get("/v5/back", async (req, res) => {
  const session =
    getSession(
      String(req.query.session || "").trim()
    );

  if (!session) {
    return res.status(404).send("Sessao nao encontrada");
  }

  try {
    await session.page.goBack({
      waitUntil: "domcontentloaded",
      timeout: 18000
    });

    await waitVisual(session.page, 2000);
  } catch {}

  return shot(session.page, res);
});

app.get("/v5/forward", async (req, res) => {
  const session =
    getSession(
      String(req.query.session || "").trim()
    );

  if (!session) {
    return res.status(404).send("Sessao nao encontrada");
  }

  try {
    await session.page.goForward({
      waitUntil: "domcontentloaded",
      timeout: 18000
    });

    await waitVisual(session.page, 2000);
  } catch {}

  return shot(session.page, res);
});

app.get("/v5/scroll", async (req, res) => {
  const session =
    getSession(
      String(req.query.session || "").trim()
    );

  if (!session) {
    return res.status(404).send("Sessao nao encontrada");
  }

  let dy = Number(req.query.dy);

  if (!Number.isFinite(dy)) {
    dy = 700;
  }

  dy = Math.max(-1500, Math.min(1500, dy));

  try {
    await session.page.evaluate(
      amount => window.scrollBy(0, amount),
      dy
    );

    await waitVisual(session.page, 800);
  } catch {}

  return shot(session.page, res);
});

setInterval(async () => {
  const now = Date.now();

  for (const [id, session] of sessions) {
    if (
      now - session.last >
      30 * 60 * 1000
    ) {
      try {
        await session.context.close();
      } catch {}

      sessions.delete(id);
    }
  }
}, 60000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Navegador Roku V6.3 + IPTV Universal V15.3 Classificador PRO iniciado na porta " +
    PORT
  );

  console.log("Modo universal ativado");

  if (YOUTUBE_API_KEY) {
    console.log("YouTube API ativada");
  } else {
    console.log(
      "YouTube API sem chave - usando fallback"
    );
  }

  if (IPTV_M3U_URL) {
    console.log("IPTV_M3U_URL configurada");
  } else {
    console.log(
      "ATENCAO: IPTV_M3U_URL nao configurada"
    );
  }
});
