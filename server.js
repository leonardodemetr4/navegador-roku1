const express = require("express");
const { chromium } = require("playwright");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));
const PORT = process.env.PORT || 10000;

const IPTV_M3U_URL = process.env.IPTV_M3U_URL || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

const sessions = new Map();
let browser = null;

let iptvCache = "";
let iptvCacheTime = 0;
const IPTV_CACHE_MS = 5 * 60 * 1000;

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

function requestText(rawUrl, timeoutMs = 25000, redirects = 0) {
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
          redirects + 1
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

async function fetchIptvCandidate(url, label) {
  console.log("IPTV tentativa:", label);

  const result =
    await requestText(url, 25000);

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
    const alt =
      httpsVariant(IPTV_M3U_URL);

    if (alt) {
      try {
        rawText =
          await fetchIptvCandidate(
            alt,
            "HTTPS alternativo"
          );
      } catch (error) {
        console.log(
          "IPTV HTTPS alternativo falhou:",
          error.message
        );

        throw new Error(
          firstError +
          " | " +
          error.message
        );
      }
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

function setupPage(message = "", codeValue = "") {
  const safeMessage = htmlEscape(message);
  const safeCode = htmlEscape(codeValue);

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ELIN PLAY - Adicionar lista</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  font-family:Arial,Helvetica,sans-serif;
  background:
    radial-gradient(circle at 15% 5%,#173a66 0,#08182c 35%,#040b16 100%);
  color:#eef9ff;
}
.wrap{
  width:min(920px,94%);
  margin:0 auto;
  padding:34px 0 60px;
}
.brand{
  text-align:center;
  font-size:34px;
  font-weight:800;
  letter-spacing:2px;
  margin-bottom:8px;
}
.sub{
  text-align:center;
  color:#9bcfe8;
  margin-bottom:28px;
}
.card{
  background:rgba(7,24,43,.94);
  border:1px solid #1f577c;
  border-radius:16px;
  padding:24px;
  box-shadow:0 18px 60px rgba(0,0,0,.35);
}
.notice{
  margin:0 0 18px;
  padding:13px 15px;
  border-radius:10px;
  background:#0d3049;
  border:1px solid #1db9de;
  color:#d9f9ff;
}
.tabs{
  display:flex;
  gap:10px;
  margin:18px 0;
}
.tab{
  flex:1;
  border:1px solid #235d7d;
  background:#0b2338;
  color:#c9f4ff;
  padding:12px;
  border-radius:10px;
  font-weight:700;
  cursor:pointer;
}
.tab.active{
  background:#0a6e95;
  border-color:#38d8ff;
  color:white;
}
label{
  display:block;
  font-weight:700;
  margin:16px 0 7px;
}
input{
  width:100%;
  border:1px solid #2c5973;
  background:#071827;
  color:white;
  border-radius:10px;
  padding:14px 13px;
  font-size:16px;
  outline:none;
}
input:focus{
  border-color:#32d5ff;
  box-shadow:0 0 0 2px rgba(50,213,255,.15);
}
.grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:14px;
}
.hidden{display:none}
button.save{
  width:100%;
  margin-top:24px;
  padding:15px;
  border:0;
  border-radius:11px;
  background:#0bb6df;
  color:#03131e;
  font-size:17px;
  font-weight:800;
  cursor:pointer;
}
.hint{
  color:#9ab9c9;
  line-height:1.5;
  font-size:14px;
  margin-top:18px;
}
.delete{
  margin-top:16px;
  text-align:center;
}
.delete button{
  border:1px solid #80505c;
  background:transparent;
  color:#ffb3c3;
  padding:10px 16px;
  border-radius:9px;
}
@media(max-width:650px){
  .grid{grid-template-columns:1fr}
  .wrap{padding-top:18px}
  .card{padding:18px}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">ELIN PLAY</div>
  <div class="sub">Cadastre sua propria lista IPTV no Roku</div>

  <div class="card">
    ${safeMessage ? `<div class="notice">${safeMessage}</div>` : ""}

    <form method="post" action="/setup/save" id="setupForm">
      <label>Codigo exibido na TV</label>
      <input
        name="code"
        maxlength="10"
        autocomplete="off"
        required
        value="${safeCode}"
        placeholder="Ex.: ABCD2345"
        style="text-transform:uppercase"
      >

      <label>Nome da lista</label>
      <input
        name="name"
        maxlength="80"
        placeholder="Minha IPTV"
      >

      <div class="tabs">
        <button class="tab active" type="button" data-mode="m3u">
          URL M3U
        </button>
        <button class="tab" type="button" data-mode="xtream">
          Conta Xtream
        </button>
      </div>

      <input type="hidden" name="mode" id="mode" value="m3u">

      <div id="m3uFields">
        <label>URL da lista M3U</label>
        <input
          name="m3uUrl"
          placeholder="http://servidor/get.php?..."
        >
      </div>

      <div id="xtreamFields" class="hidden">
        <label>Servidor Xtream</label>
        <input
          name="xtreamServer"
          placeholder="http://servidor:porta"
        >

        <div class="grid">
          <div>
            <label>Usuario</label>
            <input
              name="username"
              autocomplete="username"
            >
          </div>

          <div>
            <label>Senha</label>
            <input
              name="password"
              type="password"
              autocomplete="current-password"
            >
          </div>
        </div>
      </div>

      <label>URL EPG (opcional)</label>
      <input
        name="epgUrl"
        placeholder="https://.../epg.xml"
      >

      <button class="save" type="submit">
        Salvar e enviar para a TV
      </button>
    </form>

    <div class="hint">
      Use somente listas e contas que voce possui autorizacao para usar.
      O Roku consulta este servidor pelo codigo mostrado na tela e carrega
      a lista automaticamente.
    </div>

    <form class="delete" method="post" action="/setup/delete">
      <input
        type="hidden"
        name="code"
        id="deleteCode"
        value="${safeCode}"
      >
      <button type="submit">
        Apagar configuracao deste codigo
      </button>
    </form>
  </div>
</div>

<script>
const tabs = document.querySelectorAll(".tab");
const mode = document.getElementById("mode");
const m3u = document.getElementById("m3uFields");
const xtream = document.getElementById("xtreamFields");
const code = document.querySelector('input[name="code"]');
const deleteCode = document.getElementById("deleteCode");

function setMode(value) {
  mode.value = value;

  tabs.forEach(btn => {
    btn.classList.toggle(
      "active",
      btn.dataset.mode === value
    );
  });

  m3u.classList.toggle(
    "hidden",
    value !== "m3u"
  );

  xtream.classList.toggle(
    "hidden",
    value !== "xtream"
  );
}

tabs.forEach(btn => {
  btn.addEventListener("click", () => {
    setMode(btn.dataset.mode);
  });
});

code.addEventListener("input", () => {
  code.value =
    code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  deleteCode.value = code.value;
});
</script>
</body>
</html>`;
}

loadDeviceConfigs();

app.get("/setup", (req, res) => {
  const code =
    normalizeDeviceCode(req.query.code);

  const saved =
    String(req.query.saved || "") === "1";

  const deleted =
    String(req.query.deleted || "") === "1";

  let message = "";

  if (saved) {
    message =
      "Lista salva. Volte para a TV; o app vai detectar a configuracao.";
  } else if (deleted) {
    message =
      "Configuracao apagada.";
  }

  res
    .status(200)
    .type("html")
    .send(
      setupPage(message, code)
    );
});

app.post("/setup/save", (req, res) => {
  const code =
    normalizeDeviceCode(req.body.code);

  if (!validDeviceCode(code)) {
    return res
      .status(400)
      .type("html")
      .send(
        setupPage(
          "Codigo invalido. Digite exatamente o codigo mostrado na TV.",
          code
        )
      );
  }

  const mode =
    String(req.body.mode || "m3u")
      .trim()
      .toLowerCase();

  const name =
    String(req.body.name || "Minha IPTV")
      .trim()
      .slice(0, 80) ||
    "Minha IPTV";

  let m3uUrl = "";

  if (mode === "xtream") {
    m3uUrl =
      buildXtreamM3u(
        req.body.xtreamServer,
        String(req.body.username || "").trim(),
        String(req.body.password || "")
      );
  } else {
    m3uUrl =
      normalizeHttpUrl(req.body.m3uUrl);
  }

  if (!m3uUrl) {
    return res
      .status(400)
      .type("html")
      .send(
        setupPage(
          "Confira os dados da lista. A URL ou a conta Xtream nao e valida.",
          code
        )
      );
  }

  const epgUrl =
    normalizeHttpUrl(req.body.epgUrl);

  deviceConfigs.set(code, {
    name,
    mode:
      mode === "xtream"
        ? "xtream"
        : "m3u",
    m3uUrl,
    epgUrl,
    updatedAt:
      new Date().toISOString()
  });

  deviceM3uCache.delete(code);
  saveDeviceConfigs();

  return res.redirect(
    "/setup?code=" +
    encodeURIComponent(code) +
    "&saved=1"
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
      cfg.updatedAt || null
  });
});

async function downloadDeviceM3u(code) {
  const cfg =
    deviceConfigs.get(code);

  if (!cfg || !cfg.m3uUrl) {
    throw new Error(
      "Nenhuma lista cadastrada para este dispositivo"
    );
  }

  const cached =
    deviceM3uCache.get(code);

  if (
    cached &&
    Date.now() - cached.time < DEVICE_CACHE_MS
  ) {
    return cached.text;
  }

  let rawText = "";
  let firstError = "";

  try {
    rawText =
      await fetchIptvCandidate(
        cfg.m3uUrl,
        "Dispositivo " + code
      );
  } catch (error) {
    firstError = error.message;
  }

  if (!rawText) {
    const alt =
      httpsVariant(cfg.m3uUrl);

    if (alt) {
      try {
        rawText =
          await fetchIptvCandidate(
            alt,
            "Dispositivo " + code + " HTTPS"
          );
      } catch (error) {
        throw new Error(
          firstError +
          " | " +
          error.message
        );
      }
    }
  }

  if (!rawText) {
    throw new Error(
      firstError ||
      "Nao foi possivel obter a lista"
    );
  }

  const cleaned =
    cleanM3u(rawText);

  if (!cleaned) {
    throw new Error(
      "A lista nao possui itens M3U validos"
    );
  }

  deviceM3uCache.set(code, {
    time: Date.now(),
    text: cleaned
  });

  return cleaned;
}

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
    "Navegador Roku V6.3 + IPTV iniciado na porta " +
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
