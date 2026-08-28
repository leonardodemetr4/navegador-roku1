const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }
  return browserPromise;
}

app.get("/", (_req, res) => {
  res.send("<h1>Navegador Roku V2</h1><p>Servidor online.</p>");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "navegador-roku-v2"
  });
});

app.get("/snapshot-image", async (req, res) => {
  const raw = String(req.query.url || "").trim();

  if (!raw) {
    return res.status(400).send("URL ausente");
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return res.status(400).send("URL inválida");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return res.status(400).send("URL inválida");
  }

  let context;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 720
      },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();

    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(1600);

    const image = await page.screenshot({
      type: "png",
      fullPage: false
    });

    res.set("Cache-Control", "no-store");
    res.type("png").send(image);

  } catch (err) {
    console.error(err);
    res.status(502).send("Falha ao abrir página");

  } finally {
    if (context) {
      await context.close();
    }
  }
});

app.get("/snapshot", (req, res) => {
  const raw = String(req.query.url || "").trim();

  if (!raw) {
    return res.status(400).json({
      ok: false,
      error: "URL ausente"
    });
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return res.status(400).json({
      ok: false,
      error: "URL inválida"
    });
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return res.status(400).json({
      ok: false,
      error: "URL inválida"
    });
  }

  const base = `${req.protocol}://${req.get("host")}`;

  const imageUrl =
    `${base}/snapshot-image?url=${encodeURIComponent(url.toString())}`;

  res.json({
    ok: true,
    url: url.toString(),
    imageUrl
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Navegador Roku V2 na porta ${PORT}`);
});
