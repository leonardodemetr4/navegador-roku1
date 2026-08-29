const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

let browserPromise;
const sessions = new Map();


/* =========================================================
   CHROMIUM
========================================================= */

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
      "Chrome/131.0.0.0 Safari/537.36",

    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();

  page.setDefaultTimeout(20000);

  return {
    context,
    page
  };
}


/* =========================================================
   VALIDACAO
========================================================= */

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


/* =========================================================
   ESPERAR A PAGINA RENDERIZAR
========================================================= */

async function waitPageReady(page) {
  try {
    await page.waitForLoadState(
      "domcontentloaded",
      {
        timeout: 15000
      }
    );
  } catch {}


  try {
    await page.waitForLoadState(
      "networkidle",
      {
        timeout: 7000
      }
    );
  } catch {}


  try {
    await page.waitForFunction(
      () => {
        return (
          document.body &&
          document.body.innerText &&
          document.body.innerText.trim().length > 20
        );
      },
      {
        timeout: 5000
      }
    );
  } catch {}


  try {
    await page.evaluate(() => {
      const images =
        Array.from(
          document.images || []
        );

      return Promise.all(
        images
          .filter(img => !img.complete)
          .slice(0, 20)
          .map(img => {
            return new Promise(resolve => {
              const done = () => resolve();

              img.addEventListener(
                "load",
                done,
                {
                  once: true
                }
              );

              img.addEventListener(
                "error",
                done,
                {
                  once: true
                }
              );

              setTimeout(
                done,
                2500
              );
            });
          })
      );
    });
  } catch {}


  await page.waitForTimeout(1200);
}


/* =========================================================
   IMAGEM
========================================================= */

function sendImage(res, image) {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.set(
    "Pragma",
    "no-cache"
  );

  res.set(
    "Expires",
    "0"
  );

  res.set(
    "Surrogate-Control",
    "no-store"
  );

  res.type("png");

  res.send(image);
}


async function makeScreenshot(page, res) {
  await waitPageReady(page);

  const image =
    await page.screenshot({
      type: "png",
      fullPage: false
    });

  sendImage(
    res,
    image
  );
}


/* =========================================================
   INICIO
========================================================= */

app.get(
  "/",
  (_req, res) => {
    res.send(
      "<h1>Navegador Roku V5 Melhorado</h1>" +
      "<p>Servidor online.</p>"
    );
  }
);


app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
      service: "roku-browser-v5-render-fix"
    });
  }
);


/* =========================================================
   ABRIR PAGINA
========================================================= */

app.get(
  "/v5/open",
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


      await makeScreenshot(
        page,
        res
      );

    } catch (err) {
      console.error(
        "open error:",
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


/* =========================================================
   CLIQUE
========================================================= */

app.get(
  "/v5/click",
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
        "Clique recebido:",
        x,
        y
      );


      let clicked =
        false;


      try {
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
                bestDistance > 160
              ) {
                return {
                  found: false
                };
              }


              const link =
                best.tagName &&
                best.tagName
                  .toLowerCase() === "a"
                  ? best
                  : best.closest("a");


              if (
                link &&
                link.href
              ) {
                return {
                  found: true,
                  type: "link",
                  href: link.href,
                  distance:
                    Math.round(
                      bestDistance
                    )
                };
              }


              return {
                found: true,
                type: "click",
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
            await page.goto(
              linkUrl.toString(),
              {
                waitUntil:
                  "domcontentloaded",

                timeout:
                  30000
              }
            );

            clicked =
              true;
          }

        } else if (
          result.found
        ) {
          await page.mouse.click(
            x,
            y
          );

          clicked =
            true;
        }

      } catch (err) {
        console.log(
          "Clique especial falhou:",
          err.message
        );
      }


      if (!clicked) {
        try {
          await page.mouse.click(
            x,
            y
          );
        } catch {}
      }


      await page.waitForTimeout(
        700
      );


      console.log(
        "Pagina atual:",
        page.url()
      );


      await makeScreenshot(
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


/* =========================================================
   VOLTAR
========================================================= */

app.get(
  "/v5/back",
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
        "Voltou para:",
        page.url()
      );


      await makeScreenshot(
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


/* =========================================================
   AVANCAR
========================================================= */

app.get(
  "/v5/forward",
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
        .goForward({
          waitUntil:
            "domcontentloaded",

          timeout:
            15000
        })
        .catch(
          () => null
        );


      console.log(
        "Avancou para:",
        page.url()
      );


      await makeScreenshot(
        page,
        res
      );

    } catch (err) {
      console.error(
        "forward error:",
        err
      );


      res
        .status(502)
        .send(
          "Falha ao avancar"
        );
    }
  }
);


/* =========================================================
   ROLAGEM
========================================================= */

app.get(
  "/v5/scroll",
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


    if (!Number.isFinite(dy)) {
      dy = 700;
    }


    if (dy > 1500) {
      dy = 1500;
    }


    if (dy < -1500) {
      dy = -1500;
    }


    try {
      const session =
        sessions.get(id);


      const page =
        session.page;


      session.last =
        Date.now();


      await page.evaluate(
        amount => {
          window.scrollBy(
            0,
            amount
          );
        },
        dy
      );


      await page.waitForTimeout(
        350
      );


      console.log(
        "Rolagem:",
        dy
      );


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


/* =========================================================
   TOPO
========================================================= */

app.get(
  "/v5/top",
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


      session.last =
        Date.now();


      await session.page.evaluate(
        () => {
          window.scrollTo(
            0,
            0
          );
        }
      );


      await session.page.waitForTimeout(
        250
      );


      const image =
        await session.page.screenshot({
          type: "png",
          fullPage: false
        });


      sendImage(
        res,
        image
      );

    } catch (err) {
      console.error(
        "top error:",
        err
      );


      res
        .status(502)
        .send(
          "Falha ao ir para o topo"
        );
    }
  }
);


/* =========================================================
   FIM
========================================================= */

app.get(
  "/v5/bottom",
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


      session.last =
        Date.now();


      await session.page.evaluate(
        () => {
          window.scrollTo(
            0,
            document.documentElement.scrollHeight
          );
        }
      );


      await session.page.waitForTimeout(
        250
      );


      const image =
        await session.page.screenshot({
          type: "png",
          fullPage: false
        });


      sendImage(
        res,
        image
      );

    } catch (err) {
      console.error(
        "bottom error:",
        err
      );


      res
        .status(502)
        .send(
          "Falha ao ir para o final"
        );
    }
  }
);


/* =========================================================
   LIMPEZA DE SESSOES
========================================================= */

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


        sessions.delete(id);
      }
    }
  },
  60000
);


/* =========================================================
   SERVIDOR
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Navegador Roku V5 Melhorado iniciado na porta " +
      PORT
    );
  }
);
