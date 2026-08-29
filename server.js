const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;

let browserPromise = null;
const sessions = new Map();


/* =========================================================
   CHROMIUM
========================================================= */

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


/* =========================================================
   SESSAO
========================================================= */

async function createSession() {
  const browser = await getBrowser();

  const context = await browser.newContext({
    viewport: {
      width: 1280,
      height: 720
    },

    locale: 'pt-BR',

    ignoreHTTPSErrors: true,

    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',

    extraHTTPHeaders: {
      'Accept-Language':
        'pt-BR,pt;q=0.9,en;q=0.8'
    }
  });

  const page =
    await context.newPage();

  page.setDefaultTimeout(
    15000
  );

  page.setDefaultNavigationTimeout(
    30000
  );

  return {
    context,
    page,
    last: Date.now()
  };
}


function validSession(id) {
  return /^[A-Za-z0-9_-]{1,50}$/.test(
    id || ''
  );
}


function validUrl(raw) {
  try {
    const url =
      new URL(raw);

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

  const session =
    sessions.get(id);

  if (!session) {
    return null;
  }

  session.last =
    Date.now();

  return session;
}


async function replaceSession(id) {
  if (sessions.has(id)) {
    try {
      await sessions
        .get(id)
        .context
        .close();
    } catch {}

    sessions.delete(id);
  }

  const session =
    await createSession();

  sessions.set(
    id,
    session
  );

  return session;
}


/* =========================================================
   IMAGEM PARA ROKU
========================================================= */

function sendPng(res, image) {
  res.set(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );

  res.set(
    'Pragma',
    'no-cache'
  );

  res.set(
    'Expires',
    '0'
  );

  res.set(
    'Surrogate-Control',
    'no-store'
  );

  res
    .status(200)
    .type('png')
    .send(image);
}


async function waitReady(
  page,
  delay = 450
) {
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
    await page.waitForTimeout(
      delay
    );
  }
}


async function capture(
  page,
  res,
  delay = 450
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


/* =========================================================
   FUNCOES DE TEXTO
========================================================= */

function escapeHtml(value) {
  return String(
    value || ''
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


function decodeXml(value) {
  return String(
    value || ''
  )
    .replace(
      /<!\[CDATA\[(.*?)\]\]>/gs,
      '$1'
    )
    .replace(
      /&amp;/g,
      '&'
    )
    .replace(
      /&lt;/g,
      '<'
    )
    .replace(
      /&gt;/g,
      '>'
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&#x27;/g,
      "'"
    );
}


function stripTags(value) {
  return decodeXml(value)
    .replace(
      /<[^>]*>/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}


function tagValue(
  xml,
  tag
) {
  const match =
    xml.match(
      new RegExp(
        `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
        'i'
      )
    );

  return match
    ? stripTags(match[1])
    : '';
}


/* =========================================================
   PESQUISA
========================================================= */

async function searchWeb(query) {
  const searchUrl =
    'https://www.bing.com/search?format=rss&setlang=pt-BR&q=' +
    encodeURIComponent(query);

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      12000
    );

  try {
    const response =
      await fetch(
        searchUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) ' +
              'AppleWebKit/537.36 (KHTML, like Gecko) ' +
              'Chrome/131.0.0.0 Safari/537.36',

            'Accept-Language':
              'pt-BR,pt;q=0.9,en;q=0.8',

            'Accept':
              'application/rss+xml, application/xml, text/xml, */*'
          },

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        'Busca HTTP ' +
        response.status
      );
    }

    const xml =
      await response.text();

    const items =
      xml.match(
        /<item\b[\s\S]*?<\/item>/gi
      ) || [];

    const results = [];

    for (
      const item
      of items.slice(0, 10)
    ) {
      const title =
        tagValue(
          item,
          'title'
        );

      const link =
        tagValue(
          item,
          'link'
        );

      const description =
        tagValue(
          item,
          'description'
        );

      if (
        !title ||
        !validUrl(link)
      ) {
        continue;
      }

      results.push({
        title,
        link,
        description
      });
    }

    return results;

  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================
   PAGINA PROPRIA DOS RESULTADOS
========================================================= */

function searchHtml(
  query,
  results,
  errorText = ''
) {
  let cards = '';

  if (results.length > 0) {
    cards =
      results.map(
        (item, index) => {
          return `
<a
  class="result"
  href="${escapeHtml(item.link)}"
>

<div class="number">
${index + 1}
</div>

<div class="content">

<div class="title">
${escapeHtml(item.title)}
</div>

<div class="url">
${escapeHtml(item.link)}
</div>

<div class="desc">
${escapeHtml(
  item.description ||
  'Abrir resultado'
)}
</div>

</div>

</a>
`;
        }
      ).join('');

  } else {
    cards = `
<div class="empty">

<h2>
Nenhum resultado encontrado
</h2>

<p>
${escapeHtml(
  errorText ||
  'Tente pesquisar usando outras palavras.'
)}
</p>

</div>
`;
  }

  return `
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 26px 34px 60px;
  background: #f4f8fa;
  color: #16384a;
  font-family: Arial, Helvetica, sans-serif;
}

.header {
  background: #082a42;
  color: white;
  padding: 22px 28px;
  border-radius: 12px;
  margin-bottom: 22px;
  border-bottom: 4px solid #18c7d9;
}

.header h1 {
  font-size: 31px;
  margin: 0 0 8px;
}

.header p {
  margin: 0;
  font-size: 20px;
  color: #b9e9ee;
}

.result {
  display: flex;
  width: 100%;
  margin: 0 0 16px;
  padding: 20px 22px;
  text-decoration: none;
  background: white;
  color: #153b4c;
  border: 2px solid #d7e7ed;
  border-radius: 10px;
}

.result:hover,
.result:focus {
  border-color: #16bac9;
  background: #edfdfd;
}

.number {
  width: 48px;
  height: 48px;
  line-height: 48px;
  margin-right: 18px;
  text-align: center;
  background: #0e6e91;
  color: white;
  font-size: 22px;
  font-weight: bold;
  border-radius: 8px;
  flex: 0 0 48px;
}

.content {
  min-width: 0;
}

.title {
  font-size: 25px;
  font-weight: bold;
  margin-bottom: 7px;
  color: #075d79;
}

.url {
  font-size: 16px;
  color: #32808f;
  margin-bottom: 8px;
  overflow-wrap: anywhere;
}

.desc {
  font-size: 19px;
  line-height: 1.35;
  color: #435f69;
}

.empty {
  padding: 38px;
  background: white;
  border: 2px solid #d7e7ed;
  border-radius: 10px;
}

.empty h2 {
  font-size: 30px;
  margin-top: 0;
}

.empty p {
  font-size: 21px;
}

</style>

</head>

<body>

<div class="header">

<h1>
Resultados da pesquisa
</h1>

<p>
${escapeHtml(query)}
</p>

</div>

${cards}

</body>

</html>
`;
}


/* =========================================================
   PAGINA DE ERRO
========================================================= */

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

<style>

body {
  margin: 0;
  height: 100vh;
  background: #071b2a;
  color: white;
  font-family: Arial, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
}

.box {
  width: 80%;
  padding: 42px;
  background: #0b2c40;
  border: 2px solid #20d9e8;
  border-radius: 12px;
}

h1 {
  margin: 0 0 20px;
  color: #5eeaf2;
  font-size: 40px;
}

p {
  margin: 0 0 18px;
  font-size: 25px;
  line-height: 1.45;
}

small {
  color: #a9dce5;
  font-size: 19px;
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

  await page.setContent(
    html,
    {
      waitUntil:
        'domcontentloaded'
    }
  );

  return capture(
    page,
    res,
    100
  );
}


/* =========================================================
   ABRIR SITE
========================================================= */

async function navigateSafe(
  page,
  rawUrl
) {
  const url =
    validUrl(rawUrl);

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
      500
    );

    return {
      ok: true
    };

  } catch (error) {
    console.log(
      'Falha ao abrir:',
      error.message
    );

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
}


/* =========================================================
   PAGINA PRINCIPAL
========================================================= */

app.get(
  '/',
  (_req, res) => {
    res.send(
      '<h1>Navegador Roku V5.2</h1>' +
      '<p>Servidor online.</p>'
    );
  }
);


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  '/health',
  (_req, res) => {
    res.json({
      ok: true,
      service:
        'navegador-roku-v5.2',
      sessions:
        sessions.size
    });
  }
);


/* =========================================================
   ABRIR ENDERECO
========================================================= */

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
      session =
        await replaceSession(id);

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
        'Pagina aberta:',
        session.page.url()
      );

      return capture(
        session.page,
        res,
        250
      );

    } catch (error) {
      console.error(
        '/v5/open:',
        error.message
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


/* =========================================================
   PESQUISA PROPRIA
========================================================= */

app.get(
  '/v5/search',
  async (req, res) => {
    const id =
      String(
        req.query.session || ''
      ).trim();

    const query =
      String(
        req.query.q || ''
      ).trim();

    if (!validSession(id)) {
      return res
        .status(400)
        .send(
          'Sessao invalida'
        );
    }

    if (!query) {
      return res
        .status(400)
        .send(
          'Pesquisa vazia'
        );
    }

    let session;

    try {
      session =
        await replaceSession(id);

      let results = [];
      let errorText = '';

      try {
        console.log(
          'Pesquisando:',
          query
        );

        results =
          await searchWeb(
            query
          );

        console.log(
          'Resultados encontrados:',
          results.length
        );

      } catch (error) {
        console.error(
          '/v5/search fonte:',
          error.message
        );

        errorText =
          'A fonte de pesquisa nao respondeu. Tente novamente em alguns segundos.';
      }

      await session.page.setContent(
        searchHtml(
          query,
          results,
          errorText
        ),
        {
          waitUntil:
            'domcontentloaded'
        }
      );

      return capture(
        session.page,
        res,
        100
      );

    } catch (error) {
      console.error(
        '/v5/search:',
        error.message
      );

      if (
        session &&
        session.page
      ) {
        return showMessage(
          session.page,
          res,
          'Erro na pesquisa',
          'Nao foi possivel pesquisar agora. Tente novamente.'
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


/* =========================================================
   CLIQUE
========================================================= */

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
              bestDistance > 170
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
        console.log(
          'Ab
