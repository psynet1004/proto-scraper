import express from 'express';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'proto-scraper-2026';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// ====== AUTH ======
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ====== BROWSER ======
let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const blockTypes = ['image', 'font', 'media', 'stylesheet'];
    const blockUrls = ['google-analytics', 'googletagmanager', 'facebook', 'doubleclick', 'ads'];
    const u = req.url();
    if (blockTypes.includes(type) || blockUrls.some(b => u.includes(b))) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
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

// ====== Supabase REST API ======
async function supabaseGet(table, params = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  return r.json();
}

async function supabaseUpsert(table, data, onConflict) {
  const url = onConflict 
    ? `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`
    : `${SUPABASE_URL}/rest/v1/${table}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(data),
  });
  let body = '';
  if (!r.ok) {
    try { body = await r.text(); } catch(e) {}
  }
  return { ok: r.ok, status: r.status, body };
}

// ====== HEALTH ======
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'proto-scraper-server', time: new Date().toISOString() });
});

// ====== SCRAPE & SAVE (비동기 - 즉시 응답) ======
app.post('/scrape-and-save', auth, async (req, res) => {
  // 즉시 응답 (Netlify 타임아웃 방지)
  res.json({ message: 'Scraping started', timestamp: new Date().toISOString() });

  // 백그라운드에서 실행
  doScrapeAndSave().catch(e => console.error('Background scrape error:', e.message));
});

// ====== 수동 트리거 (GET) ======
app.get('/scrape-and-save', auth, async (req, res) => {
  res.json({ message: 'Scraping started', timestamp: new Date().toISOString() });
  doScrapeAndSave().catch(e => console.error('Background scrape error:', e.message));
});

async function doScrapeAndSave() {
  console.log('=== Starting scrape & save ===');

  // 1. DB에서 최신 회차 가져오기
  const latest = await supabaseGet('proto_matches',
    'match_type=eq.normal&order=round_number.desc&limit=1&select=round_year,round_number');

  if (!latest?.length) {
    console.log('No matches in DB');
    return;
  }

  const { round_year, round_number } = latest[0];
  console.log(`Round: ${round_year}-${round_number}`);

  const matches = await supabaseGet('proto_matches',
    `round_year=eq.${round_year}&round_number=eq.${round_number}&match_type=eq.normal&order=match_number&select=*`);

  console.log(`Found ${matches?.length || 0} matches`);

  // 2. 4개 사이트 HTML 가져오기 (순차)
  const sources = [
    { name: 'windrawwin', url: 'https://www.windrawwin.com/predictions/today/', wait: 'table' },
    { name: 'predictz', url: 'https://www.predictz.com/predictions/', wait: 'table' },
    { name: 'forebet', url: 'https://www.forebet.com/en/football-predictions', wait: '.rcnt' },
    { name: 'vitibet', url: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en', wait: 'table' },
  ];

  const pages = {};
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

  // 3. 각 경기별 예측 추출 & 저장
  let saved = 0;
  for (const match of matches || []) {
    if (!match.home_team_en || !match.away_team_en) continue;

    const h = match.home_team_en;
    const a = match.away_team_en;
    const preds = [];

    for (const src of sources) {
      const p = extractPrediction(pages[src.name], h, a, src.name);
      if (p) preds.push({ ...p, source: src.name });
    }

    // Supabase에 저장
    for (const p of preds) {
      const result = await supabaseUpsert('predictions', {
        match_id: match.id,
        source: p.source,
        predicted_score: p.predicted_score || null,
        predicted_result: p.predicted_result || null,
        confidence: p.confidence || null,
        scraped_at: new Date().toISOString(),
      }, 'match_id,source');

      if (result.ok) saved++;
      else {
        const errBody = result.body || '';
        console.log(`  DB error: ${p.source} #${match.match_number}: ${result.status} ${errBody}`);
      }
    }

    console.log(`  #${match.match_number} ${h} vs ${a}: ${preds.length}/4`);
  }

  console.log(`=== Done: ${saved} predictions saved ===`);
}

// ====== TEST ENDPOINT ======
app.get('/test/:site', auth, async (req, res) => {
  const urls = {
    windrawwin: 'https://www.windrawwin.com/predictions/today/',
    predictz: 'https://www.predictz.com/predictions/',
    forebet: 'https://www.forebet.com/en/football-predictions',
    vitibet: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en',
  };
  const site = req.params.site;
  if (!urls[site]) return res.json({ error: 'Invalid site' });

  try {
    const html = await getPage(urls[site], 'table');
    res.json({ site, chars: html.length, preview: html.substring(0, 500), timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== SCRAPE ONLY (원래 방식) ======
app.post('/scrape', auth, async (req, res) => {
  const { matches } = req.body;
  if (!matches?.length) return res.json({ error: 'No matches' });

  const sources = [
    { name: 'windrawwin', url: 'https://www.windrawwin.com/predictions/today/', wait: 'table' },
    { name: 'predictz', url: 'https://www.predictz.com/predictions/', wait: 'table' },
    { name: 'forebet', url: 'https://www.forebet.com/en/football-predictions', wait: '.rcnt' },
    { name: 'vitibet', url: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en', wait: 'table' },
  ];

  const pages = {};
  for (const src of sources) {
    try {
      pages[src.name] = await getPage(src.url, src.wait);
    } catch (e) {
      pages[src.name] = '';
    }
  }

  const results = {};
  for (const match of matches) {
    const preds = {};
    for (const src of sources) {
      const p = extractPrediction(pages[src.name], match.home_en, match.away_en, src.name);
      if (p) preds[src.name] = p;
    }
    results[match.match_number] = preds;
  }

  res.json({ success: true, results, timestamp: new Date().toISOString() });
});

// ====== PREDICTION EXTRACTION ======
function extractPrediction(html, homeEn, awayEn, source) {
  if (!html) return null;
  try {
    const $ = cheerio.load(html);
    let result = null;

    // 공통: 모든 행을 순회하며 팀명 매칭
    const selectors = source === 'forebet' 
      ? '.rcnt, tr, [class*="predict"]' 
      : 'tr, .pointed, [class*="match"]';

    $(selectors).each((_, row) => {
      if (result) return;
      const text = $(row).text();
      if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

      // 스코어 패턴
      const scoreEls = source === 'forebet'
        ? $(row).find('[class*="ex_sc"], [class*="score"], .foremark, td, span')
        : $(row).find('td, span, a, div');

      scoreEls.each((_, el) => {
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

      // 1X2 fallback
      if (!result) {
        $(row).find('td, span').each((_, el) => {
          if (result) return;
          const t = $(el).text().trim();
          if (t === '1') result = { predicted_score: null, predicted_result: '\uc2b9' };
          else if (t === '2') result = { predicted_score: null, predicted_result: '\ud328' };
          else if (t.toUpperCase() === 'X') result = { predicted_score: null, predicted_result: '\ubb34' };
        });
      }

      // forebet 확률
      if (result && source === 'forebet') {
        $(row).find('[class*="fprc"], [class*="prob"]').each((_, el) => {
          const pct = parseInt($(el).text().trim());
          if (pct > 0 && pct <= 100 && !result.confidence) result.confidence = pct;
        });
      }
    });

    return result;
  } catch (e) {
    return null;
  }
}

function fuzzy(text, team) {
  if (!text || !team) return false;
  const t = text.toLowerCase();
  const parts = team.toLowerCase().split(/\s+/);
  if (parts.every(p => t.includes(p))) return true;
  if (parts[0].length >= 4 && t.includes(parts[0])) return true;
  if (parts.length > 1 && parts[1].length >= 4 && t.includes(parts[1])) return true;
  return false;
}

// ====== START ======
app.listen(PORT, () => console.log(`Proto Scraper Server running on port ${PORT}`));

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
