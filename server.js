const express = require("express");
const { chromium } = require("playwright");
const dns = require("dns").promises;
const net = require("net");

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.static("public"));

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h === "0.0.0.0" ||
    h === "::1"
  );
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL inválida.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Use uma URL http:// ou https://.");
  }

  if (isBlockedHostname(url.hostname)) {
    throw new Error("Esse endereço não é permitido.");
  }

  if (net.isIP(url.hostname) === 4 && isPrivateIPv4(url.hostname)) {
    throw new Error("Endereços de rede privada não são permitidos.");
  }

  if (!net.isIP(url.hostname)) {
    const addresses = await dns.lookup(url.hostname, { all: true });
    for (const item of addresses) {
      if (item.family === 4 && isPrivateIPv4(item.address)) {
        throw new Error("O endereço aponta para uma rede privada e não é permitido.");
      }
      if (item.family === 6 && (item.address === "::1" || item.address.startsWith("fc") || item.address.startsWith("fd"))) {
        throw new Error("O endereço aponta para uma rede privada e não é permitido.");
      }
    }
  }

  return url.toString();
}

function addBaseTag(html, finalUrl) {
  const base = `<base href="${finalUrl.replace(/"/g, "&quot;")}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${base}`);
  }
  return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "navegador-roku" });
});

app.get("/browse", async (req, res) => {
  const requestedUrl = String(req.query.url || "").trim();

  if (!requestedUrl) {
    return res.status(400).send("Informe uma URL. Exemplo: /browse?url=https://example.com");
  }

  let targetUrl;
  try {
    targetUrl = await assertPublicUrl(requestedUrl);
  } catch (err) {
    return res.status(400).send(err.message);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      userAgent: "NavegadorRoku/1.0"
    });

    const page = await context.newPage();

    await page.route("**/*", async (route) => {
      try {
        const u = new URL(route.request().url());
        if (isBlockedHostname(u.hostname)) return route.abort();
        if (net.isIP(u.hostname) === 4 && isPrivateIPv4(u.hostname)) return route.abort();
      } catch {}
      return route.continue();
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(1000);

    const finalUrl = page.url();
    const html = await page.content();

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(addBaseTag(html, finalUrl));
  } catch (err) {
    console.error(err);
    res.status(502).send(`
      <!doctype html>
      <html lang="pt-BR">
      <meta charset="utf-8">
      <title>Navegador Roku - Erro</title>
      <style>
        body{font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:20px}
        code{word-break:break-all}
      </style>
      <h1>Não foi possível abrir a página</h1>
      <p>${String(err.message).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</p>
      <p><code>${targetUrl}</code></p>
      </html>
    `);
  } finally {
    if (browser) await browser.close();
  }
});

app.get("*", (_req, res) => {
  res.sendFile("index.html", { root: "public" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Navegador Roku rodando na porta ${PORT}`);
});
