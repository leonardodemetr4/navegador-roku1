const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

const sessions = new Map();
let browser = null;

// ============================================================
// IPTV
// ============================================================

const IPTV_M3U_URL = process.env.IPTV_M3U_URL || "";

let iptvCache = {
  text: "",
  time: 0
};

const IPTV_CACHE_TIME = 5 * 60 * 1000;

// ============================================================
// NAVEGADOR - FUNCOES
// ============================================================

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
    .replace(/<!CDATA\[|\]>/g, "")
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

    sessions.delete(id);
  }

  const browserInstance = await getBrowser();

  const context = await browserInstance.newContext({
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

async function waitVisual(page, maxWait = 5000) {
  try {
    await page.evaluate(() => {
      const images = Array.from(document.images || []);

      for (const img of images) {
        try {
          img.loading = "eager";
        } catch {}
      }
    });
  } catch {}

  const end = Date.now() + maxWait;

  while (Date.now() < end) {
    try {
      const pending = await page.evaluate(() => {
        return Array.from(document.images || []).filter(img => {
          return img.src && !img.complete;
        }).length;
      });

      if (pending === 0) {
        break;
      }
    } catch {
      break;
    }

    await page.waitForTimeout(300);
  }

  try {
    await page.waitForLoadState("networkidle", {
      timeout: 1500
    });
  } catch {}

  await page.waitForTimeout(350);
}

async function shot(page, res) {
  const png = await page.screenshot({
    type: "png",
    fullPage: false,
    animations: "disabled"
  });

  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );

  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  return res
    .status(200)
    .type("png")
    .send(png);
}

async function openUrl(page, raw) {
  const url = validUrl(raw);

  if (!url) {
    return false;
  }

  try {
    console.log("Abrindo:", url);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 35000
    });

    await waitVisual(page, 6000);

    return true;
  } catch (error) {
    console.log(
      "Falha ao abrir:",
      error.message
    );

    try {
      await waitVisual(page, 1800);

      return await page.evaluate(() => {
        if (!document.body) {
          return false;
        }

        return (
          (document.body.innerText || "").trim().length > 10 ||
          document.images.length > 0
        );
      });
    } catch {
      return false;
    }
  }
}

// ============================================================
// PESQUISA
// ============================================================

async function searchRss(query) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 10000);

  try {
    const url =
      "https://www.bing.com/search" +
      "?format=rss&setlang=pt-BR&q=" +
      encodeURIComponent(query);

    const response = await fetch(url, {
      signal: controller.signal,

      headers: {
        "User-Agent":
          "Mozilla/5.0 Chrome/131 Safari/537.36",

        "Accept":
          "application/rss+xml,text/xml,*/*"
      }
    });

    if (!response.ok) {
      throw new Error(
        "HTTP " + response.status
      );
    }

    const xml = await response.text();

    const items =
      xml.match(
        /<item[\s\S]*?<\/item>/gi
      ) || [];

    const results = [];

    for (const item of items.slice(0, 12)) {
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
        clean(linkMatch[1]);

      if (!validUrl(link)) {
        continue;
      }

      results.push({
        title:
          clean(titleMatch[1]),

        link,

        description:
          descMatch
            ? clean(descMatch[1])
            : "",

        thumb: ""
      });
    }

    return results;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// YOUTUBE
// ============================================================

async function youtubeApiSearch(query) {
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

  return (data.items || [])
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
            ? "https://www.youtube.com/watch?v=" + id
            : "",

        description:
          snippet.channelTitle ||
          "YouTube",

        thumb:
          (thumbs.high && thumbs.high.url) ||
