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

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    context,
    page,
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

  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  return res
    .status(200)
    .type("png")
    .send(image);
}

async function screenshot(page, res, delay = 250) {
  if (delay > 0) {
    await page.waitForTimeout(delay);
  }

  const image = await page.screenshot({
    type: "png",
    fullPage: false
  });

  return sendImage(res, image);
}

async function openPage(page, rawUrl) {
  const url = validUrl(rawUrl);

  if (!url) {
    return false;
  }

  try {
    console.log("Abrindo:", url);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(600);

    return true;
  } catch (error) {
    console.log(
      "Erro ao abrir:",
      error.message
    );

    try {
      return await page.evaluate(() => {
        if (!document.body) {
          return false;
        }

        return (
          document.body.innerText.trim().length > 10 ||
          document.images.length > 0
        );
      });
    } catch {
      return false;
    }
  }
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
    res,
    100
  );
}

function cleanXml(text) {
  return String(text || "")
    .replace(
      /<!\[CDATA\[|\]\]>/g,
      ""
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

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

  const blocks =
    xml.match(
      /<item[\s\S]*?<\/item>/gi
    ) || [];

  const results = [];

  for (const item of blocks.slice(0, 10)) {
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

    if (!titleMatch || !linkMatch) {
      continue;
    }

    const title =
      cleanXml(
        titleMatch[1]
      );

    const link =
      cleanXml(
        linkMatch[1]
      );

    const description =
      descMatch
        ? cleanXml(descMatch[1])
        : "";

    if (!validUrl(link)) {
      continue;
    }

    results.push({
      title,
      link,
      description
    });
  }

  return results;
}

function searchPage(
  query,
  results
) {
  let cards = "";

  if (results.length === 0) {
    cards = `
<div class="empty">
Nenhum resultado encontrado.
</div>
`;
  } else {
    results.forEach(
      (item, index) => {
        cards += `
<a
  class="result"
  href="${escapeHtml(item.link)}"
>

<div class="title">
${index + 1}. ${escapeHtml(item.title)}
</div>

<div class="url">
${escapeHtml(item.link)}
</div>

<div class="description">
${escapeHtml(item.description)}
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

body {
  margin: 0;
  padding: 25px 35px 60px;
  background: #f4f8fa;
  color: #17394a;
  font-family: Arial, sans-serif;
}

.header {
  background: #082a42;
  color: white;
  padding: 22px 28px;
  margin-bottom: 20px;
  border-bottom: 5px solid #18c7d9;
  border-radius: 12px;
}

.header h1 {
  margin: 0 0 8px;
  font-size: 31px;
}

.header p {
  margin: 0;
  font-size: 20px;
  color: #b9e9ee;
}

.result {
  display: block;
  padding: 18px 20px;
  margin-bottom: 15px;
  background: white;
  border: 2px solid #d6e6eb;
  border-radius: 10px;
  color: #17394a;
  text-decoration: none;
}

.title {
  font-size: 24px;
  font-weight: bold;
  color: #075d79;
}

.url {
  margin: 6px 0;
  font-size: 15px;
  color: #23808f;
}

.description {
  font-size: 18px;
  line-height: 1.3;
}

.empty {
  padding: 30px;
  background: white;
  border-radius: 10px;
  font-size: 24px;
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

${cards}

</body>

</html>
`;
}

app.get(
  "/",
  (req, res) => {
    res.send(
      "<h1>Navegador Roku V5.2</h1>" +
      "<p>Servidor online</p>"
    );
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "roku-v5.2"
    });
  }
);

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
        await openPage(
          session.page,
          url
        );

      if (!ok) {
        return showMessage(
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
        error.message
      );

      return res
        .status(500)
        .send(
          "Erro interno"
        );
    }
  }
);

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

      await session.page.setContent(
        searchPage(
          query,
          results
        ),
        {
          waitUntil:
            "domcontentloaded"
        }
      );

      return screenshot(
        session.page,
        res,
        100
      );
    } catch (error) {
      console.error(
        "SEARCH:",
        error.message
      );

      return res
        .status(500)
        .send(
          "Erro interno"
        );
    }
  }
);

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
      const link =
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

            for (const element of elements) {
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

              const d =
                Math.hypot(
                  nx - x,
                  ny - y
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
              return "";
            }

            const anchor =
              best.tagName.toLowerCase() === "a"
                ? best
                : best.closest("a");

            if (
              anchor &&
              anchor.href
            ) {
              return anchor.href;
            }

            return "";
          },
          {
            x: px,
            y: py
          }
        );

      if (link) {
        await openPage(
          session.page,
          link
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
              400
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
        error.message
      );

      return showMessage(
        session.page,
        res,
        "Erro no clique",
        "Mova o cursor e tente novamente."
      );
    }
  }
);

app.get(
  "/v5/back",
  async (req, res) => {
    const session =
      getSession(
        String(
          req.query.session || ""
        ).trim()
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

app.get(
  "/v5/forward",
  async (req, res) => {
    const session =
      getSession(
        String(
          req.query.session || ""
        ).trim()
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

app.get(
  "/v5/scroll",
  async (req, res) => {
    const session =
      getSession(
        String(
          req.query.session || ""
        ).trim()
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
    } catch {}

    return screenshot(
      session.page,
      res,
      150
    );
  }
);

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
        1800000
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

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Navegador Roku V5.2 iniciado na porta " +
      PORT
    );
  }
);
