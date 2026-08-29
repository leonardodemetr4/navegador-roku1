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

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clean(value) {
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
  maxWait = 4500
) {
  try {
    await page.evaluate(
      () => {
        for (
          const img
          of Array.from(
            document.images || []
          )
        ) {
          try {
            img.loading = "eager";
          } catch {}
        }
      }
    );
  } catch {}

  const end =
    Date.now() + maxWait;

  while (
    Date.now() < end
  ) {
    try {
      const pending =
        await page.evaluate(
          () => {
            return Array
              .from(
                document.images || []
              )
              .filter(
                img =>
                  img.src &&
                  !img.complete
              )
              .length;
          }
        );

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

async function sendShot(
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

function youtubeId(raw) {
  try {
    const u =
      new URL(raw);

    const host =
      u.hostname.replace(
        /^www\./,
        ""
      );

    if (
      host === "youtu.be"
    ) {
      return (
        u.pathname
          .split("/")
          .filter(Boolean)[0] ||
        ""
      );
    }

    if (
      host.endsWith(
        "youtube.com"
      )
    ) {
      if (
        u.pathname === "/watch"
      ) {
        return (
          u.searchParams.get("v") ||
          ""
        );
      }

      const parts =
        u.pathname
          .split("/")
          .filter(Boolean);

      if (
        [
          "shorts",
          "embed",
          "live"
        ].includes(parts[0])
      ) {
        return (
          parts[1] ||
          ""
        );
      }
    }
  } catch {}

  return "";
}

function isYoutube(raw) {
  try {
    const host =
      new URL(raw)
        .hostname
        .replace(
          /^www\./,
          ""
        );

    return (
      host === "youtu.be" ||
      host.endsWith(
        "youtube.com"
      )
    );
  } catch {
    return false;
  }
}

async function youtubeMeta(
  url,
  id
) {
  let title =
    "Video do YouTube";

  let author =
    "YouTube";

  try {
    const response =
      await fetch(
        "https://www.youtube.com/oembed" +
        "?format=json&url=" +
        encodeURIComponent(url),
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        }
      );

    if (response.ok) {
      const data =
        await response.json();

      if (data.title) {
        title =
          data.title;
      }

      if (
        data.author_name
      ) {
        author =
          data.author_name;
      }
    }
  } catch {}

  return {
    title,
    author,

    thumb:
      id
        ? "https://i.ytimg.com/vi/" +
          id +
          "/hqdefault.jpg"
        : ""
  };
}

function youtubeHomeHtml() {
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
  background: #f5f5f5;
  font-family: Arial;
  color: #202020;
}

.wrap {
  padding: 42px 54px;
}

.hero {
  background: white;
  border: 2px solid #e4e4e4;
  border-radius: 18px;
  padding: 38px;
}

.logo {
  font-size: 48px;
  font-weight: bold;
  color: #ff0033;
}

.sub {
  font-size: 24px;
  color: #555;
  margin-top: 10px;
}

.card {
  margin-top: 26px;
  background: white;
  border: 2px solid #e4e4e4;
  border-radius: 16px;
  padding: 28px;
}

h2 {
  font-size: 30px;
}

p {
  font-size: 22px;
  line-height: 1.45;
}

.key {
  background: #202020;
  color: white;
  padding: 7px 13px;
  border-radius: 8px;
  font-weight: bold;
}

</style>

</head>

<body>

<div class="wrap">

<div class="hero">

<div class="logo">
YouTube TV
</div>

<div class="sub">
Modo otimizado para o Navegador Roku
</div>

</div>

<div class="card">

<h2>
Pesquisar videos com miniaturas
</h2>

<p>
Aperte
<span class="key">*</span>
e digite:
</p>

<p>
<b>
yt: nome do video
</b>
</p>

<p>
Exemplo:
<b>
yt: musica brasileira
</b>
</p>

<p>
Os resultados aparecem em cartões próprios para TV com miniaturas.
</p>

</div>

</div>

</body>

</html>
`;
}

function youtubeDetailHtml(
  url,
  meta
) {
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
  background: #f5f5f5;
  font-family: Arial;
  color: #202020;
}

.wrap {
  padding: 28px 40px;
}

.card {
  background: white;
  border: 2px solid #e2e2e2;
  border-radius: 16px;
  padding: 24px;
}

img {
  display: block;
  width: 720px;
  max-height: 405px;
  object-fit: cover;
  margin: 0 auto 20px;
  border-radius: 12px;
  background: #ddd;
}

h1 {
  font-size: 31px;
}

.author {
  font-size: 21px;
  color: #666;
}

.note {
  font-size: 19px;
  line-height: 1.4;
  color: #555;
  margin-top: 18px;
}

a {
  display: inline-block;
  margin-top: 18px;
  padding: 15px 22px;
  background: #202020;
  color: white;
  text-decoration: none;
  border-radius: 10px;
  font-size: 20px;
}

</style>

</head>

<body>

<div class="wrap">

<div class="card">

${
  meta.thumb
    ? `
<img
  src="${esc(meta.thumb)}"
>
`
    : ""
}

<h1>
${esc(meta.title)}
</h1>

<div class="author">
${esc(meta.author)}
</div>

<div class="note">
Pagina otimizada para mostrar a miniatura corretamente na TV.
</div>

<a href="${esc(url)}">
Abrir pagina original
</a>

</div>

</div>

</body>

</html>
`;
}

async function renderYoutube(
  page,
  url
) {
  const id =
    youtubeId(url);

  if (!id) {
    await page.setContent(
      youtubeHomeHtml(),
      {
        waitUntil:
          "domcontentloaded"
      }
    );

    return;
  }

  const meta =
    await youtubeMeta(
      url,
      id
    );

  await page.setContent(
    youtubeDetailHtml(
      url,
      meta
    ),
    {
      waitUntil:
        "domcontentloaded"
    }
  );

  await waitVisual(
    page,
    4000
  );
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

  if (
    isYoutube(url)
  ) {
    await renderYoutube(
      page,
      url
    );

    return true;
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
            ).trim().length >
              10 ||
            document.images.length >
              0
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
      encodeURIComponent(
        query
      );

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
          descriptionMatch
            ? clean(
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

function resultsHtml(
  query,
  results
) {
  let cards = "";

  results.forEach(
    (item, index) => {
      const id =
        youtubeId(
          item.link
        );

      const thumb =
        id
          ? "https://i.ytimg.com/vi/" +
            id +
            "/mqdefault.jpg"
          : "";

      cards += `
<a
  class="result"
  href="${esc(item.link)}"
>

${
  thumb
    ? `
<img
  class="thumb"
  src="${esc(thumb)}"
>
`
    : `
<div class="number">
${index + 1}
</div>
`
}

<div class="content">

<div class="title">
${esc(item.title)}
</div>

<div class="url">
${esc(item.link)}
</div>

<div class="description">
${esc(item.description)}
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
  font-family: Arial;
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
  font-size: 31px;
  margin: 0;
}

.header p {
  font-size: 21px;
}

.result {
  display: flex;
  gap: 18px;
  background: white;
  color: #1f343d;
  text-decoration: none;
  padding: 16px;
  margin-bottom: 14px;
  border: 2px solid #e0e5e8;
  border-radius: 13px;
}

.thumb {
  width: 210px;
  height: 118px;
  object-fit: cover;
  border-radius: 10px;
  background: #ddd;
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
${esc(query)}
</p>

</div>

${cards}

</body>

</html>
`;
}

async function youtubeSearchResults(
  query
) {
  let results = [];

  try {
    results =
      await searchRss(
        "site:youtube.com/watch " +
        query
      );
  } catch (error) {
    console.log(
      "Busca YouTube:",
      error.message
    );
  }

  const seen =
    new Set();

  const output = [];

  for (
    const item
    of results
  ) {
    const id =
      youtubeId(
        item.link
      );

    if (
      !id ||
      seen.has(id)
    ) {
      continue;
    }

    seen.add(id);

    output.push(item);

    if (
      output.length >= 8
    ) {
      break;
    }
  }

  if (
    output.length === 0
  ) {
    output.push({
      title:
        'Pesquisar "' +
        query +
        '" no YouTube',

      link:
        "https://www.youtube.com/results?search_query=" +
        encodeURIComponent(
          query
        ),

      description:
        "Abrir pesquisa do YouTube."
    });
  }

  return output;
}

app.get(
  "/",
  (req, res) => {
    res.send(
      "<h1>Navegador Roku V6.2</h1>" +
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
        "roku-v6.2"
    });
  }
);

app.get(
  "/v6/youtube-home",
  async (req, res) => {
    const id =
      String(
        req.query.session || ""
      ).trim();

    if (!validSession(id)) {
      return res
        .status(400)
        .send(
          "Sessao invalida"
        );
    }

    try {
      const session =
        await createSession(id);

      await session.page.setContent(
        youtubeHomeHtml(),
        {
          waitUntil:
            "domcontentloaded"
        }
      );

      return sendShot(
        session.page,
        res
      );
    } catch (error) {
      console.error(
        "YT HOME:",
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

      const results =
        await youtubeSearchResults(
          query
        );

      await session.page.setContent(
        resultsHtml(
          "YouTube: " +
          query,
          results
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

      return sendShot(
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
          "<p>O site nao respondeu.</p>" +
          "</body></html>"
        );
      }

      return sendShot(
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

      let results = [];

      try {
        results =
          await searchRss(
            query
          );
      } catch (error) {
        console.log(
          "SEARCH RSS:",
          error.message
        );
      }

      await session.page.setContent(
        resultsHtml(
          query,
          results
        ),
        {
          waitUntil:
            "domcontentloaded"
        }
      );

      await waitVisual(
        session.page,
        3500
      );

      return sendShot(
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
            let bestDistance =
              Infinity;

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

      return sendShot(
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

    return sendShot(
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

    return sendShot(
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

    return sendShot(
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
      "Navegador Roku V6.2 iniciado na porta " +
      PORT
    );

    console.log(
      "Modo YouTube TV otimizado ativado"
    );
  }
);
