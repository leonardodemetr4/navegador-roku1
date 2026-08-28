const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

let browserPromise;
const sessions = new Map();

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

async function createPage() {
  const browser = await getBrowser();

  const context = await browser.newContext({
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

  return {
    context,
    page
  };
}

function validUrl(raw) {
  try {
    const url = new URL(raw);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function sendImage(res, image) {
  res.set("Cache-Control", "no-store");
  res.type("png");
  res.send(image);
}

app.get("/", (_req, res) => {
  res.send(
    "<h1>Navegador Roku V3</h1><p>Servidor online.</p>"
  );
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "navegador-roku-v3-fixed"
  });
});


/* ROTA QUE JÁ FUNCIONAVA NA V2 */

app.get("/snapshot-image", async (req, res) => {
  const raw = String(req.query.url || "").trim();

  const url = validUrl(raw);

  if (!url) {
    return res.status(400).send("URL invalida");
  }

  let context;

  try {
    const result = await createPage();

    context = result.context;
    const page = result.page;

    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(1500);

    const image = await page.screenshot({
      type: "png",
      fullPage: false
    });

    sendImage(res, image);

  } catch (err) {
    console.error("snapshot error:", err);

    res.status(502).send(
      "Falha ao abrir pagina"
    );

  } finally {
    if (context) {
      try {
        await context.close();
      } catch {}
    }
  }
});


/* ABRIR PÁGINA PARA A V3 */

app.get("/v3/open", async (req, res) => {
  const id = String(
    req.query.session || ""
  ).trim();

  const raw = String(
    req.query.url || ""
  ).trim();

  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
    return res
      .status(400)
      .send("Sessao invalida");
  }

  const url = validUrl(raw);

  if (!url) {
    return res
      .status(400)
      .send("URL invalida");
  }

  try {

    if (sessions.has(id)) {
      try {
        await sessions
          .get(id)
          .context
          .close();
      } catch {}

      sessions.delete(id);
    }

    const result = await createPage();

    const context = result.context;
    const page = result.page;

    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(1500);

    sessions.set(id, {
      context,
      page,
      last: Date.now()
    });

    const image = await page.screenshot({
      type: "png",
      fullPage: false
    });

    sendImage(res, image);

  } catch (err) {

    console.error(
      "v3 open error:",
      err
    );

    res.status(502).send(
      "Falha ao abrir pagina"
    );
  }
});


/* CLIQUE DO CURSOR */

app.get("/v3/click", async (req, res) => {

  const id = String(
    req.query.session || ""
  ).trim();

  const x = Number(req.query.x);
  const y = Number(req.query.y);

  if (!sessions.has(id)) {
    return res
      .status(404)
      .send("Sessao nao encontrada");
  }

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1279 ||
    y < 0 ||
    y > 719
  ) {
    return res
      .status(400)
      .send("Coordenadas invalidas");
  }

  try {

    const session =
      sessions.get(id);

    session.last = Date.now();

    await session.page.mouse.click(
      x,
      y
    );

    await session.page.waitForTimeout(
      1200
    );

    const image =
      await session.page.screenshot({
        type: "png",
        fullPage: false
      });

    sendImage(res, image);

  } catch (err) {

    console.error(
      "click error:",
      err
    );

    res.status(502).send(
      "Falha no clique"
    );
  }
});


/* LIMPA SESSÕES ANTIGAS */

setInterval(async () => {

  const now = Date.now();

  for (
    const [id, session]
    of sessions
  ) {

    if (
      now - session.last >
      30 * 60 * 1000
    ) {

      try {
        await session
          .context
          .close();
      } catch {}

      sessions.delete(id);
    }
  }

}, 60000);


app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Navegador Roku V3 corrigido na porta " +
      PORT
    );
  }
);
