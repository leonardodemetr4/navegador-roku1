const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

let browser = null;
const sessions = new Map();

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }

  return browser;
}

function validSession(id) {
  return /^[A-Za-z0-9_-]{1,50}$/.test(id || "");
}

function validUrl(text) {
  try {
    const url = new URL(text);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

async function newSession(id) {
  const old = sessions.get(id);

  if (old) {
    try {
      await old.context.close();
    } catch {}
  }

  const b = await getBrowser();

  const context = await b.newContext({
    viewport: {
      width: 1280,
      height: 720
    },

    locale: "pt-BR",

    ignoreHTTPSErrors: true,

    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) " +
      "AppleWebKit/537.36 " +
      "(KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();

  page.setDefaultTimeout(15000);

  page.setDefaultNavigationTimeout(30000);

  const session = {
    context: context,
    page: page,
    last: Date.now()
  };

  sessions.set(id, session);

  return session;
}

function getSession(id) {
  const session = sessions.get(id);

  if (!session) {
    return null;
  }

  session.last = Date.now();

  return session;
}

function sendImage(res, image) {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  res.set(
    "Pragma",
    "no-cache"
  );

  res.set(
    "Expires",
    "0"
  );

  res
    .status(200)
    .type("png")
    .send(image);
}

async function screenshot(page, res) {
  await page.waitForTimeout(300);

  const image = await page.screenshot({
    type: "png",
    fullPage: false
  });

  sendImage(res, image);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function openUrl(page, url) {
  const safe = validUrl(url);

  if (!safe) {
    return false;
  }

  try {
    console.log("Abrindo:", safe);

    await page.goto(safe, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(700);

    return true;
  } catch (error) {
    console.log(
      "Erro ao abrir:",
      error.message
    );

    try {
      const content = await page.evaluate(() => {
        if (!document.body) {
          return false;
        }

        return (
          document.body.innerText.trim().length > 10 ||
          document.images.length > 0
        );
      });

      return content;
    } catch {
      return false;
    }
  }
}

async function messagePage(
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
  background: #071b2a;
  color: white;
  font-family: Arial, sans-serif;
}

.box {
  margin: 120px auto;
  width: 80%;
  padding: 40px;
  background: #0b2c40;
  border: 3px solid #18c7d9;
  border-radius: 15px;
}

h1 {
  color: #5eeaf2;
  font-size: 40px;
}

p {
  font-size: 25px;
  line-height: 1.5;
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

</div>

</body>

</html>
`;

  await page.setContent(html);

  return screenshot(
    page,
    res
  );
}


/* =========================
   PESQUISA
========================= */

async function searchWeb(query) {
  const url =
    "https://www.bing.com/search" +
    "?format=rss&q=" +
    encodeURIComponent(query);

  const response = await fetch(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 Chrome/131 Safari/537.36",

        "Accept":
          "application/rss+xml,text/xml,*/*"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      "Busca HTTP " +
      response.status
    );
  }

  const xml =
    await response.text();

  const items =
    xml.match(
      /<item[\s\S]*?<\/item>/gi
    ) || [];

  const results = [];

  for (const item of items.slice(0, 10)) {
    const titleMatch =
      item.match(
        /<title>([\s\S]*?)<\/title>/i
      );

    const linkMatch =
      item.match(
        /<link>([\s\S]*?)<\/link>/i
      );

    const descMatch =
      item.match(
        /<description>([\s\S]*?)<\/description>/i
      );

    if (
      !titleMatch ||
      !linkMatch
    ) {
      continue;
    }

    let title =
      titleMatch[1];

    let link =
      linkMatch[1];

    let description =
      descMatch
        ? descMatch[1]
        : "";

    title = title
      .replace(/<!CDATA\[|\]>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&");

    link = link
      .replace(/<!CDATA\[|\]>/g, "")
      .replace(/&amp;/g, "&")
      .trim();

    description = description
      .replace(/<!CDATA\[|\]>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();

    if (!validUrl(link)) {
      continue;
    }

    results.push({
      title: title,
      link: link,
      description: description
    });
  }

  return results;
}

function resultsPage(
  query,
  results
) {
  let content = "";

  if (results.length === 0) {
    content = `
<div class="empty">

<h2>
Nenhum resultado encontrado
</h2>

<p>
Tente pesquisar outras palavras.
</p>

</div>
`;
  } else {
    results.forEach(
      (item, index) => {
        content += `
<a
  class="result"
  href="${escapeHtml(item.link)}"
>

<div class="number">
${index + 1}
</div>

<div>

<div class="title">
${escapeHtml(item.title)}
</div>

<div class="url">
${escapeHtml(item.link)}
</div>

<div class="description">
${escapeHtml(item.description)}
</div>

</div>

</a>
`;
      }
    );
  }

  return `
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 25px 35px 60px;
  background: #f3f8fa;
  font-family: Arial, sans-serif;
  color: #17394a;
}

.header {
  background: #082a42;
  border-bottom: 5px solid #18c7d9;
  color: white;
  padding: 22px 28px;
  margin-bottom: 20px;
  border-radius: 12px;
}

.header h1 {
  margin: 0 0 8px;
  font-size: 32px;
}

.header p {
  margin: 0;
  font-size: 21px;
  color: #b9e9ee;
}

.result {
  display: flex;
  background: white;
  color: #17394a;
  text-decoration: none;
  padding: 18px;
  margin-bottom: 15px;
  border: 2px solid #d6e6eb;
  border-radius: 10px;
}

.number {
  width: 48px;
  height: 48px;
  min-width: 48px;
  line-height: 48px;
  text-align: center;
  background: #0e6e91;
  color: white;
  font-size: 22px;
  font-weight: bold;
  border-radius: 8px;
  margin-right: 18px;
}

.title {
  font-size: 25px;
  font-weight: bold;
  color: #075d79;
  margin-bottom: 6px;
}

.url {
  font-size: 16px;
  color: #23808f;
  margin-bottom: 7px;
}

.description {
  font-size: 19px;
  line-height: 1.3;
  color: #435f69;
}

.empty {
  background: white;
  padding: 35px;
  border-radius: 12px;
  font-size: 22px;
}

</style>

</head>

<body>

<div class="header">

<h1>
Pesquisa
</h1>

<p>
${escapeHtml(query)}
</p>

</div>

${content}

</body>

</html>
`;
}


/* =========================
   SERVIDOR ONLINE
========================= */

app.get(
  "/",
  (req, res) => {
    res.send(
      "<h1>Navegador Roku V5.2</h1>" +
      "<p>Servidor online</p>"
    );
  }
);


/* =========================
   HEALTH CHECK
========================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "roku-v5.2"
    });
  }
);


/* =========================
   ABRIR SITE
========================= */

app.get(
  "/v5/open",
  async (req, res) => {
    const id =
      String(
        req.query.session || ""
      ).trim();

    const url =
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

    if (!validUrl(url)) {
      return res
        .status(400)
        .send(
          "URL invalida"
        );
    }

    try {
      const session =
        await newSession(id);

      const ok =
        await openUrl(
          session.page,
          url
        );

      if (!ok) {
        return messagePage(
          session.page,
          res,
          "Pagina indisponivel",
          "O site nao respondeu."
        );
      }

      return screenshot(
        session.page,
        res
      );

    } catch (error) {
      console.error(
        "OPEN:",
        error
      );

      return res
        .status(500)
        .send(
          "Erro interno"
        );
    }
  }
);


/* =========================
   PESQUISAR
========================= */

app.get(
  "/v5/search",
  async (req, res) => {
    const id =
      String(
        req.query.session || ""
      ).trim();

    const query =
      String(
        req.query.q || ""
      ).trim();

    if (!validSession(id)) {
      return res
        .status(400)
        .send(
          "Sessao invalida"
        );
    }

    if (!query) {
      return res
        .status(400)
        .send(
          "Pesquisa vazia"
        );
    }

    try {
      console.log(
        "Pesquisando:",
        query
      );

      const session =
        await newSession(id);

      let results = [];

      try {
        results =
          await searchWeb(
            query
          );
      } catch (error) {
        console.log(
          "Erro pesquisa:",
          error.message
        );
      }

      console.log(
        "Resultados:",
        results.length
      );

      const html =
        resultsPage(
          query,
          results
        );

      await session.page.setContent(
        html,
        {
          waitUntil:
            "domcontentloaded"
        }
      );

      return screenshot(
        session.page,
        res
      );

    } catch (error) {
      console.error(
        "SEARCH:",
        error
      );

      return res
        .status(500)
        .send(
          "Erro interno"
        );
    }
  }
);


/* =========================
   CLIQUE
========================= */

app.get(
  "/v5/click",
  async (req, res) => {
    const id =
      String(
        req.query.session || ""
      ).trim();

    const session =
      getSession(id);

    if (!session) {
      return res
        .status(404)
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
      return res
        .status(400)
        .send(
          "Coordenadas invalidas"
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

    try {
      const target =
        await session.page.evaluate(
          ({ x, y }) => {
            const elements =
              Array.from(
                document.querySelectorAll(
                  "a,button,input,[role='button'],[onclick]"
                )
              );

            let best = null;
            let distance = Infinity;

            for (
              const element
              of elements
            ) {
              const rect =
                element.getBoundingClientRect();

              if (
                rect.width < 2 ||
                rect.height < 2
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

              const d =
                Math.sqrt(
                  dx * dx +
                  dy * dy
                );

              if (d < distance) {
                distance = d;
                best = element;
              }
            }

            if (
              !best ||
              distance > 170
            ) {
              return {
                found: false
              };
            }

            const anchor =
              best.tagName.toLowerCase() === "a"
                ? best
                : best.closest("a");

            if (
              anchor &&
              anchor.href
            ) {
              return {
                found: true,
                href: anchor.href
              };
            }

            return {
              found: true,
              href: ""
            };
          },
          {
            x: px,
            y: py
          }
        );

      if (
        target.found &&
        target.href
      ) {
        console.log(
          "Abrindo link:",
          target.href
        );

        await openUrl(
          session.page,
          target.href
        );
      } else {
        try {
          await session.page
            .mouse
            .click(
              px,
              py
            );

          await session.page
            .waitForTimeout(
              500
            );
        } catch {}
      }

      return screenshot(
        session.page,
        res
      );

    } catch (error) {
      console.error(
        "CLICK:",
        error
      );

      return messagePage(
        session.page,
        res,
        "Erro no clique",
        "Mova o cursor e tente novamente."
      );
    }
  }
);


/* =========================
   VOLTAR
========================= */

app.get(
  "/v5/back",
  async (req, res) => {
    const session =
      getSession(
        String(
          req.query.session || ""
        )
      );

    if (!session) {
      return res
        .status(404)
        .send(
          "Sessao nao encontrada"
        );
    }

    try {
      await session.page.goBack({
        waitUntil:
          "domcontentloaded",

        timeout:
          15000
      });
    } catch {}

    return screenshot(
      session.page,
      res
    );
  }
);


/* =========================
   AVANCAR
========================= */

app.get(
  "/v5/forward",
  async (req, res) => {
    const session =
      getSession(
        String(
          req.query.session || ""
        )
      );

    if (!session) {
      return res
        .status(404)
        .send(
          "Sessao nao encontrada"
        );
    }

    try {
      await session.page.goForward({
        waitUntil:
          "domcontentloaded",

        timeout:
          15000
      });
    } catch {}

    return screenshot(
      session.page,
      res
    );
  }
);


/* =========================
   ROLAGEM
========================= */

app.get(
  "/v5/scroll",
  async (req, res) => {
    const session =
      getSession(
        String(
          req.query.session || ""
        )
      );

    if (!session) {
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
          200
        );

    } catch {}

    return screenshot(
      session.page,
      res
    );
  }
);


/* =========================
   LIMPAR SESSOES ANTIGAS
========================= */

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


/* =========================
   INICIAR
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () =>
