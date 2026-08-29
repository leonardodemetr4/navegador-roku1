const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;
const sessions = new Map();
let browser;

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
  return /^[A-Za-z0-9_-]{1,60}$/.test(id || "");
}

function validUrl(value) {
  try {
    const u = new URL(value);

    if (
      u.protocol === "http:" ||
      u.protocol === "https:"
    ) {
      return u.toString();
    }

    return null;
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clean(s) {
  return String(s || "")
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

  const context =
    await (await getBrowser()).newContext({
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

  const page =
    await context.newPage();

  page.setDefaultTimeout(
    15000
  );

  page.setDefaultNavigationTimeout(
    35000
  );

  const session = {
    context,
    page,
    last: Date.now()
  };

  sessions.set(
    id,
    session
  );

  return session;
}

function getSession(id) {
  const session =
    sessions.get(id);

  if (!session) {
    return null;
  }

  session.last =
    Date.now();

  return session;
}

async function waitVisual(
  page,
  maxWait = 5000
) {
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
          return Array.from(
            document.images || []
          ).filter(img => {
            return (
              img.src &&
              !img.complete
            );
          }).length;
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
    350
  );
}

async function shot(
  page,
  res
) {
  const png =
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
    .send(png);
}

async function openUrl(
  page,
  raw
) {
  const url =
    validUrl(raw);

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
        1800
      );

      return await page.evaluate(
        () => {
          if (!document.body) {
            return false;
          }

          return (
            (
              document.body.innerText ||
              ""
            ).trim().length > 10 ||
            document.images.length > 0
          );
        }
      );
    } catch {
      return false;
    }
  }
}

async function searchRss(
  query
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
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
      of items.slice(0, 12)
    ) {
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

      const link =
        clean(
          linkMatch[1]
        );

      if (!validUrl(link)) {
        continue;
      }

      results.push({
        title:
          clean(
            titleMatch[1]
          ),

        link,

        description:
          descMatch
            ? clean(
                descMatch[1]
              )
            : "",

        thumb: ""
      });
    }

    return results;
  } finally {
    clearTimeout(
      timer
    );
  }
}

async function youtubeApiSearch(
  query
) {
  const key =
    process.env.YOUTUBE_API_KEY;

  if (!key) {
    return [];
  }

  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    "?part=snippet" +
    "&type=video" +
    "&maxResults=10" +
    "&safeSearch=moderate" +
    "&q=" +
    encodeURIComponent(query) +
    "&key=" +
    encodeURIComponent(key);

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      "YouTube API HTTP " +
      response.status
    );
  }

  const data =
    await response.json();

  return (
    data.items || []
  )
    .map(item => {
      const id =
        item.id &&
        item.id.videoId
          ? item.id.videoId
          : "";

      const snippet =
        item.snippet || {};

      const thumbs =
        snippet.thumbnails || {};

      return {
        title:
          snippet.title ||
          "Video do YouTube",

        link:
          id
            ? "https://www.youtube.com/watch?v=" +
              id
            : "",

        description:
          snippet.channelTitle ||
          "YouTube",

        thumb:
          (
            thumbs.high &&
            thumbs.high.url
          ) ||
          (
            thumbs.medium &&
            thumbs.medium.url
          ) ||
          (
            thumbs.default &&
            thumbs.default.url
          ) ||
          ""
      };
    })
    .filter(item => {
      return item.link;
    });
}

async function youtubeSearch(
  query
) {
  try {
    const results =
      await youtubeApiSearch(
        query
      );

    if (
      results.length > 0
    ) {
      return results;
    }
  } catch (error) {
    console.log(
      "YouTube API:",
      error.message
    );
  }

  try {
    return (
      await searchRss(
        "site:youtube.com/watch " +
        query
      )
    ).slice(0, 10);
  } catch {
    return [];
  }
}

function resultsHtml(
  title,
  query,
  items
) {
  let cards = "";

  if (
    items.length === 0
  ) {
    cards = `
<div class="empty">
Nenhum resultado encontrado.
</div>
`;
  } else {
    cards =
      items
        .map(
          (item, index) => {
            const visual =
              item.thumb
                ? `
<img
  src="${esc(item.thumb)}"
>
`
                : `
<div class="num">
${index + 1}
</div>
`;

            return `
<a
  class="card"
  href="${esc(item.link)}"
>

${visual}

<div class="body">

<div class="title">
${esc(item.title)}
</div>

<div class="url">
${esc(item.link)}
</div>

<div class="desc">
${esc(item.description)}
</div>

</div>

</a>
`;
          }
        )
        .join("");
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
  padding: 24px 34px 60px;
  background: #f4f6f7;
  font-family: Arial;
  color: #1f343d;
}

.head,
.card,
.empty {
  background: white;
  border: 2px solid #e0e5e8;
  border-radius: 14px;
}

.head {
  padding: 22px 26px;
  margin-bottom: 18px;
}

.head h1 {
  margin: 0 0 5px;
  font-size: 31px;
}

.head p {
  margin: 0;
  font-size: 21px;
  color: #606f76;
}

.card {
  display: flex;
  gap: 18px;
  text-decoration: none;
  color: #1f343d;
  padding: 16px;
  margin-bottom: 14px;
}

.card img {
  width: 210px;
  height: 118px;
  object-fit: cover;
  border-radius: 10px;
  background: #ddd;
}

.num {
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

.desc {
  font-size: 18px;
  color: #52636b;
}

.empty {
  padding: 30px;
  font-size: 24px;
}

</style>

</head>

<body>

<div class="head">

<h1>
${esc(title)}
</h1>

<p>
${esc(query)}
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
      "<h1>Navegador Roku V6.3</h1>" +
      "<p>Servidor online</p>"
    );
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "roku-v6.3"
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
        await session.page.setContent(
          "<html><body style='font-family:Arial;padding:80px'>" +
          "<h1>Pagina indisponivel</h1>" +
          "<p>O site nao respondeu ou bloqueou o navegador remoto.</p>" +
          "</body></html>"
        );
      }

      return shot(
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

      let items = [];

      try {
        items =
          await searchRss(
            query
          );
      } catch (error) {
        console.log(
          "SEARCH:",
          error.message
        );
      }

      await session.page.setContent(
        resultsHtml(
          "Pesquisa",
          query,
          items
        ),
        {
          waitUntil:
            "domcontentloaded"
        }
      );

      await waitVisual(
        session.page,
        2200
      );

      return shot(
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
  "/v6/youtube-search",
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

      const items =
        await youtubeSearch(
          query
        );

      await session.page.setContent(
        resultsHtml(
          "YouTube",
          query,
          items
        ),
        {
          waitUntil:
            "domcontentloaded"
        }
      );

      await waitVisual(
        session.page,
        4500
      );

      return shot(
        session.page,
        res
      );
    } catch (error) {
      console.error(
        "YT SEARCH:",
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

              const d =
                Math.hypot(
                  nx - x,
                  ny - y
                );

              if (
                d < distance
              ) {
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
              best.tagName
                .toLowerCase() ===
              "a"
                ? best
                : best.closest("a");

            return (
              anchor &&
              anchor.href
                ? anchor.href
                : ""
            );
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
            2200
          );
        } catch {}
      }

      return shot(
        session.page,
        res
      );
    } catch (error) {
      console.error(
        "CLICK:",
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
        2500
      );
    } catch {}

    return shot(
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
        2500
      );
    } catch {}

    return shot(
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
        1000
      );
    } catch {}

    return shot(
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
      const [
        id,
        session
      ]
      of sessions
    ) {
      if (
        now -
          session.last >
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

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Navegador Roku V6.3 iniciado na porta " +
      PORT
    );

    console.log(
      "Modo universal ativado"
    );

    if (
      process.env.YOUTUBE_API_KEY
    ) {
      console.log(
        "YouTube API ativada"
      );
    } else {
      console.log(
        "YouTube API sem chave - usando fallback"
      );
    }
  }
);
