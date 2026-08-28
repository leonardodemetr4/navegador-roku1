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
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browserPromise;
}

function validSession(id) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(id || "");
}

async function getPage(id) {
  if (sessions.has(id)) {
    const session = sessions.get(id);
    session.last = Date.now();
    return session.page;
  }

  const browser = await getBrowser();

  const context = await browser.newContext({
    viewport: {
      width: 1280,
      height: 720
    }
  });

  const page = await context.newPage();

  sessions.set(id, {
    context,
    page,
    last: Date.now()
  });

  return page;
}

function sendPng(res, buffer) {
  res.set("Cache-Control", "no-store");
  res.type("png").send(buffer);
}

app.get("/", (_req, res) => {
  res.send(
    "<h1>Navegador Roku V3</h1><p>Servidor online.</p>"
  );
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "navegador-roku-v3"
  });
});

app.get("/v3/open", async (req, res) => {
  try {
    const id = String(req.query.session || "");
    const raw = String(req.query.url || "");

    if (!validSession(id)) {
      return res.status(400).send("sessao invalida");
    }

    const url = new URL(raw);

    if (!["http:", "https:"].includes(url.protocol)) {
      return res.status(400).send("url invalida");
    }

    const page = await getPage(id);

    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(900);

    const image = await page.screenshot({
      type: "png",
      fullPage: false
    });

    sendPng(res, image);

  } catch (err) {
    console.error(err);
    res.status(502).send("falha ao abrir");
  }
});

app.get("/v3/click", async (req, res) => {
  try {
    const id = String(req.query.session || "");

    if (!validSession(id) || !sessions.has(id)) {
      return res
        .status(404)
        .send("sessao nao encontrada");
    }

    const x = Number(req.query.x);
    const y = Number(req.query.y);

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
        .send("coordenadas invalidas");
    }

    const session = sessions.get(id);

    session.last = Date.now();

    await session.page.mouse.click(x, y);

    await session.page.waitForTimeout(1000);

    const image = await session.page.screenshot({
      type: "png",
      fullPage: false
    });

    sendPng(res, image);

  } catch (err) {
    console.error(err);
    res.status(502).send("falha no clique");
  }
});

setInterval(async () => {
  const now = Date.now();

  for (const [id, session] of sessions) {
    if (now - session.last > 30 * 60 * 1000) {
      try {
        await session.context.close();
      } catch {}

      sessions.delete(id);
    }
  }
}, 60000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Navegador Roku V3 na porta " + PORT
  );
});
