const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

const sessions = new Map();
let browser = null;

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

function validUrl(value) {
  try {
    const url = new URL(value);

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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function createSession(id) {
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
  page.setDefaultNavigationTimeout(35000);

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

async function waitVisual(page, maxWait = 5000) {
  try {
    await page.evaluate(() => {
      const images =
        Array.from(
          document.images || []
        );

      for (const img of images) {
        try {
          img.loading = "eager";
        } catch {}
      }
    });
  } catch {}

  const end =
    Date.now() + maxWait;

  while (
    Date.now() < end
  ) {
    try {
      const pending =
        await page.evaluate(() => {
          return Array
            .from(
              document.images || []
            )
            .filter(img => {
              return (
                img.src &&
                !img.complete
              );
            })
            .length;
        });

      if (pending === 0) {
        break;
      }
    } catch {
      break;
    }

    await page.waitForTimeout(
      300
    );
  }

  try {
    await page.waitForLoadState(
      "networkidle",
      {
        timeout: 1500
      }
    );
  } catch {}

  await page.waitForTimeout(
    400
  );
}

async function sendScreenshot(
  page,
  res
) {
  const image =
    await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled"
    });

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

  return res
    .status(200)
    .type("png")
    .send(image);
}

async function openUrl(
  page,
  rawUrl
) {
  const url =
    validUrl(rawUrl);

  if (!url) {
    return false;
  }

  try {
    console.log(
      "Abrindo:",
      url
    );

    await page.goto(
      url,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          35000
      }
    );

    await waitVisual(
      page,
      6000
    );

    return true;
  } catch (error) {
    console.log(
      "Falha ao abrir:",
      error.message
    );

    try {
      await waitVisual(
        page,
        2000
      );

      return await page.evaluate(
        () => {
          if (!document.body) {
            return false;
          }

          const text =
            (
              document.body.innerText ||
              ""
            ).trim();

          return (
            text.length > 10 ||
            document.images.length > 0
          );
        }
      );
    } catch {
      return false;
    }
  }
}

async function messagePage(
  page,
  res,
  title,
  text
) {
  const html = `
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<style>

body {
  margin: 0;
  background: #f5f7f8;
  color: #222;
  font-family: Arial, sans-serif;
}

.box {
  width: 78%;
  margin: 150px auto;
  padding: 42px;
  background: white;
  border: 2px solid #dfe5e8;
  border-radius: 16px;
}

h1 {
  margin: 0 0 18px;
  font-size: 38px;
}

p {
  font-size: 24px;
  line-height: 1.45;
}

</style>

</head>

<body>

<div class="box">

<h1>
${escapeHtml(title)}
</h1>

<p>
${escapeHtml(text)}
</p>

</div>

</body>

</html>
`;

  await page.setContent(
    html
  );

  return sendScreenshot(
    page,
    res
  );
}

async function searchRss(query) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      10000
    );

  try {
    const url =
      "https://www.bing.com/search" +
      "?format=rss&setlang=pt-BR&q=" +
      encodeURIComponent(query);

    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,

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
        "HTTP " +
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

    for (
      const item
      of items.slice(0, 10)
    ) {
      const titleMatch =
        item.match(
          /<title>([\s\S]*?)<\/title>/i
        );

      const linkMatch =
        item.match(
          /<link>([\s\S]*?)<\/link>/i
        );

      const descriptionMatch =
        item.match(
          /<description>([\s\S]*?)<\/description>/i
        );

      if (
        !titleMatch ||
        !linkMatch
      ) {
        continue;
      }

      const link =
        cleanXml(
          linkMatch[1]
        );

      if (!validUrl(link)) {
        continue;
      }

      results.push({
        title:
          cleanXml(
            titleMatch[1]
          ),

        link,

        description:
          descriptionMatch
            ? cleanXml(
                descriptionMatch[1]
              )
            : ""
      });
    }

    return results;
  } finally {
    clearTimeout(
      timer
    );
  }
}

function fallbackResults(query) {
  const q =
    query.trim();

  const key =
    q.toLowerCase();

  const presets = {
    youtube: [
      [
        "YouTube",
        "https://www.youtube.com/",
        "Site oficial do YouTube."
      ],

      [
        "YouTube Music",
        "https://music.youtube.com/",
        "Musica e playlists."
      ],

      [
        "Ajuda do YouTube",
        "https://support.google.com/youtube/",
        "Central de ajuda oficial."
      ]
    ],

    facebook: [
      [
        "Facebook",
        "https://www.facebook.com/",
        "Site oficial do Facebook."
      ],

      [
        "Ajuda do Facebook",
        "https://www.facebook.com/help/",
        "Central de ajuda."
      ]
    ],

    instagram: [
      [
        "Instagram",
        "https://www.instagram.com/",
        "Site oficial do Instagram."
      ],

      [
        "Ajuda do Instagram",
        "https://help.instagram.com/",
        "Central de ajuda."
      ]
    ],

    roku: [
      [
        "Roku",
        "https://www.roku.com/",
        "Site oficial da Roku."
      ],

      [
        "Roku Support",
        "https://support.roku.com/",
        "Suporte oficial da Roku."
      ]
    ]
  };

  let list =
    presets[key];

  if (!list) {
    list = [
      [
        'Pesquisar por "' +
        q +
        '" no Bing',

        "https://www.bing.com/search?q=" +
        encodeURIComponent(q),

        "Abrir a pesquisa completa."
      ]
    ];
  }

  return list.map(
    item => ({
      title:
        item[0],

      link:
        item[1],

      description:
        item[2]
    })
  );
}

async function searchWeb(query) {
  try {
    const results =
      await searchRss(
        query
      );

    if (
      results.length > 0
    ) {
      return results;
    }
  } catch (error) {
    console.log(
      "RSS indisponivel:",
      error.message
    );
  }

  return fallbackResults(
    query
  );
}

function searchHtml(
  query,
  results
) {
  let cards = "";

  results.forEach(
    (item, index) => {
      cards += `
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

<div class="description">
${escapeHtml(item.description)}
</div>

</div>

</a>
`;
    }
  );

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
  padding: 24px 34px 60px;
  background: #f4f6f7;
  font-family: Arial, sans-serif;
  color: #1f343d;
}

.header {
  background: white;
  border: 2px solid #e0e5e8;
  padding: 22px 26px;
  margin-bottom: 18px;
  border-radius: 14px;
}

.header h1 {
  margin: 0 0 5px;
  font-size: 31px;
}

.header p {
  margin: 0;
  font-size: 21px;
  color: #606f76;
}

.result {
  display: flex;
  gap: 18px;
  background: white;
  color: #1f343d;
  text-decoration: none;
  padding: 18px 20px;
  margin-bottom: 14px;
  border: 2px solid #e0e5e8;
  border-radius: 13px;
}

.number {
  min-width: 48px;
  height: 48px;
  line-height: 48px;
  text-align: center;
  background: #e9f4f7;
  border-radius: 12px;
  font-size: 22px;
  font-weight: bold;
}

.title {
  font-size: 24px;
  font-weight: bold;
  margin-bottom: 5px;
}

.url {
  font-size: 15px;
  color: #16819a;
  margin-bottom: 7px;
}

.description {
  font-size: 18px;
  line-height: 1.35;
  color: #52636b;
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
      "<h1>Navegador Roku V6.1</h1>" +
      "<p>Servidor online</p>"
    );
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "roku-v6.1"
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
        await createSession(id);

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
          "O site nao respondeu ou bloqueou o navegador remoto."
        );
      }

      return sendScreenshot(
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
        await createSession(id);

      const results =
        await searchWeb(
          query
        );

      console.log(
        "Pesquisa:",
        query,
        "Resultados:",
        results.length
      );

      await session.page.setContent(
        searchHtml(
          query,
          results
        ),
        {
          waitUntil:
            "domcontentloaded"
        }
      );

      return sendScreenshot(
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

app.get(
  "/v5/click",
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
      const href =
        await session.page.evaluate(
          ({ x, y }) => {
            const elements =
              Array.from(
                document.querySelectorAll(
                  "a,button,input,[role='button'],[onclick]"
                )
              );

            let best = null;
            let bestDistance = Infinity;

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

              const distance =
                Math.hypot(
                  nx - x,
                  ny - y
                );

              if (
                distance <
                bestDistance
              ) {
                bestDistance =
                  distance;

                best =
                  element;
              }
            }

            if (
              !best ||
              bestDistance > 170
            ) {
              return "";
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
              return anchor.href;
            }

            return "";
          },
          {
            x: px,
            y: py
          }
        );

      if (href) {
        await openUrl(
          session.page,
          href
        );
      } else {
        try {
          await session.page
            .mouse
            .click(
              px,
              py
            );

          await waitVisual(
            session.page,
            2500
          );
        } catch {}
      }

      return sendScreenshot(
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
          18000
      });

      await waitVisual(
        session.page,
        3000
      );
    } catch {}

    return sendScreenshot(
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
          18000
      });

      await waitVisual(
        session.page,
        3000
      );
    } catch {}

    return sendScreenshot(
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

      await waitVisual(
        session.page,
        1200
      );
    } catch {}

    return sendScreenshot(
      session.page,
      res
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

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Navegador Roku V6.1 iniciado na porta " +
      PORT
    );

    console.log(
      "Pesquisa e carregamento de imagens ativados"
    );
  }
);
