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
  res.json({ status: 'ok', service: 'proto-scraper-server', scraping: isRunning, time: new Date().toISOString() });
});

// ====== SCRAPE LOCK ======
let isRunning = false;

// ====== SCRAPE & SAVE (비동기 - 즉시 응답) ======
app.post('/scrape-and-save', auth, async (req, res) => {
  if (isRunning) {
    return res.json({ message: 'Already running, skipped', timestamp: new Date().toISOString() });
  }
  res.json({ message: 'Scraping started', timestamp: new Date().toISOString() });
  doScrapeAndSave().catch(e => console.error('Background scrape error:', e.message));
});

// ====== 수동 트리거 (GET) ======
app.get('/scrape-and-save', auth, async (req, res) => {
  if (isRunning) {
    return res.json({ message: 'Already running, skipped', timestamp: new Date().toISOString() });
  }
  res.json({ message: 'Scraping started', timestamp: new Date().toISOString() });
  doScrapeAndSave().catch(e => console.error('Background scrape error:', e.message));
});

async function doScrapeAndSave() {
  if (isRunning) return;
  isRunning = true;

  try {
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

    // 2. 각 사이트를 하나씩 가져오고, 파싱하고, HTML 해제 (메모리 절약)
    const sources = [
      { name: 'windrawwin', url: 'https://www.windrawwin.com/predictions/today/', wait: null },
      { name: 'predictz', url: 'https://www.predictz.com/predictions/', wait: null },
      { name: 'forebet', url: 'https://www.forebet.com/en/football-predictions', wait: null },
      { name: 'vitibet', url: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en', wait: null },
    ];

    let saved = 0;

    for (const src of sources) {
      let html = '';
      try {
        console.log(`  Fetching ${src.name}...`);
        html = await getPage(src.url, src.wait);
        console.log(`  ${src.name}: ${html.length} chars`);
      
      // predictz/forebet HTML 구조 디버그
      if (src.name === 'predictz' || src.name === 'forebet') {
        // 팀명이 있는지 확인
        const testTeams = ['Liverpool', 'Rennes', 'Dortmund', 'Monaco', 'Ajax'];
        for (const t of testTeams) {
          const idx = html.toLowerCase().indexOf(t.toLowerCase());
          if (idx >= 0) {
            const snippet = html.substring(Math.max(0, idx - 100), idx + 200).replace(/\n/g, ' ').replace(/\s+/g, ' ');
            console.log(`  ${src.name} FOUND "${t}" at ${idx}: ...${snippet}...`);
            break;
          }
        }
        if (!testTeams.some(t => html.toLowerCase().includes(t.toLowerCase()))) {
          console.log(`  ${src.name} WARNING: no known team found in HTML!`);
          console.log(`  ${src.name} HTML preview: ${html.substring(0, 500).replace(/\n/g, ' ')}`);
        }
      }
      } catch (e) {
        console.log(`  ${src.name}: FAILED - ${e.message}`);
        continue;
      }

      // 브라우저 닫아서 메모리 확보
      if (browser) {
        try { await browser.close(); } catch(e) {}
        browser = null;
      }

      // 바로 파싱 & 저장
      let matched = 0, unmatched = 0;
      for (const match of matches || []) {
        if (!match.home_team_en || !match.away_team_en) continue;
        const p = extractPrediction(html, match.home_team_en, match.away_team_en, src.name);
        if (p) {
          matched++;
          const result = await supabaseUpsert('predictions', {
            match_id: match.id,
            source: src.name,
            predicted_score: p.predicted_score || null,
            predicted_result: p.predicted_result || null,
            confidence: p.confidence || null,
            scraped_at: new Date().toISOString(),
          }, 'match_id,source');

          if (result.ok) saved++;
          else {
            const errBody = result.body || '';
            console.log(`  DB error: ${src.name} #${match.match_number}: ${result.status} ${errBody}`);
          }
        } else {
          unmatched++;
        }
      }
      console.log(`  ${src.name}: ${matched} matched, ${unmatched} unmatched`);
      
      // predictz/forebet 디버그: 처음 5개 미매칭 팀명 로그
      if ((src.name === 'predictz' || src.name === 'forebet') && unmatched > matched) {
        let debugCount = 0;
        for (const match of matches || []) {
          if (debugCount >= 5) break;
          if (!match.home_team_en || !match.away_team_en) continue;
          const p = extractPrediction(html, match.home_team_en, match.away_team_en, src.name);
          if (!p) {
            console.log(`  DEBUG ${src.name}: no match for "${match.home_team_en}" vs "${match.away_team_en}"`);
            debugCount++;
          }
        }
      }

      // HTML 메모리 해제
      html = '';
    }

    console.log(`=== Done: ${saved} predictions saved ===`);

  } finally {
    isRunning = false;
    // 최종 브라우저 정리
    if (browser) {
      try { await browser.close(); } catch(e) {}
      browser = null;
    }
  }
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

// predictz: 다양한 HTML 구조 탐색
function parsePredictz(html, homeEn, awayEn) {
  const $ = cheerio.load(html);
  let result = null;

  // 1차: tr 기반
  $('tr, div[class*="pointed"], div[class*="match"], div[class*="row"], div[class*="fixture"]').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    // 스코어 찾기 (다양한 패턴)
    $(row).find('td, span, a, div, strong, b, em').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      // N-N 또는 N - N 패턴
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
      const cells = $(row).find('td, span, div');
      cells.each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        if (t === '1') result = { predicted_score: null, predicted_result: '승' };
        else if (t === '2') result = { predicted_score: null, predicted_result: '패' };
        else if (t.toUpperCase() === 'X') result = { predicted_score: null, predicted_result: '무' };
      });
    }

    // Home/Away/Draw text fallback
    if (!result) {
      const allText = $(row).text().toLowerCase();
      if (allText.includes('home win') || allText.includes('home')) result = { predicted_score: null, predicted_result: '승' };
      else if (allText.includes('away win') || allText.includes('away')) result = { predicted_score: null, predicted_result: '패' };
      else if (allText.includes('draw')) result = { predicted_score: null, predicted_result: '무' };
    }
  });

  // 2차: 전체 HTML에서 텍스트 기반 검색 (fallback)
  if (!result) {
    const allText = $.text();
    // "Dortmund v Mainz" 또는 "Dortmund vs Mainz" 같은 패턴 찾기
    const homeWords = homeEn.toLowerCase().split(/\s+/);
    const keyWord = homeWords.find(w => w.length >= 4) || homeWords[0];
    
    $('a, span, div, td').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      if (t.length > 200) return;
      if (!fuzzy(t, homeEn) || !fuzzy(t, awayEn)) return;
      
      // 부모/형제에서 스코어 찾기
      const parent = $(el).parent();
      const grandparent = parent.parent();
      
      for (const container of [parent, grandparent]) {
        if (result) return;
        container.find('td, span, a, div, strong').each((_, scoreEl) => {
          if (result) return;
          const st = $(scoreEl).text().trim();
          const sm = st.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
          if (sm) {
            const hg = parseInt(sm[1]), ag = parseInt(sm[2]);
            result = {
              predicted_score: `${hg}-${ag}`,
              predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무',
            };
          }
        });
      }
    });
  }

  return result;
}

// forebet: 다양한 HTML 구조 탐색
function parseForebet(html, homeEn, awayEn) {
  const $ = cheerio.load(html);
  let result = null;

  // forebet의 각 경기 블록 - 더 넓은 셀렉터
  $('.rcnt, tr, div[class*="match"], div[class*="pred"], div[class*="row"], div[class*="contentRow"]').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (text.length > 2000) return; // 너무 큰 컨테이너 스킵
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    // 스코어 찾기
    $(row).find('[class*="ex_sc"], [class*="score"], .foremark, span, div, td, strong').each((_, el) => {
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
      $(row).find('[class*="fprc"], [class*="prob"], [class*="prc"]').each((i, el) => {
        const pct = parseInt($(el).text().trim());
        if (pct > 0 && pct <= 100) probs[i] = pct;
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

    // 1/X/2 text fallback
    if (!result) {
      const allText = $(row).text();
      const tip = allText.match(/tip[:\s]*([1X2])/i);
      if (tip) {
        if (tip[1] === '1') result = { predicted_score: null, predicted_result: '승' };
        else if (tip[1] === '2') result = { predicted_score: null, predicted_result: '패' };
        else if (tip[1].toUpperCase() === 'X') result = { predicted_score: null, predicted_result: '무' };
      }
    }
  });

  // 2차: 전체 검색
  if (!result) {
    $('a, span, div, td').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      if (t.length > 200) return;
      if (!fuzzy(t, homeEn) || !fuzzy(t, awayEn)) return;
      
      const parent = $(el).parent();
      const grandparent = parent.parent();
      
      for (const container of [parent, grandparent]) {
        if (result) return;
        container.find('span, div, td, strong').each((_, scoreEl) => {
          if (result) return;
          const st = $(scoreEl).text().trim();
          const sm = st.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
          if (sm) {
            const hg = parseInt(sm[1]), ag = parseInt(sm[2]);
            result = {
              predicted_score: `${hg}-${ag}`,
              predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무',
            };
          }
        });
      }
    });
  }

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

// ====== HTML SAMPLE - 가벼운 디버그 (팀명 주변 HTML) ======
app.get('/html-sample/:site/:team', auth, async (req, res) => {
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
    const html = await getPage(urls[site], null);
    
    // 팀명이 포함된 부분 찾기
    const idx = html.toLowerCase().indexOf(team.toLowerCase());
    const samples = [];
    
    if (idx >= 0) {
      // 팀명 주변 500자
      const start = Math.max(0, idx - 200);
      const end = Math.min(html.length, idx + 300);
      samples.push(html.substring(start, end));
    }
    
    // cheerio로 팀명 포함된 행 찾기
    const $ = cheerio.load(html);
    const rows = [];
    $('tr, .rcnt, div[class*="match"], div[class*="row"]').each((_, el) => {
      const text = $(el).text();
      if (text.toLowerCase().includes(team.toLowerCase()) && text.length < 1000) {
        rows.push({
          tag: el.name,
          class: $(el).attr('class') || '',
          html: $.html(el).substring(0, 500),
          text: text.substring(0, 300),
        });
      }
    });

    // 브라우저 닫기
    if (browser) { try { await browser.close(); } catch(e) {} browser = null; }

    res.json({ 
      site, team, found: idx >= 0, htmlLength: html.length,
      context: samples[0] || 'NOT FOUND',
      matchingRows: rows.slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== 한국팀명 → 영문팀명 매핑 ======
const TEAM_MAP = {
  // A-League
  '웨스원더': 'Western Sydney', '웰링피닉': 'Wellington Phoenix', '멜버빅토': 'Melbourne Victory',
  '브리로어': 'Brisbane Roar', '시드니FC': 'Sydney FC', '애들유나': 'Adelaide United',
  '퍼스글로': 'Perth Glory', '뉴캐제츠': 'Newcastle Jets', '센트마리': 'Central Coast Mariners',
  '맥아서': 'Macarthur FC', '멜버시티': 'Melbourne City', '오클랜드': 'Auckland FC',
  // J리그 / J2리그
  '비셀고베': 'Vissel Kobe', 'V바렌나': 'V-Varen Nagasaki', '가시마': 'Kashima Antlers',
  '요코마리': 'Yokohama F. Marinos', 'FC도쿄': 'FC Tokyo', '우라와': 'Urawa Reds',
  '마치다': 'Machida Zelvia', '미토': 'Mito HollyHock', '시미즈': 'Shimizu S-Pulse',
  '교토상가': 'Kyoto Sanga', '산프히로': 'Sanfrecce Hiroshima', '오카야마': 'Fagiano Okayama',
  '요코FC': 'Yokohama FC', '센다이': 'Vegalta Sendai', 'RB오미야': 'Omiya Ardija',
  '삿포로': 'Consadole Sapporo', '가시와': 'Kashiwa Reysol', '도쿄베르': 'Tokyo Verdy',
  '도치기시': 'Tochigi SC', '아키타': 'Blaublitz Akita', '도쿠시마': 'Tokushima Vortis',
  '니가타': 'Albirex Niigata', '후쿠오카': 'Avispa Fukuoka', 'C오사카': 'Cerezo Osaka',
  'G오사카': 'Gamba Osaka', '나고야': 'Nagoya Grampus', '제프유나': 'JEF United',
  '가와사키': 'Kawasaki Frontale', '코후': 'Ventforet Kofu', '주빌로': 'Jubilo Iwata',
  '사간도스': 'Sagan Tosu', '나가사키': 'V-Varen Nagasaki', '히로시마': 'Sanfrecce Hiroshima',
  '세레소': 'Cerezo Osaka', '간바': 'Gamba Osaka', '우라와레': 'Urawa Reds',
  '삿포로콘': 'Consadole Sapporo', '요코하마': 'Yokohama F. Marinos',
  // Premier League
  '리버풀': 'Liverpool', '브라이턴': 'Brighton', 'A빌라': 'Aston Villa', '뉴캐슬U': 'Newcastle United',
  '맨시티': 'Manchester City', '아스널': 'Arsenal', '첼시': 'Chelsea', '맨유': 'Manchester United',
  '토트넘': 'Tottenham', '에버턴': 'Everton', '웨스트햄': 'West Ham', '풀럼': 'Fulham',
  '본머스': 'Bournemouth', '울버햄프': 'Wolverhampton', '크리스탈': 'Crystal Palace',
  '노팅엄': 'Nottingham Forest', '브렌트포': 'Brentford', '사우샘프': 'Southampton',
  '레스터C': 'Leicester City', '입스위치': 'Ipswich Town', '리즈유나': 'Leeds United',
  '선덜랜드': 'Sunderland', '번리': 'Burnley',
  // Championship
  '헐시티': 'Hull City', '렉섬': 'Wrexham', '더비카운': 'Derby County', '스완지C': 'Swansea City',
  '포츠머스': 'Portsmouth', '셰필드U': 'Sheffield United', '프레스턴': 'Preston', '왓포드': 'Watford',
  '퀸즈파크': 'QPR', '블랙번': 'Blackburn', '셰필드웬': 'Sheffield Wednesday', '밀월': 'Millwall',
  '노리치C': 'Norwich City', '웨스브로': 'West Brom', '버밍엄C': 'Birmingham City', '리즈U': 'Leeds United',
  '옥스퍼드': 'Oxford United', '스토크C': 'Stoke City', '카디프': 'Cardiff City',
  '미들즈브': 'Middlesbrough', '코벤트리': 'Coventry City', '루턴타운': 'Luton Town',
  '플리머스': 'Plymouth Argyle', '브리스톨': 'Bristol City',
  // La Liga
  '에스파뇰': 'Espanyol', 'RC셀타': 'Celta Vigo', '헤타페': 'Getafe', '비야레알': 'Villarreal',
  '세비야': 'Sevilla', '알라베스': 'Alaves', '레알마드': 'Real Madrid', '소시에다': 'Real Sociedad',
  '라요': 'Rayo Vallecano', 'AT마드': 'Atletico Madrid', '마요르카': 'Mallorca', '베티스': 'Real Betis',
  '바르셀로': 'Barcelona', '발렌시아': 'Valencia', '오사수나': 'Osasuna', '지로나': 'Girona',
  '라스팔마': 'Las Palmas', '레가네스': 'Leganes', '발라돌리': 'Real Valladolid',
  // La Liga 2
  '레반테': 'Levante', '오비에도': 'Real Oviedo', '빌바오': 'Athletic Bilbao',
  // Serie A
  '피사SC': 'Pisa', 'AC밀란': 'AC Milan', '코모1907': 'Como', '피오렌티': 'Fiorentina',
  '라치오': 'Lazio', '아탈란타': 'Atalanta', '인테르': 'Inter Milan', '유벤투스': 'Juventus',
  '우디네세': 'Udinese', '사수올로': 'Sassuolo', '크레모네': 'Cremonese', '제노아': 'Genoa',
  '파르마': 'Parma', '엘라스': 'Hellas Verona', '토리노': 'Torino', '볼로나': 'Bologna',
  '나폴리': 'Napoli', 'AS로마': 'AS Roma', '엠폴리': 'Empoli', '카글리아': 'Cagliari',
  '레체': 'Lecce', '몬자': 'Monza', '베네치아': 'Venezia', '사레르니': 'Salernitana',
  // Bundesliga
  '도르트문': 'Dortmund', '마인츠05': 'Mainz', '레버쿠젠': 'Bayer Leverkusen', '장크트파': 'St. Pauli',
  '프랑크푸': 'Eintracht Frankfurt', '뮌헨글라': 'Monchengladbach', '브레멘': 'Werder Bremen',
  '바이뮌헨': 'Bayern Munich', '호펜하임': 'Hoffenheim', '프라이부': 'Freiburg',
  '슈투트가': 'Stuttgart', '퀼른': 'Koln', '아우크스': 'Augsburg', '하이덴하': 'Heidenheim',
  '라이프치': 'RB Leipzig', '볼프스부': 'Wolfsburg', '보훔': 'Bochum', '볼프스': 'Wolfsburg',
  '다름슈타': 'Darmstadt',
  // Bundesliga 2
  '함부르크': 'Hamburger SV', 'U베를린': 'Union Berlin',
  // Ligue 1
  '스타드렌': 'Rennes', 'PSG': 'PSG', 'AS모나코': 'Monaco', '낭트': 'Nantes',
  '마르세유': 'Marseille', 'RC스트라': 'Strasbourg', '릴OSC': 'Lille', '브레스투': 'Brest',
  '르아브르': 'Le Havre', '툴루즈': 'Toulouse', '메스': 'Metz', '오세르': 'Auxerre',
  '리옹': 'Lyon', 'OGC니스': 'Nice', '랑스': 'Lens', '몽펠리에': 'Montpellier',
  '클레르몽': 'Clermont', '로리앙': 'Lorient',
  // Ligue 2
  '파리FC': 'Paris FC', '앙제SCO': 'Angers SCO',
  // Eredivisie
  '플렌담': 'Feyenoord', 'PSV': 'PSV', '헤라클레': 'Heracles', '브레다': 'NAC Breda',
  '엑셀시오': 'Excelsior', '알크마르': 'AZ Alkmaar', '아약스': 'Ajax', 'F시타르': 'Fortuna Sittard',
  '흐로닝언': 'Groningen', '위트레흐': 'Utrecht', '페예노르': 'Feyenoord', '고어헤드': 'Go Ahead Eagles',
  '헤이렌베': 'Heerenveen', '즈볼러': 'PEC Zwolle', '스파로테': 'Sparta Rotterdam',
  '네이메헌': 'NEC Nijmegen', '트벤테': 'Twente', '텔스타': 'Telstar',
  // 한국 리그명 매핑
  '엘체': 'Elche', '오사수니': 'Osasuna',
};

// 리그명 매핑 (와이즈토토 → DB)
const LEAGUE_MAP = {
  'A리그': 'A-League', 'J1백년': 'J리그', 'J2백년': 'J2리그', 'J1리그': 'J리그', 'J2리그': 'J2리그',
  '프리미어': 'PremierLeague', 'EPL': 'PremierLeague',
  'EFL챔': 'Championship', 'EFL챔피': 'Championship',
  '라리가': 'LaLiga', '라리가2': 'LaLiga2', '세리에A': 'SerieA', '세리에B': 'SerieB',
  '분데스리': 'Bundesliga', '분데스2': 'Bundesliga2',
  '프리그1': 'Ligue1', '리그1': 'Ligue1', '리그2': 'Ligue2', '프리그2': 'Ligue2',
  '에레디비': 'Eredivisie', '에레디2': 'Eredivisie2',
  // 축약형
  'A리그': 'A-League',
};

// ====== FETCH MATCHES FROM WISETOTO ======
app.get('/fetch-matches', auth, async (req, res) => {
  res.json({ message: 'Fetching matches started', timestamp: new Date().toISOString() });
  doFetchMatches().catch(e => console.error('Fetch matches error:', e.message));
});

async function doFetchMatches() {
  console.log('=== Fetching matches from WiseToto ===');
  
  let b = null;
  try {
    b = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote'],
    });

    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 1. 와이즈토토 메인 → 프로토 승부식 페이지
    console.log('  Loading wisetoto...');
    await page.goto('https://www.wisetoto.com/index.htm?tab_type=proto&game_type=pt&game_category=pt1', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 5000));

    // 2. 축구 버튼 클릭
    console.log('  Clicking soccer filter...');
    try {
      await page.evaluate(() => {
        const btn = document.querySelector('a.btn.soccer, a[title="축구"]');
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.log('  Soccer button click failed, trying without filter');
    }

    // 3. HTML 가져오기
    const html = await page.content();
    console.log(`  HTML: ${html.length} chars`);
    await page.close();

    // 4. 회차 정보 파싱
    const $ = cheerio.load(html);
    
    // 회차 번호 추출
    let roundYear = new Date().getFullYear().toString();
    let roundNumber = null;
    
    // "2026년도" / "20회차" 텍스트에서 추출
    const yearText = $('select, .year, [class*="year"]').text() || html;
    const roundMatch = html.match(/(\d{4})년도.*?(\d+)회차/s) || html.match(/game_year=(\d{4})&game_round=(\d+)/);
    if (roundMatch) {
      roundYear = roundMatch[1];
      roundNumber = parseInt(roundMatch[2]);
    }
    
    // fallback: select option에서 찾기
    if (!roundNumber) {
      $('select option[selected], .round_select option[selected]').each((_, el) => {
        const t = $(el).text().trim();
        const m = t.match(/(\d+)회차/);
        if (m) roundNumber = parseInt(m[1]);
      });
    }
    
    console.log(`  Round: ${roundYear}-${roundNumber || '?'}`);

    // 5. 경기 목록 파싱 - 테이블 행에서 추출
    const matches = [];
    
    $('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 5) return;
      
      const no = $(cells[0]).text().trim();
      const matchNum = parseInt(no);
      if (isNaN(matchNum)) return;
      
      // 유형 칸 확인 - 비어있으면 일반 승무패
      const typeCell = $(cells[3]).text().trim();
      if (typeCell && typeCell !== '') return; // H, U, SUM 등은 스킵
      
      const league = $(cells[2]).text().trim().replace(/[⚽🏀🏐⚾]/g, '').trim();
      const matchInfo = $(cells[4]).text().trim(); // "홈팀 vs 원정팀" 또는 "홈팀 N : N 원정팀"
      
      // 홈팀, 원정팀 추출
      // 패턴: "홈팀 N : N 원정팀" 또는 "홈팀 : 원정팀"
      let homeKr = '', awayKr = '';
      
      // 링크에서 팀명 추출 시도
      const links = $(cells[4]).find('a');
      if (links.length >= 2) {
        homeKr = $(links[0]).text().trim();
        awayKr = $(links[1]).text().trim();
      } else {
        // 텍스트에서 추출: "홈팀 N : N 원정팀" or "홈팀 : 원정팀"
        const cleaned = matchInfo.replace(/\d+\s*:\s*\d+/, ':').replace(/\s+/g, ' ');
        const parts = cleaned.split(':').map(s => s.trim());
        if (parts.length === 2) {
          homeKr = parts[0].replace(/\d+$/, '').trim();
          awayKr = parts[1].replace(/^\d+/, '').trim();
        }
      }
      
      if (!homeKr || !awayKr) return;
      
      // 영문팀명 매핑
      const homeEn = TEAM_MAP[homeKr] || '';
      const awayEn = TEAM_MAP[awayKr] || '';
      const leagueDb = LEAGUE_MAP[league] || league;
      
      matches.push({
        round_year: roundYear,
        round_number: roundNumber,
        match_number: matchNum,
        home_team_kr: homeKr,
        away_team_kr: awayKr,
        home_team_en: homeEn,
        away_team_en: awayEn,
        league: leagueDb,
        match_type: 'normal',
      });
    });

    console.log(`  Parsed ${matches.length} soccer matches`);
    
    if (!matches.length) {
      console.log('  No matches found, check HTML structure');
      return;
    }

    // 영문명 없는 팀 로그
    const unmapped = matches.filter(m => !m.home_team_en || !m.away_team_en);
    if (unmapped.length) {
      console.log(`  ⚠ ${unmapped.length} matches with unmapped teams:`);
      unmapped.forEach(m => {
        if (!m.home_team_en) console.log(`    Missing: '${m.home_team_kr}'`);
        if (!m.away_team_en) console.log(`    Missing: '${m.away_team_kr}'`);
      });
    }

    // 6. Supabase에 upsert
    const result = await supabaseUpsert('proto_matches', matches, 'round_year,round_number,match_number');
    console.log(`  DB upsert: ${result.status} (${result.ok ? 'OK' : 'FAIL'})`);
    if (!result.ok) console.log(`  DB error: ${result.body}`);
    
    console.log(`=== Done: ${matches.length} matches saved for round ${roundYear}-${roundNumber} ===`);

  } catch (e) {
    console.error('Fetch matches error:', e.message);
  } finally {
    if (b) await b.close().catch(() => {});
  }
}

// ====== START ======
app.listen(PORT, () => {
  console.log(`Proto Scraper Server running on port ${PORT}`);
  
  // 서버 시작 후 10초 뒤 자동 스크래핑 (Render가 깨어날 때마다)
  setTimeout(async () => {
    try {
      // 먼저 경기 수 확인 → 부족하면 와이즈토토에서 가져오기
      const latest = await supabaseGet('proto_matches',
        'match_type=eq.normal&order=round_number.desc&limit=1&select=round_year,round_number');
      
      if (latest?.length) {
        const { round_year, round_number } = latest[0];
        const matches = await supabaseGet('proto_matches',
          `round_year=eq.${round_year}&round_number=eq.${round_number}&match_type=eq.normal&select=id`);
        
        console.log(`Current matches in DB: ${matches?.length || 0}`);
        
        if (!matches?.length || matches.length < 30) {
          console.log('Auto-trigger: fetching matches from WiseToto first...');
          await doFetchMatches();
          await new Promise(r => setTimeout(r, 5000)); // 5초 대기
        }
      }
      
      console.log('Auto-trigger: scraping on startup...');
      await doScrapeAndSave();
    } catch (e) {
      console.error('Auto startup error:', e.message);
    }
  }, 10000);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
