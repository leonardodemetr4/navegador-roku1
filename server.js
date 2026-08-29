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
        "--disable-gpu",
        "--disable-features=IsolateOrigins,site-per-process"
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

  return /^[A-Za-z0-9_-]{1,40}$/.test(
    id || ""
  );

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

  await page.waitForTimeout(180);

  const image = await page.screenshot({
    type: "png",
    fullPage: false
  });

  sendImage(
    res,
    image
  );

}


/* =========================================================
   INFORMACOES DA PAGINA
========================================================= */

async function getPageInfo(page) {

  let title = "";

  try {

    title = await page.title();

  } catch {}


  let scrollInfo = {
    top: 0,
    height: 720,
    viewport: 720
  };


  try {

    scrollInfo = await page.evaluate(() => {

      return {

        top:
          Math.round(
            window.scrollY ||
            document.documentElement.scrollTop ||
            0
          ),

        height:
          Math.max(
            document.body.scrollHeight || 0,
            document.documentElement.scrollHeight || 0
          ),

        viewport:
          window.innerHeight || 720

      };

    });

  } catch {}


  return {

    ok: true,

    url:
      page.url(),

    title:
      title || "Pagina",

    scrollTop:
      scrollInfo.top,

    scrollHeight:
      scrollInfo.height,

    viewportHeight:
      scrollInfo.viewport

  };

}


/* =========================================================
   INICIO
========================================================= */

app.get("/", (_req, res) => {

  res.send(
    "<html>" +
    "<head><title>Navegador Roku V5</title></head>" +
    "<body style='font-family:Arial;background:#071a2d;color:white;padding:40px'>" +
    "<h1>Navegador Roku V5</h1>" +
    "<p>Servidor online.</p>" +
    "</body>" +
    "</html>"
  );

});


app.get("/health", (_req, res) => {

  res.json({

    ok: true,

    service:
      "roku-browser-v5"

  });

});


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

          last:
            Date.now()

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
   INFORMACOES
========================================================= */

app.get(
  "/v5/info",
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
        .json({
          ok: false
        });

    }


    try {

      const session =
        sessions.get(id);


      session.last =
        Date.now();


      const info =
        await getPageInfo(
          session.page
        );


      res.set(
        "Cache-Control",
        "no-store"
      );


      res.json(
        info
      );

    } catch (err) {

      console.error(
        "info error:",
        err
      );


      res
        .status(500)
        .json({
          ok: false
        });

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
        "Clique:",
        x,
        y
      );


      const target =
        await page.evaluate(
          ({ x, y }) => {

            const elements =
              document.elementsFromPoint(
                x,
                y
              );


            for (
              const element
              of elements
            ) {

              const clickable =
                element.closest(
                  [
                    "a",
                    "button",
                    "input",
                    "select",
                    "textarea",
                    "[role='button']",
                    "[role='link']",
                    "[onclick]"
                  ].join(",")
                );


              if (clickable) {

                const link =
                  clickable.closest(
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
                      link.href

                  };

                }


                return {

                  found:
                    true,

                  type:
                    "element"

                };

              }

            }


            return {
              found: false
            };

          },
          {
            x,
            y
          }
        );


      if (
        target.found &&
        target.type === "link" &&
        target.href
      ) {

        const linkUrl =
          validUrl(
            target.href
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

        }

      } else {

        try {

          await page.mouse.click(
            x,
            y
          );


          await page.waitForTimeout(
            300
          );

        } catch {}

      }


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

      dy = 650;

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
        (amount) => {

          window.scrollBy({
            top: amount,
            left: 0,
            behavior: "auto"
          });

        },
        dy
      );


      await page.waitForTimeout(
        100
      );


      await makeScreenshot(
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


      await makeScreenshot(
        session.page,
        res
      );

    } catch {

      res
        .status(502)
        .send(
          "Falha"
        );

    }

  }
);


/* =========================================================
   FIM DA PAGINA
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


      await makeScreenshot(
        session.page,
        res
      );

    } catch {

      res
        .status(502)
        .send(
          "Falha"
        );

    }

  }
);


/* =========================================================
   LIMPEZA
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


        sessions.delete(
          id
        );

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
      "Navegador Roku V5 iniciado na porta " +
      PORT
    );

  }
);
