const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }

  return browser;
}

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Navegador Roku</title>
    </head>
    <body>
      <h1>Navegador Roku</h1>
      <p>Servidor online!</p>
      <p>Use /browse?url=https://example.com para testar.</p>
    </body>
    </html>
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
    return res.status(400).json({
      error: "URL ausente"
    });
  }

  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return res.status(400).json({
      error: "URL inválida"
    });
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return res.status(400).json({
      error: "Somente HTTP e HTTPS são permitidos"
    });
  }

  let page = null;

  try {
    const browser = await getBrowser();

    page = await browser.newPage({
      viewport: {
        width: 1280,
        height: 720
      }
    });

    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(1500);

    const screenshot = await page.screenshot({
      type: "png",
      fullPage: false
    });

    res.setHeader("Content-Type", "image/png");
    res.send(screenshot);
  } catch (error) {
    console.error("Erro ao abrir página:", error);

    res.status(500).json({
      error: "Não foi possível abrir a página",
      message: error.message
    });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Navegador Roku rodando na porta ${PORT}`);
  console.log(`Porta utilizada: ${PORT}`);
});
