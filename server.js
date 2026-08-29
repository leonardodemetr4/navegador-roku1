const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;

let browserPromise = null;
const sessions = new Map();

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }
  return browserPromise;
}

async function createSession() {
  const browser = await getBrowser();

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'pt-BR',
    ignoreHTTPSErrors: true,

    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',

    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    }
  });

  const page = await context.newPage();

  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);

  return {
    context,
    page,
    last: Date.now()
  };
}

function validSession(id) {
  return /^[A-Za-z0-9_-]{1,50}$/.test(id || '');
}

function validUrl(raw) {
  try {
    const url = new URL(raw);

    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function getSession(id) {
  if (!validSession(id)) {
    return null;
  }

  const session = sessions.get(id);

  if (!session) {
    return null;
  }

  session.last = Date.now();

  return session;
}

function sendPng(res, image) {
  res.set(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );

  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');

  res
    .status(200)
    .type('png')
    .send(image);
}

async function waitReady(page, delay = 500) {
  try {
    await page.waitForLoadState(
      'domcontentloaded',
      {
        timeout: 8000
      }
    );
  } catch {}

  try {
    await page.waitForLoadState(
      'networkidle',
      {
        timeout: 3500
      }
    );
  } catch {}

  if (delay > 0) {
    await page.waitForTimeout(delay);
  }
}

async function capture(
  page,
  res,
  delay = 500
) {
  await waitReady(
    page,
    delay
  );

  const image =
    await page.screenshot({
      type: 'png',
      fullPage: false
    });

  sendPng(
    res,
    image
  );
}

function escapeHtml(text) {
  return String(
    text || ''
  )
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#039;'
    );
}

async function showMessage(
  page,
  res,
  title,
  message
) {
  const html = `
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<style>

body {
  margin: 0;
  background: #071b2a;
  color: white;
  font-family: Arial, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
}

.box {
  width: 80%;
  padding: 40px;
  background: #0b2c40;
  border: 2px solid #20d9e8;
  border-radius: 12px;
}

h1 {
  color: #5eeaf2;
  font-size: 40px;
  margin: 0 0 20px;
}

p {
  font-size: 25px;
  line-height: 1.45;
  margin: 0 0 20px;
}

small {
  font-size: 19px;
  color: #a9dce5;
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
Use * para pesquisar ou digitar outro endereco.
</small>

</div>

</body>

</html>
`;

  try {
    await page.setContent(
      html,
      {
        waitUntil:
          'domcontentloaded'
      }
    );

    await page.waitForTimeout(
      150
    );

    const image =
      await page.screenshot({
        type: 'png',
        fullPage: false
      });

    sendPng(
      res,
      image
    );

  } catch (err) {
    console.error(
      'showMessage:',
      err.message
    );

    if (!res.headersSent) {
      res
        .status(200)
        .type('text/plain')
        .send(
          'Pagina indisponivel'
        );
    }
  }
}

function duckQueryFromUrl(raw) {
  try {
    const url =
      new URL(raw);

    if (
      !url.hostname
        .toLowerCase()
        .includes(
          'duckduckgo.com'
        )
    ) {
      return null;
    }

    const q =
      url.searchParams.get(
        'q'
      );

    return q && q.trim()
      ? q.trim()
      : null;

  } catch {
    return null;
  }
}

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
        'Endereco invalido.'
    };
  }

  try {
    console.log(
      'Abrindo:',
      url.toString()
    );

    await page.goto(
      url.toString(),
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          30000
      }
    );

    await waitReady(
      page,
      600
    );

    return {
      ok: true
    };

  } catch (err) {
    console.log(
      'Falha na primeira tentativa:',
      err.message
    );
  }

  const query =
    duckQueryFromUrl(
      url.toString()
    );

  if (query) {
    try {
      const fallback =
        'https://lite.duckduckgo.com/lite/?q=' +
        encodeURIComponent(
          query
        );

      console.log(
        'Tentando DuckDuckGo Lite:',
        fallback
      );

      await page.goto(
        fallback,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            25000
        }
      );

      await waitReady(
        page,
        700
      );

      return {
        ok: true
      };

    } catch (err) {
      console.log(
        'Fallback falhou:',
        err.message
      );
    }
  }

  try {
    const hasContent =
      await page.evaluate(
        () => {
          const text =
            document.body
              ? document.body.innerText.trim()
              : '';

          const images =
            document.images
              ? document.images.length
              : 0;

          return (
            text.length > 15 ||
            images > 0
          );
        }
      );

    if (hasContent) {
      return {
        ok: true
      };
    }

  } catch {}

  return {
    ok: false,

    reason:
      'O site demorou demais ou recusou a conexao.'
  };
}

app.get(
  '/',
  (_req, res) => {
    res.send(
      '<h1>Navegador Roku V5.1</h1>' +
      '<p>Servidor online.</p>'
    );
  }
);

app.get(
  '/health',
  (_req, res) => {
    res.json({
      ok: true,

      service:
        'navegador-roku-v5.1',

      sessions:
        sessions.size
    });
  }
);

app.get(
  '/v5/info',
  (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res.json({
        ok: false
      });
    }

    res.json({
      ok: true,
      url:
        session.page.url()
    });
  }
);

app.get(
  '/v5/open',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const rawUrl =
      String(
        req.query.url || ''
      ).trim();

    if (!validSession(id)) {
      return res
        .status(400)
        .send(
          'Sessao invalida'
        );
    }

    if (!validUrl(rawUrl)) {
      return res
        .status(400)
        .send(
          'URL invalida'
        );
    }

    let session;

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

      session =
        await createSession();

      sessions.set(
        id,
        session
      );

      const result =
        await navigateSafe(
          session.page,
          rawUrl
        );

      if (!result.ok) {
        return showMessage(
          session.page,
          res,
          'Pagina indisponivel',
          result.reason
        );
      }

      console.log(
        'Pagina atual:',
        session.page.url()
      );

      return capture(
        session.page,
        res,
        250
      );

    } catch (err) {
      console.error(
        '/v5/open:',
        err.message
      );

      if (
        session &&
        session.page
      ) {
        return showMessage(
          session.page,
          res,
          'Erro ao abrir',
          'Nao foi possivel carregar esta pagina agora.'
        );
      }

      return res
        .status(503)
        .send(
          'Servidor temporariamente indisponivel'
        );
    }
  }
);

app.get(
  '/v5/click',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res
        .status(404)
        .send(
          'Sessao nao encontrada'
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
      return res
        .status(400)
        .send(
          'Coordenadas invalidas'
        );
    }

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

    const page =
      session.page;

    try {
      console.log(
        'Cursor recebido:',
        px,
        py
      );

      const target =
        await page.evaluate(
          ({ x, y }) => {
            const selector =
              [
                'a',
                'button',
                'input',
                'textarea',
                'select',
                "[role='button']",
                "[role='link']",
                '[onclick]'
              ].join(',');

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
                style.display === 'none' ||
                style.visibility === 'hidden'
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
                found: false
              };
            }

            const anchor =
              best.tagName
                .toLowerCase() === 'a'
                ? best
                : best.closest(
                    'a'
                  );

            if (
              anchor &&
              anchor.href
            ) {
              return {
                found: true,

                type:
                  'link',

                href:
                  anchor.href,

                distance:
                  Math.round(
                    bestDistance
                  )
              };
            }

            return {
              found: true,

              type:
                'click',

              distance:
                Math.round(
                  bestDistance
                )
            };
          },
          {
            x: px,
            y: py
          }
        );

      console.log(
        'Resultado clique:',
        target
      );

      if (
        target.found &&
        target.type === 'link' &&
        target.href
      ) {
        const result =
          await navigateSafe(
            page,
            target.href
          );

        if (!result.ok) {
          return showMessage(
            page,
            res,
            'Link indisponivel',
            result.reason
          );
        }

      } else {
        try {
          await page.mouse.click(
            px,
            py
          );

          await page.waitForTimeout(
            600
          );

        } catch {}
      }

      console.log(
        'Pagina atual:',
        page.url()
      );

      return capture(
        page,
        res,
        300
      );

    } catch (err) {
      console.error(
        '/v5/click:',
        err.message
      );

      return showMessage(
        page,
        res,
        'Nao foi possivel clicar',
        'Mova o cursor um pouco e pressione OK novamente.'
      );
    }
  }
);

app.get(
  '/v5/back',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res
        .status(404)
        .send(
          'Sessao nao encontrada'
        );
    }

    try {
      await session.page
        .goBack({
          waitUntil:
            'domcontentloaded',

          timeout:
            15000
        })
        .catch(
          () => null
        );

      return capture(
        session.page,
        res,
        350
      );

    } catch (err) {
      console.error(
        '/v5/back:',
        err.message
      );

      return showMessage(
        session.page,
        res,
        'Nao foi possivel voltar',
        'Nao existe uma pagina anterior disponivel.'
      );
    }
  }
);

app.get(
  '/v5/forward',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res
        .status(404)
        .send(
          'Sessao nao encontrada'
        );
    }

    try {
      await session.page
        .goForward({
          waitUntil:
            'domcontentloaded',

          timeout:
            15000
        })
        .catch(
          () => null
        );

      return capture(
        session.page,
        res,
        350
      );

    } catch (err) {
      console.error(
        '/v5/forward:',
        err.message
      );

      return showMessage(
        session.page,
        res,
        'Nao foi possivel avancar',
        'Nao existe uma pagina seguinte disponivel.'
      );
    }
  }
);

app.get(
  '/v5/scroll',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res
        .status(404)
        .send(
          'Sessao nao encontrada'
        );
    }

    let dy =
      Number(
        req.query.dy
      );

    if (!Number.isFinite(dy)) {
      dy = 700;
    }

    dy =
      Math.max(
        -1500,
        Math.min(
          1500,
          dy
        )
      );

    try {
      await session.page.evaluate(
        amount => {
          window.scrollBy(
            0,
            amount
          );
        },
        dy
      );

      await session.page
        .waitForTimeout(
          250
        );

      const image =
        await session.page
          .screenshot({
            type:
              'png',

            fullPage:
              false
          });

      return sendPng(
        res,
        image
      );

    } catch (err) {
      console.error(
        '/v5/scroll:',
        err.message
      );

      return showMessage(
        session.page,
        res,
        'Erro na rolagem',
        'Nao foi possivel mover a pagina.'
      );
    }
  }
);

app.get(
  '/v5/top',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res
        .status(404)
        .send(
          'Sessao nao encontrada'
        );
    }

    try {
      await session.page
        .evaluate(
          () => window.scrollTo(
            0,
            0
          )
        );

      await session.page
        .waitForTimeout(
          200
        );

      const image =
        await session.page
          .screenshot({
            type:
              'png',

            fullPage:
              false
          });

      return sendPng(
        res,
        image
      );

    } catch (err) {
      console.error(
        '/v5/top:',
        err.message
      );

      return showMessage(
        session.page,
        res,
        'Erro',
        'Nao foi possivel ir para o topo.'
      );
    }
  }
);

app.get(
  '/v5/bottom',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res
        .status(404)
        .send(
          'Sessao nao encontrada'
        );
    }

    try {
      await session.page
        .evaluate(
          () => {
            const height =
              Math.max(
                document.body
                  ? document.body.scrollHeight
                  : 0,

                document.documentElement
                  ? document.documentElement.scrollHeight
                  : 0
              );

            window.scrollTo(
              0,
              height
            );
          }
        );

      await session.page
        .waitForTimeout(
          200
        );

      const image =
        await session.page
          .screenshot({
            type:
              'png',

            fullPage:
              false
          });

      return sendPng(
        res,
        image
      );

    } catch (err) {
      console.error(
        '/v5/bottom:',
        err.message
      );

      return showMessage(
        session.page,
        res,
        'Erro',
        'Nao foi possivel ir para o final.'
      );
    }
  }
);

setInterval(
  async () => {
    const now =
      Date.now();

    for (
      const [
        id,
        session
      ]
      of sessions
    ) {
      if (
        now -
        session.last >
        30 *
        60 *
        1000
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

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      'Navegador Roku V5.1 iniciado na porta ' +
      PORT
    );
  }
);
