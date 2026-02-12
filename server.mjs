import express from 'express';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'proto-scraper-2026';

// ====== AUTH MIDDLEWARE ======
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ====== BROWSER POOL ======
let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
    });
  }
  return browser;
}

async function getPage(url, waitSelector, timeout = 60000) {
  const b = await getBrowser();
  const page = await b.newPage();
  
  // 뷰포트 최소화 (메모리 절약)
  await page.setViewport({ width: 1280, height: 720 });
  
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });
  // Block images/fonts/css/ads to speed up
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const blockTypes = ['image', 'font', 'media', 'stylesheet'];
    const blockUrls = ['google-analytics', 'googletagmanager', 'facebook', 'doubleclick', 'ads'];
    const url = req.url();
    if (blockTypes.includes(type) || blockUrls.some(b => url.includes(b))) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    // 짧은 대기 후 추가 JS 렌더링 기다리기
    await new Promise(r => setTimeout(r, 3000));
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 15000 }).catch(() => {});
    }
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// ====== HEALTH CHECK ======
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'proto-scraper-server', time: new Date().toISOString() });
});

// ====== SCRAPE ALL 4 SITES ======
app.post('/scrape', auth, async (req, res) => {
  const { matches } = req.body;
  // matches: [{ home_en, away_en, match_number }, ...]
  
  if (!matches?.length) {
    return res.json({ error: 'No matches provided' });
  }

  console.log(`Scraping predictions for ${matches.length} matches...`);
  const results = {};

  try {
    // 4개 사이트 HTML을 병렬로 가져오기
    const sources = [
      { name: 'windrawwin', url: 'https://www.windrawwin.com/predictions/today/', wait: 'table' },
      { name: 'predictz', url: 'https://www.predictz.com/predictions/', wait: 'table' },
      { name: 'forebet', url: 'https://www.forebet.com/en/football-predictions', wait: '.rcnt' },
      { name: 'vitibet', url: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en', wait: 'table' },
    ];

    const pages = {};
    
    // 순차적으로 가져오기 (메모리 절약)
    for (const src of sources) {
      try {
        console.log(`  Fetching ${src.name}...`);
        pages[src.name] = await getPage(src.url, src.wait);
        console.log(`  ${src.name}: ${pages[src.name].length} chars`);
      } catch (e) {
        console.log(`  ${src.name}: FAILED - ${e.message}`);
        pages[src.name] = '';
      }
    }

    // 각 경기별 예측 추출
    for (const match of matches) {
      const { home_en, away_en, match_number } = match;
      const preds = {};

      for (const src of sources) {
        const pred = extractPrediction(pages[src.name], home_en, away_en, src.name);
        if (pred) preds[src.name] = pred;
      }

      results[match_number] = preds;
      console.log(`  #${match_number} ${home_en} vs ${away_en}: ${Object.keys(preds).length}/4`);
    }

    res.json({ success: true, results, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('Scrape error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ====== SCRAPE SINGLE SITE (TEST) ======
app.get('/test/:site', auth, async (req, res) => {
  const urls = {
    windrawwin: 'https://www.windrawwin.com/predictions/today/',
    predictz: 'https://www.predictz.com/predictions/',
    forebet: 'https://www.forebet.com/en/football-predictions',
    vitibet: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en',
  };

  const site = req.params.site;
  if (!urls[site]) return res.json({ error: 'Invalid site. Use: windrawwin, predictz, forebet, vitibet' });

  try {
    console.log(`Test fetching ${site}...`);
    const html = await getPage(urls[site], 'table');
    res.json({
      site,
      chars: html.length,
      preview: html.substring(0, 500),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== PREDICTION EXTRACTION ======
function extractPrediction(html, homeEn, awayEn, source) {
  if (!html) return null;

  try {
    const $ = cheerio.load(html);

    if (source === 'windrawwin') return parseWindrawwin($, homeEn, awayEn);
    if (source === 'predictz') return parsePredictz($, homeEn, awayEn);
    if (source === 'forebet') return parseForebet($, homeEn, awayEn);
    if (source === 'vitibet') return parseVitibet($, homeEn, awayEn);
  } catch (e) {
    console.log(`  Parse error (${source}): ${e.message}`);
  }
  return null;
}

// --- WINDRAWWIN ---
function parseWindrawwin($, home, away) {
  let result = null;
  
  $('tr').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, home) || !fuzzy(text, away)) return;

    // 스코어 찾기
    $(row).find('td, a, span').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-\u2013]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = {
          predicted_score: `${hg}-${ag}`,
          predicted_result: hg > ag ? '\uc2b9' : hg < ag ? '\ud328' : '\ubb34',
        };
      }
    });
  });

  return result;
}

// --- PREDICTZ ---
function parsePredictz($, home, away) {
  let result = null;

  $('tr, .pointed').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, home) || !fuzzy(text, away)) return;

    $(row).find('td, span, a').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-\u2013]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = {
          predicted_score: `${hg}-${ag}`,
          predicted_result: hg > ag ? '\uc2b9' : hg < ag ? '\ud328' : '\ubb34',
        };
      }
    });
  });

  return result;
}

// --- FOREBET ---
function parseForebet($, home, away) {
  let result = null;

  $('.rcnt, tr, [class*="predict"]').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, home) || !fuzzy(text, away)) return;

    // forebet는 스코어를 ex_sc 등의 클래스에 넣음
    $(row).find('[class*="ex_sc"], [class*="score"], .foremark, td, span').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-\u2013:]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = {
          predicted_score: `${hg}-${ag}`,
          predicted_result: hg > ag ? '\uc2b9' : hg < ag ? '\ud328' : '\ubb34',
        };
      }
    });

    // 확률 추출 시도
    if (result) {
      $(row).find('[class*="fprc"], [class*="prob"]').each((_, el) => {
        const pct = parseInt($(el).text().trim());
        if (pct > 0 && pct <= 100 && !result.confidence) {
          result.confidence = pct;
        }
      });
    }
  });

  return result;
}

// --- VITIBET ---
function parseVitibet($, home, away) {
  let result = null;

  $('tr').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, home) || !fuzzy(text, away)) return;

    // 스코어 찾기
    $(row).find('td, span, a').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-\u2013:]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = {
          predicted_score: `${hg}-${ag}`,
          predicted_result: hg > ag ? '\uc2b9' : hg < ag ? '\ud328' : '\ubb34',
        };
      }
    });

    // 1X2만이라도 추출
    if (!result) {
      $(row).find('td').each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        if (t === '1') result = { predicted_score: null, predicted_result: '\uc2b9' };
        else if (t === '2') result = { predicted_score: null, predicted_result: '\ud328' };
        else if (t.toUpperCase() === 'X') result = { predicted_score: null, predicted_result: '\ubb34' };
      });
    }
  });

  return result;
}

// ====== FUZZY MATCH ======
function fuzzy(text, team) {
  if (!text || !team) return false;
  const t = text.toLowerCase();
  const parts = team.toLowerCase().split(/\s+/);
  // 모든 단어가 포함
  if (parts.every(p => t.includes(p))) return true;
  // 첫 단어가 4글자 이상이면 그것만으로도 매칭
  if (parts[0].length >= 4 && t.includes(parts[0])) return true;
  // 두번째 단어도 시도
  if (parts.length > 1 && parts[1].length >= 4 && t.includes(parts[1])) return true;
  return false;
}

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`Proto Scraper Server running on port ${PORT}`);
});

// ====== CLEANUP ======
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
