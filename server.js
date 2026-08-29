const express = require("express");
const { chromium } = require("playwright");

const app = express();

const PORT =
  process.env.PORT || 10000;

let browserPromise = null;

const sessions =
  new Map();


/* =========================================================
   CONFIGURACAO DO CHROMIUM
========================================================= */

async function getBrowser() {

  if (!browserPromise) {

    browserPromise =
      chromium.launch({
        headless: true,

        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-extensions"
        ]
      });

  }

  return browserPromise;
}


/* =========================================================
   CRIAR PAGINA
========================================================= */

async function createPage() {

  const browser =
    await getBrowser();

  const context =
    await browser.newContext({

      viewport: {
        width: 1280,
        height: 720
      },

      screen: {
        width: 1280,
        height: 720
      },

      locale:
        "pt-BR",

      timezoneId:
        "America/Sao_Paulo",

      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 " +
        "(KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",

      ignoreHTTPSErrors:
        true,

      extraHTTPHeaders: {
        "Accept-Language":
          "pt-BR,pt;q=0.9,en;q=0.8"
      }

    });


  const page =
    await context.newPage();


  page.setDefaultTimeout(
    20000
  );


  page.setDefaultNavigationTimeout(
    30000
  );


  return {
    context,
    page
  };
}


/* =========================================================
   VALIDAR URL
========================================================= */

function validUrl(raw) {

  try {

    const url =
      new URL(raw);


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


/* =========================================================
   VALIDAR SESSAO
========================================================= */

function validSession(id) {

  return /^[A-Za-z0-9_-]{1,50}$/.test(
    id || ""
  );
}


/* =========================================================
   CABECALHOS DA IMAGEM
========================================================= */

function sendImage(
  res,
  image
) {

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

  res.type(
    "png"
  );

  res.status(200);

  res.send(
    image
  );
}


/* =========================================================
   ESPERAR PAGINA
========================================================= */

async function waitPageReady(
  page,
  extraDelay = 700
) {

  try {

    await page.waitForLoadState(
      "domcontentloaded",
      {
        timeout: 10000
      }
    );

  } catch {}


  try {

    await page.waitForLoadState(
      "networkidle",
      {
        timeout: 4500
      }
    );

  } catch {}


  try {

    await page.waitForFunction(
      () => {

        return (
          document.body &&
          document.body.innerText &&
          document.body.innerText.trim().length > 10
        );

      },
      {
        timeout: 4000
      }
    );

  } catch {}


  try {

    await page.evaluate(
      async () => {

        if (
          document.fonts &&
          document.fonts.ready
        ) {

          await document.fonts.ready;

        }

      }
    );

  } catch {}


  if (
    extraDelay > 0
  ) {

    await page.waitForTimeout(
      extraDelay
    );

  }

}


/* =========================================================
   TIRAR SCREENSHOT
========================================================= */

async function screenshot(
  page,
  res,
  delay = 700
) {

  await waitPageReady(
    page,
    delay
  );


  const image =
    await page.screenshot({

      type:
        "png",

      fullPage:
        false

    });


  sendImage(
    res,
    image
  );
}


/* =========================================================
   MOSTRAR PAGINA DE ERRO
========================================================= */

async function showMessage(
  page,
  res,
  title,
  message
) {

  try {

    await page.setContent(
      `
      <!DOCTYPE html>

      <html>

      <head>

      <meta charset="UTF-8">

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
      >

      <style>

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        width: 100vw;
        height: 100vh;
        background:
          linear-gradient(
            135deg,
            #071b2a,
            #0b3952
          );
        font-family:
          Arial,
          Helvetica,
          sans-serif;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .box {
        width: 80%;
        max-width: 900px;
        padding: 45px;
        background:
          rgba(
            5,
            28,
            44,
            0.94
          );
        border:
          2px solid #20d9e8;
        border-radius:
          12px;
      }

      h1 {
        margin-top: 0;
        color: #5eeaf2;
        font-size: 40px;
      }

      p {
        font-size: 25px;
        line-height: 1.5;
        color: #e8f7fa;
      }

      small {
        font-size: 19px;
        color: #9bcbd6;
      }

      </style>

      </head>

      <body>

      <div class="box">

      <h1>
        ${escapeHtml(title)}
      </h1>

      <p>
        ${escapeHtml(message)}
      </p>

      <small>
        Use * para tentar outra pesquisa ou endereco.
      </small>

      </div>

      </body>

      </html>
      `,
      {
        waitUntil:
          "domcontentloaded"
      }
    );


    await page.waitForTimeout(
      200
    );


    const image =
      await page.screenshot({
        type:
          "png",

        fullPage:
          false
      });


    sendImage(
      res,
      image
    );

  } catch (error) {

    console.error(
      "Erro ao montar mensagem:",
      error
    );


    if (
      !res.headersSent
    ) {

      res.status(200)
        .type("text/plain")
        .send(
          "Pagina indisponivel"
        );

    }

  }

}


/* =========================================================
   ESCAPAR HTML
========================================================= */

function escapeHtml(value) {

  return String(
    value || ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


/* =========================================================
   EXTRAIR PESQUISA DUCKDUCKGO
========================================================= */

function getDuckQuery(
  rawUrl
) {

  try {

    const url =
      new URL(
        rawUrl
      );


    const host =
      url.hostname
        .toLowerCase();


    if (
      host.includes(
        "duckduckgo.com"
      )
    ) {

      const q =
        url.searchParams.get(
          "q"
        );


      if (
        q &&
        q.trim() !== ""
      ) {

        return q.trim();
      }

    }

  } catch {}


  return null;
}


/* =========================================================
   ABRIR URL COM FALLBACK
========================================================= */

async function navigateSafe(
  page,
  rawUrl
) {

  const url =
    validUrl(
      rawUrl
    );


  if (!url) {

    return {
      ok: false,
      reason:
        "Endereco invalido"
    };

  }


  const duckQuery =
    getDuckQuery(
      url.toString()
    );


  try {

    console.log(
      "Abrindo:",
      url.toString()
    );


    await page.goto(
      url.toString(),
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          30000
      }
    );


    await waitPageReady(
      page,
      duckQuery
        ? 900
        : 600
    );


    return {
      ok: true,
      url:
        page.url()
    };

  } catch (error) {

    console.log(
      "Primeira tentativa falhou:",
      error.message
    );

  }


  /*
     Se DuckDuckGo HTML falhar,
     tenta a versao Lite.
  */

  if (duckQuery) {

    try {

      const fallback =
        "https://lite.duckduckgo.com/lite/?q=" +
        encodeURIComponent(
          duckQuery
        );


      console.log(
        "Tentando busca alternativa:",
        fallback
      );


      await page.goto(
        fallback,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            25000
        }
      );


      await waitPageReady(
        page,
        900
      );


      return {
        ok: true,
        url:
          page.url(),
        fallback:
          true
      };

    } catch (error) {

      console.log(
        "DuckDuckGo Lite falhou:",
        error.message
      );

    }

  }


  /*
     Algumas paginas geram timeout,
     mas mesmo assim carregam conteúdo.
     Se o body tiver texto, usamos a pagina.
  */

  try {

    const contentExists =
      await page.evaluate(
        () => {

          return Boolean(
            document.body &&
            (
              document.body.innerText.trim().length > 15 ||
              document.images.length > 0
            )
          );

        }
      );


    if (contentExists) {

      return {
        ok: true,
        partial:
          true,
        url:
          page.url()
      };

    }

  } catch {}


  return {
    ok: false,
    reason:
      "Nao foi possivel abrir esta pagina."
  };
}


/* =========================================================
   PEGAR SESSAO
========================================================= */

function getSession(
  id
) {

  if (
    !validSession(id)
  ) {

    return null;
  }


  if (
    !sessions.has(id)
  ) {

    return null;
  }


  const session =
    sessions.get(id);


  session.last =
    Date.now();


  return session;
}


/* =========================================================
   PAGINA INICIAL DO SERVIDOR
========================================================= */

app.get(
  "/",
  (_req, res) => {

    res.send(
      `
      <h1>
        Navegador Roku V5.1
      </h1>

      <p>
        Servidor online.
      </p>
      `
    );

  }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (_req, res) => {

    res.json({
      ok:
        true,

      service:
        "navegador-roku-v5.1",

      sessions:
        sessions.size

    });

  }
);


/* =========================================================
   V5 INFO
========================================================= */

app.get(
  "/v5/info",
  (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    const session =
      getSession(
        id
      );


    if (!session) {

      return res.json({
        ok:
          false
      });

    }


    res.json({

      ok:
        true,

      url:
        session.page.url()

    });

  }
);


/* =========================================================
   V5 OPEN
========================================================= */

app.get(
  "/v5/open",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    const rawUrl =
      String(
        req.query.url || ""
      ).trim();


    if (
      !validSession(id)
    ) {

      return res.status(400)
        .send(
          "Sessao invalida"
        );

    }


    const url =
      validUrl(
        rawUrl
      );


    if (!url) {

      return res.status(400)
        .send(
          "URL invalida"
        );

    }


    let context = null;
    let page = null;


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


        sessions.delete(
          id
        );

      }


      const created =
        await createPage();


      context =
        created.context;


      page =
        created.page;


      sessions.set(
        id,
        {
          context,
          page,
          last:
            Date.now()
        }
      );


      const result =
        await navigateSafe(
          page,
          url.toString()
        );


      if (!result.ok) {

        console.log(
          "Falha ao abrir:",
          url.toString()
        );


        return await showMessage(
          page,
          res,
          "Pagina indisponivel",
          result.reason
        );

      }


      console.log(
        "Pagina atual:",
        page.url()
      );


      return await screenshot(
        page,
        res,
        300
      );

    } catch (error) {

      console.error(
        "Erro /v5/open:",
        error
      );


      if (page) {

        return await showMessage(
          page,
          res,
          "Erro ao abrir",
          "O site demorou demais ou recusou a conexao. Tente novamente ou pesquise outro endereco."
        );

      }


      /*
         Somente se nem o Chromium tiver conseguido iniciar.
      */

      return res.status(503)
        .send(
          "Servidor temporariamente indisponivel"
        );

    }

  }
);


/* =========================================================
   V5 CLICK
========================================================= */

app.get(
  "/v5/click",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    const session =
      getSession(
        id
      );


    if (!session) {

      return res.status(404)
        .send(
          "Sessao nao encontrada"
        );

    }


    const x =
      Number(
        req.query.x
      );


    const y =
      Number(
        req.query.y
      );


    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {

      return res.status(400)
        .send(
          "Coordenadas invalidas"
        );

    }


    const page =
      session.page;


    const px =
      Math.max(
        0,
        Math.min(
          1279,
          Math.round(x)
        )
      );


    const py =
      Math.max(
        0,
        Math.min(
          719,
          Math.round(y)
        )
      );


    try {

      console.log(
        "Cursor recebido:",
        px,
        py
      );


      const target =
        await page.evaluate(
          ({ x, y }) => {

            const selectors =
              [
                "a",
                "button",
                "input",
                "textarea",
                "select",
                "[role='button']",
                "[role='link']",
                "[onclick]"
              ];


            const elements =
              Array.from(
                document.querySelectorAll(
                  selectors.join(",")
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
                rect.width <= 1 ||
                rect.height <= 1
              ) {

                continue;
              }


              const style =
                getComputedStyle(
                  el
                );


              if (
                style.display === "none" ||
                style.visibility === "hidden"
              ) {

                continue;
              }


              const nx =
                Math.max(
                  rect.left,
                  Math.min(
                    x,
                    rect.right
                  )
                );


              const ny =
                Math.max(
                  rect.top,
                  Math.min(
                    y,
                    rect.bottom
                  )
                );


              const dx =
                nx - x;


              const dy =
                ny - y;


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
                found:
                  false
              };

            }


            const anchor =
              best.tagName
                .toLowerCase() === "a"
                ? best
                : best.closest("a");


            if (
              anchor &&
              anchor.href
            ) {

              return {

                found:
                  true,

                type:
                  "link",

                href:
                  anchor.href,

                text:
                  (
                    anchor.innerText ||
                    anchor.textContent ||
                    ""
                  )
                    .trim()
                    .slice(
                      0,
                      120
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
            x:
              px,
            y:
              py
          }
        );


      console.log(
        "Resultado clique:",
        target
      );


      if (
        target.found &&
        target.type === "link" &&
        target.href
      ) {

        const targetUrl =
          validUrl(
            target.href
          );


        if (targetUrl) {

          console.log(
            "Abrindo link:",
            targetUrl.toString()
          );


          const result =
            await navigateSafe(
              page,
              targetUrl.toString()
            );


          if (!result.ok) {

            return await showMessage(
              page,
              res,
              "Link indisponivel",
              result.reason
            );

          }

        }

      } else {

        try {

          await page.mouse.click(
            px,
            py
          );


          await page.waitForTimeout(
            700
          );

        } catch {}

      }


      console.log(
        "Pagina atual:",
        page.url()
      );


      return await screenshot(
        page,
        res,
        400
      );

    } catch (error) {

      console.error(
        "Erro /v5/click:",
        error
      );


      return await showMessage(
        page,
        res,
        "Nao foi possivel clicar",
        "Tente mover o cursor um pouco e pressione OK novamente."
      );

    }

  }
);


/* =========================================================
   V5 BACK
========================================================= */

app.get(
  "/v5/back",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    const session =
      getSession(
        id
      );


    if (!session) {

      return res.status(404)
        .send(
          "Sessao nao encontrada"
        );

    }


    const page =
      session.page;


    try {

      await page.goBack({
        waitUntil:
          "domcontentloaded",

        timeout:
          15000
      })
        .catch(
          () => null
        );


      await waitPageReady(
        page,
        500
      );


      console.log(
        "Voltou para:",
        page.url()
      );


      return await screenshot(
        page,
        res,
        200
      );

    } catch (error) {

      console.error(
        "Erro back:",
        error
      );


      return await showMessage(
        page,
        res,
        "Nao foi possivel voltar",
        "Nao existe uma pagina anterior disponivel."
      );

    }

  }
);


/* =========================================================
   V5 FORWARD
========================================================= */

app.get(
  "/v5/forward",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    const session =
      getSession(
        id
      );


    if (!session) {

      return res.status(404)
        .send(
          "Sessao nao encontrada"
        );

    }


    const page =
      session.page;


    try {

      await page.goForward({
        waitUntil:
          "domcontentloaded",

        timeout:
          15000
      })
        .catch(
          () => null
        );


      await waitPageReady(
        page,
        500
      );


      console.log(
        "Avancou para:",
        page.url()
      );


      return await screenshot(
        page,
        res,
        200
      );

    } catch (error) {

      console.error(
        "Erro forward:",
        error
      );


      return await showMessage(
        page,
        res,
        "Nao foi possivel avancar",
        "Nao existe uma pagina seguinte disponivel."
      );

    }

  }
);


/* =========================================================
   V5 SCROLL
========================================================= */

app.get(
  "/v5/scroll",
  async (req, res) => {

    const id =
      String(
        req.query.session || ""
      ).trim();


    const session =
      getSession(
        id
      );


    if (!session) {

      return res.status(404)
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
        700;

    }


    if (
      dy > 1500
    ) {

      dy =
        1500;

    }


    if (
      dy < -1500
    ) {

      dy =
        -1500;

    }


    const page =
      session.page;


    try {

      await page.evaluate(
        amount => {

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


      await page.waitForTimeout(
        300
      );


      const image =
        await page.screenshot({
          type:
            "png",

          fullPage:
            false
        });


      return sendImage(
        res,
        image
      );

    } catch (error) {

      console.error(
        "Erro scroll:",
        error
      );


      return await showMessage(
        page,
        res,
        "Erro na
