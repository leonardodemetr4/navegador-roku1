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

function sendImage(res, image, pageUrl = "") {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  if (pageUrl) {
    res.set("X-Page-Url", pageUrl);
  }

  res.type("png");
  res.send(image);
}

async function screenshot(page, res) {
  await page.waitForTimeout(700);

  const image =
    await page.screenshot({
      type: "png",
      fullPage: false
    });

  sendImage(
    res,
    image,
    page.url()
  );
}


/* =========================
   INÍCIO
========================= */

app.get("/", (_req, res) => {
  res.send(
    "<h1>Navegador Roku V4.4</h1>" +
    "<p>Servidor Docker online.</p>"
  );
});


app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "navegador-roku-v4.4"
  });
});


/* =========================
   SNAPSHOT SIMPLES
========================= */

app.get(
  "/snapshot-image",
  async (req, res) => {

    const raw =
      String(
        req.query.url || ""
      ).trim();

    const url =
      validUrl(raw);

    if (!url) {
      return res
        .status(400)
        .send("URL invalida");
    }

    let context;

    try {

      const result =
        await createPage();

      context =
        result.context;

      const page =
        result.page;

      await page.goto(
        url.toString(),
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            30000
        }
      );

      await screenshot(
        page,
        res
      );

    } catch (err) {

      console.error(
        "snapshot error:",
        err
      );

      res
        .status(502)
        .send(
          "Falha ao abrir pagina"
        );

    } finally {

      if (context) {

        try {
          await context.close();
        } catch {}

      }
    }
  }
);


/* =========================
   ABRIR PÁGINA
========================= */

app.get(
  "/v3/open",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();

    const raw =
      String(
        req.query.url || ""
      ).trim();


    if (!validSession(id)) {

      return res
        .status(400)
        .send(
          "Sessao invalida"
        );
    }


    const url =
      validUrl(raw);


    if (!url) {

      return res
        .status(400)
        .send(
          "URL invalida"
        );
    }


    try {

      if (
        sessions.has(id)
      ) {

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
          waitUntil:
            "domcontentloaded",

          timeout:
            30000
        }
      );


      sessions.set(
        id,
        {
          context,
          page,
          last: Date.now()
        }
      );


      console.log(
        "Pagina aberta:",
        page.url()
      );


      await screenshot(
        page,
        res
      );


    } catch (err) {

      console.error(
        "v3 open error:",
        err
      );


      res
        .status(502)
        .send(
          "Falha ao abrir pagina"
        );
    }
  }
);


/* =========================
   CLIQUE
========================= */

app.get(
  "/v3/click",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    if (
      !validSession(id) ||
      !sessions.has(id)
    ) {

      return res
        .status(404)
        .send(
          "Sessao nao encontrada"
        );
    }


    const receivedX =
      Number(
        req.query.x
      );


    const receivedY =
      Number(
        req.query.y
      );


    if (
      !Number.isFinite(receivedX) ||
      !Number.isFinite(receivedY)
    ) {

      return res
        .status(400)
        .send(
          "Coordenadas invalidas"
        );
    }


    try {

      const session =
        sessions.get(id);


      const page =
        session.page;


      session.last =
        Date.now();


      const x =
        Math.max(
          0,
          Math.min(
            1279,
            Math.round(
              receivedX
            )
          )
        );


      const y =
        Math.max(
          0,
          Math.min(
            719,
            Math.round(
              receivedY
            )
          )
        );


      console.log(
        "Cursor recebido:",
        x,
        y
      );


      const result =
        await page.evaluate(
          ({ x, y }) => {

            const selector =
              [
                "a",
                "button",
                "input",
                "select",
                "textarea",
                "[role='button']",
                "[role='link']",
                "[onclick]"
              ].join(",");


            const elements =
              Array.from(
                document.querySelectorAll(
                  selector
                )
              );


            let best =
              null;


            let bestDistance =
              Infinity;


            for (
              const el
              of elements
            ) {

              const rect =
                el.getBoundingClientRect();


              if (
                rect.width <= 0 ||
                rect.height <= 0
              ) {
                continue;
              }


              const style =
                window.getComputedStyle(
                  el
                );


              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number(style.opacity) === 0
              ) {
                continue;
              }


              const nearestX =
                Math.max(
                  rect.left,
                  Math.min(
                    x,
                    rect.right
                  )
                );


              const nearestY =
                Math.max(
                  rect.top,
                  Math.min(
                    y,
                    rect.bottom
                  )
                );


              const dx =
                nearestX - x;


              const dy =
                nearestY - y;


              const distance =
                Math.sqrt(
                  dx * dx +
                  dy * dy
                );


              if (
                distance <
                bestDistance
              ) {

                bestDistance =
                  distance;


                best =
                  el;
              }
            }


            if (
              !best ||
              bestDistance > 180
            ) {

              return {
                found:
                  false
              };
            }


            const link =
              best.tagName &&
              best.tagName.toLowerCase() === "a"

                ? best

                : best.closest(
                    "a"
                  );


            if (
              link &&
              link.href
            ) {

              return {

                found:
                  true,

                type:
                  "link",

                href:
                  link.href,

                text:
                  (
                    link.innerText ||
                    ""
                  )
                  .trim()
                  .slice(
                    0,
                    100
                  ),

                distance:
                  Math.round(
                    bestDistance
                  )
              };
            }


            return {

              found:
                true,

              type:
                "click",

              distance:
                Math.round(
                  bestDistance
                )
            };

          },
          {
            x,
            y
          }
        );


      console.log(
        "Resultado clique:",
        result
      );


      if (
        result.found &&
        result.type === "link" &&
        result.href
      ) {

        const linkUrl =
          validUrl(
            result.href
          );


        if (linkUrl) {

          console.log(
            "Abrindo link:",
            linkUrl.toString()
          );


          await page.goto(
            linkUrl.toString(),
            {
              waitUntil:
                "domcontentloaded",

              timeout:
                30000
            }
          );
        }

      } else {

        await page.mouse.click(
          x,
          y
        );
      }


      console.log(
        "Pagina atual:",
        page.url()
      );


      await screenshot(
        page,
        res
      );


    } catch (err) {

      console.error(
        "click error:",
        err
      );


      res
        .status(502)
        .send(
          "Falha no clique"
        );
    }
  }
);


/* =========================
   VOLTAR
========================= */

app.get(
  "/v4/back",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    if (
      !validSession(id) ||
      !sessions.has(id)
    ) {

      return res
        .status(404)
        .send(
          "Sessao nao encontrada"
        );
    }


    try {

      const session =
        sessions.get(id);


      const page =
        session.page;


      session.last =
        Date.now();


      await page
        .goBack({
          waitUntil:
            "domcontentloaded",

          timeout:
            15000
        })
        .catch(
          () => null
        );


      console.log(
        "Voltar ->",
        page.url()
      );


      await screenshot(
        page,
        res
      );


    } catch (err) {

      console.error(
        "back error:",
        err
      );


      res
        .status(502)
        .send(
          "Falha ao voltar"
        );
    }
  }
);


/* =========================
   ROLAGEM
========================= */

app.get(
  "/v4/scroll",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    if (
      !validSession(id) ||
      !sessions.has(id)
    ) {

      return res
        .status(404)
        .send(
          "Sessao nao encontrada"
        );
    }


    let dy =
      Number(
        req.query.dy
      );


    if (
      !Number.isFinite(dy)
    ) {

      dy =
        430;
    }


    dy =
      Math.max(
        -1000,
        Math.min(
          1000,
          Math.round(
            dy
          )
        )
      );


    try {

      const session =
        sessions.get(id);


      const page =
        session.page;


      session.last =
        Date.now();


      await page.evaluate(
        (amount) => {

          window.scrollBy({
            top:
              amount,

            left:
              0,

            behavior:
              "instant"
          });

        },
        dy
      );


      console.log(
        "Scroll:",
        dy,
        "URL:",
        page.url()
      );


      await screenshot(
        page,
        res
      );


    } catch (err) {

      console.error(
        "scroll error:",
        err
      );


      res
        .status(502)
        .send(
          "Falha ao rolar"
        );
    }
  }
);


/* =========================
   LIMPEZA DE SESSÕES
========================= */

setInterval(
  async () => {

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


        sessions.delete(
          id
        );
      }
    }

  },
  60000
);


/* =========================
   INICIAR
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "Navegador Roku V4.4 iniciado na porta " +
      PORT
    );
  }
);
