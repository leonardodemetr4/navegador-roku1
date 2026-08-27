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
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }

  return browserPromise;
}

app.get("/", (req, res) => {
  res.type("html").send(`
    <h1>Navegador Roku</h1>
    <p>Servidor online.</p>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "navegador-roku"
  });
});

app.get("/browse", async (req, res) => {
  const rawUrl = String(req.query.url || "").trim();

  if (!rawUrl) {
    return res.status(400).send("URL ausente.");
  }

  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return res.status(400).send("URL inválida.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return res.status(400).send("Somente HTTP e HTTPS são permitidos.");
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
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();

    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(2500);

    const image = await page.screenshot({
      type: "png",
      fullPage: false
    });

    res.set("Cache-Control", "no-store");
    res.type("png").send(image);

  } catch (err) {

    console.error(err);

    res.status(502).type("text").send(
      "Não foi possível abrir o site: " +
      (err.message || "erro desconhecido")
    );

  } finally {

    if (context) {
      await context.close();
    }
  }
});

process.on("SIGTERM", async () => {

  if (browserPromise) {

    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {}

  }

  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Navegador Roku rodando na porta ${PORT}`
  );
});
