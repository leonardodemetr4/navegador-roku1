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

function validSession(id) {
  return /^[A-Za-z0-9_-]{1,40}$/.test(id || "");
}

function sendImage(res, image) {
  res.set("Cache-Control", "no-store");
  res.type("png");
  res.send(image);
}


/* PÁGINA PRINCIPAL */

app.get("/", (_req, res) => {
  res.send(
    "<h1>Navegador Roku V4.1</h1>" +
    "<p>Servidor Docker online.</p>"
  );
});


/* TESTE */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "navegador-roku-v4-click-fixed"
  });
});


/* SNAPSHOT SIMPLES */

app.get("/snapshot-image", async (req, res) => {

  const raw =
    String(req.query.url || "").trim();

  const url = validUrl(raw);

  if (!url) {
    return res
      .status(400)
      .send("URL invalida");
  }

  let context;

  try {

    const result = await createPage();

    context = result.context;

    const page = result.page;

    await page.goto(
      url.toString(),
      {
        waitUntil: "domcontentloaded",
        timeout: 30000
      }
    );

    await page.waitForTimeout(1200);

    const image =
      await page.screenshot({
        type: "png",
        fullPage: false
      });

    sendImage(res, image);

  } catch (err) {

    console.error(
      "snapshot error:",
      err
    );

    res
      .status(502)
      .send("Falha ao abrir pagina");

  } finally {

    if (context) {
      try {
        await context.close();
      } catch {}
    }
  }
});


/* ABRE UMA PÁGINA E CRIA A SESSÃO */

app.get("/v3/open", async (req, res) => {

  const id =
    String(req.query.session || "").trim();

  const raw =
    String(req.query.url || "").trim();

  if (!validSession(id)) {
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

    const result =
      await createPage();

    const context =
      result.context;

    const page =
      result.page;

    await page.goto(
      url.toString(),
      {
        waitUntil: "domcontentloaded",
        timeout: 30000
      }
    );

    await page.waitForTimeout(1200);

    sessions.set(id, {
      context,
      page,
      last: Date.now()
    });

    const image =
      await page.screenshot({
        type: "png",
        fullPage: false
      });

    sendImage(res, image);

  } catch (err) {

    console.error(
      "v3 open error:",
      err
    );

    res
      .status(502)
      .send("Falha ao abrir pagina");
  }
});


/* CLIQUE CORRIGIDO PARA A V4.1 */

app.get("/v3/click", async (req, res) => {

  const id =
    String(req.query.session || "").trim();

  if (
    !validSession(id) ||
    !sessions.has(id)
  ) {
    return res
      .status(404)
      .send("Sessao nao encontrada");
  }

  const receivedX =
    Number(req.query.x);

  const receivedY =
    Number(req.query.y);

  if (
    !Number.isFinite(receivedX) ||
    !Number.isFinite(receivedY)
  ) {
    return res
      .status(400)
      .send("Coordenadas invalidas");
  }

  try {

    const session =
      sessions.get(id);

    const page =
      session.page;

    session.last =
      Date.now();


    /*
      CORREÇÃO V4.1

      A captura original é 1280x720.

      Na Roku ela entra numa área
      1210x505 usando scaleToFit.

      Isso cria aproximadamente
      156 pixels de margem lateral.

      Aqui convertemos novamente
      para a posição verdadeira
      da página Chromium.
    */

    let x =
      (
        receivedX * 1210 -
        156 * 1280
      ) / 898;

    let y =
      receivedY;


    x =
      Math.round(x);

    y =
      Math.round(y);


    if (x < 0) x = 0;
    if (x > 1279) x = 1279;

    if (y < 0) y = 0;
    if (y > 719) y = 719;


    console.log(
      "Clique recebido:",
      receivedX,
      receivedY,
      "-> corrigido:",
      x,
      y
    );


    /*
      Primeiro procura um link,
      botão ou outro elemento
      clicável exatamente no ponto.
    */

    const clickResult =
      await page.evaluate(
        ({ x, y }) => {

          let el =
            document.elementFromPoint(
              x,
              y
            );

          if (!el) {
            return false;
          }

          let current = el;

          for (
            let i = 0;
            i < 8 && current;
            i++
          ) {

            const tag =
              current.tagName
                ? current.tagName.toLowerCase()
                : "";

            const role =
              current.getAttribute
                ? current.getAttribute("role")
                : null;

            const clickable =
              tag === "a" ||
              tag === "button" ||
              tag === "input" ||
              role === "button" ||
              role === "link" ||
              typeof current.onclick === "function";

            if (clickable) {

              current.click();

              return true;
            }

            current =
              current.parentElement;
          }

          return false;

        },
        { x, y }
      );


    /*
      Se não encontrou um elemento
      clicável, faz clique físico.
    */

    if (!clickResult) {

      await page.mouse.click(
        x,
        y
      );
    }


    /*
      Espera a navegação,
      JavaScript ou atualização.
    */

    await page.waitForTimeout(1500);


    const image =
      await page.screenshot({
        type: "png",
        fullPage: false
      });


    sendImage(
      res,
      image
    );

  } catch (err) {

    console.error(
      "click error:",
      err
    );

    res
      .status(502)
      .send("Falha no clique");
  }
});


/* LIMPA SESSÕES ANTIGAS */

setInterval(async () => {

  const now =
    Date.now();

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
      "Navegador Roku V4 clique corrigido na porta " +
      PORT
    );
  }
);
