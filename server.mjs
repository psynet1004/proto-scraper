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

// ====== DEBUG: 팀 검색 ======
app.get('/debug/:site/:team', auth, async (req, res) => {
  const urls = {
    windrawwin: 'https://www.windrawwin.com/predictions/today/',
    predictz: 'https://www.predictz.com/predictions/',
    forebet: 'https://www.forebet.com/en/football-predictions',
    vitibet: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en',
  };
  const site = req.params.site;
  const team = req.params.team;
  if (!urls[site]) return res.json({ error: 'Invalid site' });

  try {
    const html = await getPage(urls[site], 'table');
    const $ = cheerio.load(html);
    const found = [];
    
    // HTML에서 팀명이 포함된 모든 요소 찾기
    $('tr, div, a, span, td').each((_, el) => {
      const text = $(el).text().trim();
      if (text.toLowerCase().includes(team.toLowerCase()) && text.length < 500) {
        found.push({
          tag: $(el).prop('tagName'),
          class: $(el).attr('class') || '',
          text: text.substring(0, 200),
        });
      }
    });

    // 중복 제거 (가장 짧은 것 우선)
    const unique = found.sort((a, b) => a.text.length - b.text.length).slice(0, 10);

    res.json({ site, team, total_found: found.length, matches: unique, html_length: html.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== PREDICTION EXTRACTION ======
function extractPrediction(html, homeEn, awayEn, source) {
  if (!html) return null;
  try {
    switch (source) {
      case 'windrawwin': return parseWindrawwin(html, homeEn, awayEn);
      case 'predictz': return parsePredictz(html, homeEn, awayEn);
      case 'forebet': return parseForebet(html, homeEn, awayEn);
      case 'vitibet': return parseVitibet(html, homeEn, awayEn);
      default: return null;
    }
  } catch (e) {
    console.log(`  Parse error (${source}): ${e.message}`);
    return null;
  }
}

// windrawwin: div.wttd.wtfixt 에 팀명, span.predscore 에 스코어
function parseWindrawwin(html, homeEn, awayEn) {
  const $ = cheerio.load(html);
  let result = null;

  // 각 경기 행을 찾기 - wtfixt 클래스가 있는 div
  $('div.wtfixt, div[class*="wtfixt"]').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    // 같은 부모(경기 행 컨테이너)에서 predscore 찾기
    const parent = $(row).parent();
    const grandparent = parent.parent();
    
    // predscore를 여러 레벨에서 찾기
    let score = '';
    for (const container of [parent, grandparent]) {
      const sc = container.find('.predscore').first().text().trim();
      if (sc) { score = sc; break; }
      const sc2 = container.find('.wtsc').first().text().trim();
      if (sc2) { score = sc2; break; }
    }

    if (!score) {
      // 바로 다음 형제들에서 찾기
      const nextSiblings = $(row).nextAll();
      nextSiblings.each((_, sib) => {
        if (score) return;
        const t = $(sib).text().trim();
        const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
        if (m) score = t;
        const ps = $(sib).find('.predscore').first().text().trim();
        if (ps) score = ps;
      });
    }

    const m = score.match(/(\d+)\s*[-–:]\s*(\d+)/);
    if (m) {
      const hg = parseInt(m[1]), ag = parseInt(m[2]);
      result = {
        predicted_score: `${hg}-${ag}`,
        predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무',
      };
    }

    // Home Win / Away Win / Draw fallback
    if (!result) {
      const allText = grandparent.text().toLowerCase();
      if (allText.includes('home win')) result = { predicted_score: null, predicted_result: '승' };
      else if (allText.includes('away win')) result = { predicted_score: null, predicted_result: '패' };
      else if (allText.includes('draw')) result = { predicted_score: null, predicted_result: '무' };
    }
  });

  return result;
}

// predictz: table tr 구조, 팀명은 a 태그, 스코어는 마지막 td
function parsePredictz(html, homeEn, awayEn) {
  const $ = cheerio.load(html);
  let result = null;

  $('tr').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    // 모든 td에서 스코어 패턴 찾기
    $(row).find('td, span, a, div').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = {
          predicted_score: `${hg}-${ag}`,
          predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무',
        };
      }
    });

    // 1X2 fallback
    if (!result) {
      const cells = $(row).find('td');
      cells.each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        if (t === '1') result = { predicted_score: null, predicted_result: '승' };
        else if (t === '2') result = { predicted_score: null, predicted_result: '패' };
        else if (t.toUpperCase() === 'X') result = { predicted_score: null, predicted_result: '무' };
      });
    }
  });

  return result;
}

// forebet: .rcnt 컨테이너, 스코어는 .ex_sc 또는 .foremark
function parseForebet(html, homeEn, awayEn) {
  const $ = cheerio.load(html);
  let result = null;

  // forebet의 각 경기 블록
  $('.rcnt, tr, [class*="prevRes"]').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    // 스코어 찾기
    $(row).find('[class*="ex_sc"], [class*="score"], .foremark, span, div').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = {
          predicted_score: `${hg}-${ag}`,
          predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무',
        };
      }
    });

    // 1X2 fallback: 가장 높은 확률의 결과
    if (!result) {
      const probs = {};
      $(row).find('[class*="fprc"], [class*="prob"]').each((i, el) => {
        const pct = parseInt($(el).text().trim());
        if (pct > 0) probs[i] = pct;
      });
      const keys = Object.keys(probs);
      if (keys.length >= 3) {
        const maxI = keys.reduce((a, b) => probs[a] > probs[b] ? a : b);
        const idx = parseInt(maxI);
        if (idx === 0) result = { predicted_score: null, predicted_result: '승', confidence: probs[maxI] };
        else if (idx === 1) result = { predicted_score: null, predicted_result: '무', confidence: probs[maxI] };
        else if (idx === 2) result = { predicted_score: null, predicted_result: '패', confidence: probs[maxI] };
      }
    }
  });

  return result;
}

// vitibet: table tr 구조
function parseVitibet(html, homeEn, awayEn) {
  const $ = cheerio.load(html);
  let result = null;

  $('tr').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    // 스코어 패턴
    $(row).find('td, span, a').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = {
          predicted_score: `${hg}-${ag}`,
          predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무',
        };
      }
    });

    // 1X2 fallback
    if (!result) {
      $(row).find('td, span').each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        if (t === '1') result = { predicted_score: null, predicted_result: '승' };
        else if (t === '2') result = { predicted_score: null, predicted_result: '패' };
        else if (t.toUpperCase() === 'X') result = { predicted_score: null, predicted_result: '무' };
      });
    }
  });

  return result;
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
