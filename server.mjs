import express from 'express';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';

puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra;

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

async function getPage(url, waitSelector, timeout = 60000, extraWait = 0, humanize = false) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  
  // forebet/predictz (extraWait > 0): Cloudflare 우회를 위해 요청 차단 없이 완전한 브라우저로
  if (extraWait === 0) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const blockTypes = ['image', 'font', 'media'];
      const blockUrls = ['google-analytics', 'googletagmanager', 'facebook', 'doubleclick'];
      const u = req.url();
      if (blockTypes.includes(type) || blockUrls.some(b => u.includes(b))) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  try {
    const waitUntil = extraWait > 0 ? 'networkidle2' : 'domcontentloaded';
    await page.goto(url, { waitUntil, timeout });
    
    if (extraWait > 0) {
      // Cloudflare 챌린지 대기: 최대 90초 동안 실제 콘텐츠 나타날 때까지 폴링
      console.log(`  Waiting for Cloudflare challenge...`);
      
      // 인간처럼 행동: 마우스 이동 + 스크롤 (humanize 모드)
      if (humanize) {
        try {
          await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 100);
          await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
          await page.mouse.move(600 + Math.random() * 100, 400 + Math.random() * 100);
          await new Promise(r => setTimeout(r, 300));
          await page.evaluate(() => window.scrollBy(0, 100));
        } catch(e) {}
      }
      
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const title = await page.title();
        console.log(`  CF check ${i+1}/18: title="${title}"`);
        if (!title.includes('moment') && !title.includes('Just') && !title.includes('Checking')) break;
        
        // 3회 폴링마다 마우스 이동 (인간처럼)
        if (humanize && i % 3 === 2) {
          try {
            await page.mouse.move(300 + Math.random() * 400, 200 + Math.random() * 300);
            await page.evaluate(() => window.scrollBy(0, 50 + Math.random() * 100));
          } catch(e) {}
        }
      }
      // 추가 대기: 페이지 로딩 완료
      await new Promise(r => setTimeout(r, 3000));
    } else {
      await new Promise(r => setTimeout(r, 3000));
    }
    
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
    // 프로토 경기는 수목금에 걸쳐있으므로 today + tomorrow + weekend 모두 가져와야 함
    const sources = [
      { name: 'windrawwin', urls: [
        'https://www.windrawwin.com/predictions/today/',
        'https://www.windrawwin.com/predictions/tomorrow/',
        'https://www.windrawwin.com/predictions/weekend/',
      ], wait: null, extraWait: 0 },
      { name: 'predictz', urls: [
        'https://www.predictz.com/predictions/',
        'https://www.predictz.com/predictions/tomorrow/',
      ], wait: null, extraWait: 15000 },
      // forebet: Cloudflare Turnstile 완전 차단 - footballpredictions.ai로 대체
      { name: 'fpai', urls: [
        'https://footballpredictions.ai/football-predictions/correct-score-predictions/',
        'https://footballpredictions.ai/tomorrow',
        'https://footballpredictions.ai/after-tomorrow',
        'https://footballpredictions.ai/weekend',
      ], wait: null, extraWait: 0 },
      { name: 'vitibet', urls: [
        // quicktips (승/무/패만 + 7일치 커버리지)
        'https://www.vitibet.com/index.php?clanek=quicktips_toptips&sekce=fotbal&lang=en',
        'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en',
        // 리그별 tips 페이지 (스코어 포함!)
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=champions2&lang=en',  // UCL
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=champions3&lang=en',  // UEL
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=champions4&lang=en',  // UECL
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=anglie&lang=en',      // EPL
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=spanelsko&lang=en',   // La Liga
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=italie&lang=en',      // Serie A
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=nemecko&lang=en',     // Bundesliga
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=francie&lang=en',     // Ligue 1
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=holandsko&lang=en',   // Eredivisie
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=australie&lang=en',   // A-League
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=japonsko&lang=en',    // J-League
      ], wait: null, extraWait: 0 },
    ];

    let saved = 0;

    for (const src of sources) {
      // 여러 URL의 HTML을 합침
      let html = '';
      try {
        for (let i = 0; i < src.urls.length; i++) {
          const url = src.urls[i];
          const label = i === 0 ? src.name : `${src.name}[${i}]`;
          console.log(`  Fetching ${label}...`);
          
          let pageHtml = '';
          try {
            pageHtml = await getPage(url, src.wait, 60000, src.extraWait || 0, src.humanize || false);
            console.log(`  ${label}: ${pageHtml.length} chars`);
          } catch (e) {
            console.log(`  ${label}: FAILED - ${e.message}`);
            continue;
          }
          
          // Cloudflare 차단 확인
          if (pageHtml.includes('Just a moment') || pageHtml.includes('Checking your browser')) {
            console.log(`  ${label} WARNING: Cloudflare blocked! Skipping this URL...`);
            continue;
          }
          
          html += '\n' + pageHtml;

          // 브라우저 닫아서 메모리 확보 (각 페이지 후)
          if (browser) {
            try { await browser.close(); } catch(e) {}
            browser = null;
          }
        }
        
        console.log(`  ${src.name} TOTAL: ${html.length} chars`);
        
        if (html.length > 0) {
          // 팀명 존재 확인
          const testTeams = ['Liverpool', 'Arsenal', 'Barcelona', 'Bayern', 'Juventus', 'Dortmund', 'Monaco', 'Ajax', 'PSV', 'Napoli'];
          const foundTeam = testTeams.find(t => html.toLowerCase().includes(t.toLowerCase()));
          if (foundTeam) {
            console.log(`  ${src.name} OK: found team "${foundTeam}" in HTML`);
          } else {
            console.log(`  ${src.name} WARNING: no known team found in combined HTML!`);
          }
        }
      } catch (e) {
        console.log(`  ${src.name}: FAILED - ${e.message}`);
        continue;
      }

      if (!html) continue;

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
      
      // 디버그: 처음 10개 미매칭 팀명 로그
      if (unmatched > 0) {
        let debugCount = 0;
        for (const match of matches || []) {
          if (debugCount >= 10) break;
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
    const extraWait = (site === 'forebet' || site === 'predictz') ? 15000 : 0;
    const html = await getPage(urls[site], null, 60000, extraWait);
    const blocked = html.includes('Just a moment') || html.includes('Checking your browser');
    res.json({ site, chars: html.length, blocked, preview: html.substring(0, 500), timestamp: new Date().toISOString() });
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
    const extraWait = (site === 'forebet' || site === 'predictz') ? 15000 : 0;
    const html = await getPage(urls[site], null, 60000, extraWait);
    const $ = cheerio.load(html);
    const found = [];
    
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

    const unique = found.sort((a, b) => a.text.length - b.text.length).slice(0, 10);
    const blocked = html.includes('Just a moment') || html.includes('Checking your browser');

    if (browser) { try { await browser.close(); } catch(e) {} browser = null; }
    res.json({ site, team, total_found: found.length, blocked, matches: unique, html_length: html.length });
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
      case 'fpai': return parseFpai(html, homeEn, awayEn);
      case 'vitibet': return parseVitibet(html, homeEn, awayEn);
      default: return null;
    }
  } catch (e) {
    return null;
  }
}

// windrawwin: div.wttd.wtfixt 에 팀명, span.predscore 에 스코어
let _wdwCache = { html: null, $: null };
function parseWindrawwin(html, homeEn, awayEn) {
  let $;
  if (_wdwCache.html === html) { $ = _wdwCache.$; }
  else { $ = cheerio.load(html); _wdwCache = { html, $ }; }
  let result = null;

  $('div.wtfixt, div[class*="wtfixt"]').each((_, row) => {
    if (result) return;
    const text = $(row).text();
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    const parent = $(row).parent();
    const grandparent = parent.parent();
    
    let score = '';
    for (const container of [parent, grandparent]) {
      const sc = container.find('.predscore').first().text().trim();
      if (sc) { score = sc; break; }
      const sc2 = container.find('.wtsc').first().text().trim();
      if (sc2) { score = sc2; break; }
    }

    if (!score) {
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

    if (!result) {
      const allText = grandparent.text().toLowerCase();
      if (allText.includes('home win')) result = { predicted_score: null, predicted_result: '승' };
      else if (allText.includes('away win')) result = { predicted_score: null, predicted_result: '패' };
      else if (allText.includes('draw')) result = { predicted_score: null, predicted_result: '무' };
    }
  });

  // Fallback: tr 기반
  if (!result) {
    $('tr').each((_, row) => {
      if (result) return;
      const text = $(row).text();
      if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;
      $(row).find('td, span, a, div, strong').each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
        if (m) {
          const hg = parseInt(m[1]), ag = parseInt(m[2]);
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
        }
      });
    });
  }

  return result;
}

// predictz parser
let _predzCache = { html: null, $: null };
function parsePredictz(html, homeEn, awayEn) {
  let $;
  if (_predzCache.html === html) { $ = _predzCache.$; }
  else { $ = cheerio.load(html); _predzCache = { html, $ }; }
  let result = null;

  // ★ 전략 0: predictz 전용 - ptpredboxsml에서 "Draw 1-1", "Home 2-0", "Away 0-1" 추출
  $('div.pttr, div.ptcnt, div[class*="pttr"]').each((_, container) => {
    if (result) return;
    const text = $(container).text();
    if (text.length > 5000 || text.length < 10) return;
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    // ptpredboxsml 안에서 "Home 2-1", "Draw 1-1", "Away 0-2" 패턴
    $(container).find('div[class*="ptpredbox"], div[class*="predbox"], .ptpredboxsml').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      // "Draw 1-1", "Home 2-0", "Away 0-1" 형태
      const m = t.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
      }
    });

    // ptpredboxsml 못 찾으면 전체 텍스트에서 패턴 찾기
    if (!result) {
      const predMatch = text.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i);
      if (predMatch) {
        const hg = parseInt(predMatch[1]), ag = parseInt(predMatch[2]);
        result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
      }
    }
  });

  // 전략 1: 상위 컨테이너 (기존)
  if (!result) {
    $('div[class*="pointed"], div[class*="ptcon"], div[class*="ptdiv"], div[class*="pttr"], .pointed, table').each((_, container) => {
      if (result) return;
      const text = $(container).text();
      if (text.length > 5000 || text.length < 10) return;
      if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

      // 먼저 "Home/Draw/Away N-N" 패턴
      $(container).find('div, span, a, td, strong').each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        const predM = t.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i);
        if (predM) {
          const hg = parseInt(predM[1]), ag = parseInt(predM[2]);
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
          return;
        }
        const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
        if (m) {
          const hg = parseInt(m[1]), ag = parseInt(m[2]);
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
        }
      });

      if (!result) {
        const allText = $(container).text();
        const homeAwayDraw = allText.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i);
        if (homeAwayDraw) {
          const hg = parseInt(homeAwayDraw[1]), ag = parseInt(homeAwayDraw[2]);
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
        } else if (allText.toLowerCase().includes('home win')) {
          result = { predicted_score: null, predicted_result: '승' };
        } else if (allText.toLowerCase().includes('away win')) {
          result = { predicted_score: null, predicted_result: '패' };
        } else if (allText.toLowerCase().includes('draw')) {
          result = { predicted_score: null, predicted_result: '무' };
        }
      }
    });
  }

  // 전략 2: pptr 행
  if (!result) {
    $('div.pptr, .pptr').each((_, row) => {
      if (result) return;
      const text = $(row).text();
      if (!fuzzy(text, homeEn)) return;

      let container = $(row).parent();
      for (let depth = 0; depth < 5 && container.length; depth++) {
        const containerText = container.text();
        if (fuzzy(containerText, awayEn)) {
          // 먼저 "Home/Draw/Away N-N" 패턴
          const predM = containerText.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i);
          if (predM) {
            const hg = parseInt(predM[1]), ag = parseInt(predM[2]);
            result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
          } else {
            container.find('div, span, a, strong').each((_, el) => {
              if (result) return;
              const t = $(el).text().trim();
              const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
              if (m) {
                const hg = parseInt(m[1]), ag = parseInt(m[2]);
                result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
              }
            });
          }
          break;
        }
        container = container.parent();
      }
    });
  }

  // 전략 3: tr fallback
  if (!result) {
    $('tr').each((_, row) => {
      if (result) return;
      const text = $(row).text();
      if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;
      const predM = text.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i);
      if (predM) {
        const hg = parseInt(predM[1]), ag = parseInt(predM[2]);
        result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
        return;
      }
      $(row).find('td, span, a, div, strong').each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
        if (m) {
          const hg = parseInt(m[1]), ag = parseInt(m[2]);
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
        }
      });
    });
  }

  // 전략 4: 원시 HTML 검색
  if (!result) {
    result = rawHtmlSearch(html, homeEn, awayEn);
  }

  return result;
}

// forebet parser
function parseForebet(html, homeEn, awayEn) {
  const $ = cheerio.load(html);
  let result = null;

  // 전략 1: .rcnt
  $('.rcnt').each((_, row) => {
    if (result) return;
    const homeText = $(row).find('.homeTeam').text().trim();
    const awayText = $(row).find('.awayTeam').text().trim();
    
    if (homeText && awayText && fuzzy(homeText, homeEn) && fuzzy(awayText, awayEn)) {
      $(row).find('[class*="ex_sc"], [class*="score"], .foremark').each((_, el) => {
        if (result) return;
        const t = $(el).text().trim();
        const m = t.match(/(\d+)\s*[-–:]\s*(\d+)/);
        if (m) {
          const hg = parseInt(m[1]), ag = parseInt(m[2]);
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
        }
      });

      if (!result) {
        const probs = [];
        $(row).find('[class*="fprc"], [class*="prob"]').each((_, el) => {
          const pct = parseInt($(el).text().trim());
          if (pct > 0 && pct <= 100) probs.push(pct);
        });
        if (probs.length >= 3) {
          const maxIdx = probs.indexOf(Math.max(...probs));
          if (maxIdx === 0) result = { predicted_score: null, predicted_result: '승', confidence: probs[0] };
          else if (maxIdx === 1) result = { predicted_score: null, predicted_result: '무', confidence: probs[1] };
          else if (maxIdx === 2) result = { predicted_score: null, predicted_result: '패', confidence: probs[2] };
        }
      }

      if (!result) {
        const tipText = $(row).text();
        const tip = tipText.match(/(?:tip|pred)[:\s]*([1X2])/i);
        if (tip) {
          if (tip[1] === '1') result = { predicted_score: null, predicted_result: '승' };
          else if (tip[1] === '2') result = { predicted_score: null, predicted_result: '패' };
          else result = { predicted_score: null, predicted_result: '무' };
        }
      }
    }
  });

  // 전략 2: .tnms 블록
  if (!result) {
    $('.tnms').each((_, block) => {
      if (result) return;
      const homeText = $(block).find('.homeTeam').text().trim();
      const awayText = $(block).find('.awayTeam').text().trim();
      if (!homeText || !awayText) return;
      if (!fuzzy(homeText, homeEn) || !fuzzy(awayText, awayEn)) return;
      
      const parent = $(block).parent();
      const gp = parent.parent();
      
      for (const container of [parent, gp]) {
        if (result) return;
        container.find('[class*="ex_sc"], [class*="score"], .foremark, span, div').each((_, el) => {
          if (result) return;
          const t = $(el).text().trim();
          const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
          if (m) {
            const hg = parseInt(m[1]), ag = parseInt(m[2]);
            result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
          }
        });
        
        if (!result) {
          const probs = [];
          container.find('[class*="fprc"], [class*="prob"]').each((_, el) => {
            const pct = parseInt($(el).text().trim());
            if (pct > 0 && pct <= 100) probs.push(pct);
          });
          if (probs.length >= 3) {
            const maxIdx = probs.indexOf(Math.max(...probs));
            if (maxIdx === 0) result = { predicted_score: null, predicted_result: '승', confidence: probs[0] };
            else if (maxIdx === 1) result = { predicted_score: null, predicted_result: '무', confidence: probs[1] };
            else if (maxIdx === 2) result = { predicted_score: null, predicted_result: '패', confidence: probs[2] };
          }
        }
      }
    });
  }

  // 전략 3: 원시 HTML 검색
  if (!result) {
    result = rawHtmlSearch(html, homeEn, awayEn);
  }

  return result;
}

// footballpredictions.ai parser
function parseFpai(html, homeEn, awayEn) {
  if (!html) return null;
  
  const aliases = [...getAliases(homeEn), homeEn];
  const awayAliases = [...getAliases(awayEn), awayEn];
  
  // HTML에서 a 태그의 title 속성으로 팀명 매칭
  // 패턴: title="HomeTeam - AwayTeam" 안에 스코어 "N - M" 이 텍스트로 포함
  // correct-score 페이지 구조: <a ...>HomeTeam AwayTeam N - M</a>
  // 또는 일반 페이지: <a ...>HomeTeam AwayTeam</a> (스코어 없음)
  
  const cheerioLib = cheerio.load(html);
  let result = null;
  
  // 모든 a 태그 검색
  cheerioLib('a').each((_, el) => {
    if (result) return;
    const title = cheerioLib(el).attr('title') || '';
    const text = cheerioLib(el).text().trim();
    const href = cheerioLib(el).attr('href') || '';
    
    // predictions 링크만
    if (!href.includes('predictions') && !href.includes('tips')) return;
    
    // 홈팀 매칭
    const homeMatch = aliases.some(a => {
      const al = a.toLowerCase();
      return title.toLowerCase().includes(al) || text.toLowerCase().includes(al);
    });
    if (!homeMatch) return;
    
    // 원정팀 매칭
    const awayMatch = awayAliases.some(a => {
      const al = a.toLowerCase();
      return title.toLowerCase().includes(al) || text.toLowerCase().includes(al);
    });
    if (!awayMatch) return;
    
    // 스코어 추출 - 텍스트에서 "N - M" 또는 "N-M" 패턴
    const scoreMatch = text.match(/(\d+)\s*[-–]\s*(\d+)\s*$/);
    if (scoreMatch) {
      const hg = parseInt(scoreMatch[1]), ag = parseInt(scoreMatch[2]);
      result = {
        predicted_score: `${hg}-${ag}`,
        predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무'
      };
    }
  });
  
  // 대안: rawHtmlSearch
  if (!result) {
    // 텍스트 기반 검색: "HomeTeam\nAwayTeam\nN - M" 패턴
    const lines = html.replace(/<[^>]+>/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length - 2; i++) {
      const homeMatch = aliases.some(a => lines[i].toLowerCase().includes(a.toLowerCase()));
      if (!homeMatch) continue;
      
      const awayMatch = awayAliases.some(a => lines[i+1].toLowerCase().includes(a.toLowerCase()));
      if (!awayMatch) {
        // 같은 줄에 두 팀이 있을 수도 있음 "HomeTeam - AwayTeam"
        const sameLine = awayAliases.some(a => lines[i].toLowerCase().includes(a.toLowerCase()));
        if (sameLine) {
          // 다음 줄에서 스코어 찾기
          for (let j = i+1; j < Math.min(i+3, lines.length); j++) {
            const sm = lines[j].match(/^(\d+)\s*[-–]\s*(\d+)$/);
            if (sm) {
              const hg = parseInt(sm[1]), ag = parseInt(sm[2]);
              result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
              break;
            }
          }
        }
        continue;
      }
      
      // 다음 줄들에서 스코어 찾기
      for (let j = i+2; j < Math.min(i+5, lines.length); j++) {
        const sm = lines[j].match(/^(\d+)\s*[-–]\s*(\d+)$/);
        if (sm) {
          const hg = parseInt(sm[1]), ag = parseInt(sm[2]);
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
          break;
        }
      }
      if (result) break;
    }
  }
  
  return result;
}

// vitibet parser - with cheerio caching to avoid re-parsing 3.8MB HTML 32 times
let _vitibetCache = { html: null, $: null };
function parseVitibet(html, homeEn, awayEn) {
  let $;
  if (_vitibetCache.html === html) {
    $ = _vitibetCache.$;
  } else {
    $ = cheerio.load(html);
    _vitibetCache = { html, $ };
  }
  let result = null;
  let resultNoScore = null; // 스코어 없는 결과 (fallback)
  const debugTeam = false; // 디버그 완료 - 프로덕션에서는 끔

  $('tr').each((_, row) => {
    if (result && result.predicted_score) return; // 스코어 있는 결과 찾으면 멈춤
    const text = $(row).text();
    if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;

    if (debugTeam) {
      console.log(`  [vitibet-debug] Matched row for ${homeEn} vs ${awayEn}`);
      // row의 실제 HTML 출력 (처음 500자)
      const rowHtml = $(row).html() || '';
      console.log(`  [vitibet-debug] Row HTML: ${rowHtml.substring(0, 500)}`);
    }

    // 방법 1: 단일 td/span에서 "숫자-숫자" or "숫자:숫자" 찾기
    $(row).find('td, span, a').each((_, el) => {
      if (result) return;
      const t = $(el).text().trim();
      const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
      if (m) {
        const hg = parseInt(m[1]), ag = parseInt(m[2]);
        result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
        if (debugTeam) console.log(`  [vitibet-debug] Method1: found ${hg}-${ag} in single element`);
      }
    });

    // 방법 2: td 셀들을 나열해서 "숫자 : 숫자" 패턴 찾기 (vitibet tips 페이지)
    if (!result) {
      const tds = [];
      $(row).find('td').each((_, td) => {
        tds.push($(td).text().trim());
      });
      if (debugTeam) console.log(`  [vitibet-debug] TD cells: [${tds.join('|')}]`);
      
      // td 배열에서 연속된 "숫자", ":", "숫자" 패턴 검색
      for (let i = 0; i < tds.length - 2; i++) {
        const a = tds[i], sep = tds[i+1], b = tds[i+2];
        if (/^\d+$/.test(a) && (sep === ':' || sep === '-' || sep === '–') && /^\d+$/.test(b)) {
          const hg = parseInt(a), ag = parseInt(b);
          if (hg < 20 && ag < 20) {
            result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
            if (debugTeam) console.log(`  [vitibet-debug] Method2: found ${hg}-${ag} from td sequence`);
            break;
          }
        }
      }
      
      // td 배열에서 연속된 "숫자", "숫자" (구분자 없이) 확인 - 백분율% 다음이 아닌 경우
      if (!result) {
        const allTdText = tds.join(' ');
        const scoreM = allTdText.match(/(\d+)\s*[:–-]\s*(\d+)/);
        if (scoreM) {
          const hg = parseInt(scoreM[1]), ag = parseInt(scoreM[2]);
          if (hg < 20 && ag < 20) {
            result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
            if (debugTeam) console.log(`  [vitibet-debug] Method3: found ${hg}-${ag} from joined td text`);
          }
        }
      }
    }

    // 방법 4: row 전체 텍스트에서 스코어 추출 (팀명 제외하고)
    if (!result) {
      // 팀명을 제거한 후 남은 텍스트에서 스코어 패턴 찾기
      let cleanText = text;
      const homeAliases = getAliases(homeEn);
      const awayAliases = getAliases(awayEn);
      for (const alias of [...homeAliases, ...awayAliases]) {
        cleanText = cleanText.replace(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
      }
      const scoreMatch = cleanText.match(/(\d+)\s*[:–-]\s*(\d+)/);
      if (scoreMatch) {
        const hg = parseInt(scoreMatch[1]), ag = parseInt(scoreMatch[2]);
        if (hg < 20 && ag < 20) {
          result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' };
          if (debugTeam) console.log(`  [vitibet-debug] Method4: found ${hg}-${ag} from cleaned row text`);
        }
      }
    }

    // 방법 5 (최후): 1X2만 (스코어 없음) - resultNoScore에 저장 (스코어 있는 결과 우선)
    if (!result) {
      // row의 마지막 td들에서 배경색 또는 클래스로 1/2/X 판별
      const lastTds = [];
      $(row).find('td').each((_, td) => {
        const t = $(td).text().trim();
        const cls = $(td).attr('class') || '';
        const style = $(td).attr('style') || '';
        lastTds.push({ text: t, class: cls, style: style });
      });
      
      // 마지막에서 1, 2, X 찾기
      for (const td of lastTds.reverse()) {
        if (resultNoScore) break;
        if (td.text === '1' || td.text === '01') { resultNoScore = { predicted_score: null, predicted_result: '승' }; break; }
        if (td.text === '2' || td.text === '02') { resultNoScore = { predicted_score: null, predicted_result: '패' }; break; }
        if (td.text.toUpperCase() === 'X') { resultNoScore = { predicted_score: null, predicted_result: '무' }; break; }
      }
      if (debugTeam && resultNoScore) console.log(`  [vitibet-debug] Method5 (fallback): ${resultNoScore.predicted_result} (no score)`);
    }
  });

  // Fallback: 원시 HTML 검색
  if (!result) {
    result = rawHtmlSearch(html, homeEn, awayEn);
    if (debugTeam && result) console.log(`  [vitibet-debug] rawHtmlSearch fallback: ${result.predicted_score}`);
  }

  // 스코어 있는 result 우선, 없으면 스코어 없는 resultNoScore
  return result || resultNoScore;
}

// 원시 HTML 검색 (공통 fallback)
function rawHtmlSearch(html, homeEn, awayEn) {
  const lowerHtml = html.toLowerCase();
  // 모든 별칭에 대해 검색
  const homeAliases = getAliases(homeEn);
  const awayAliases = getAliases(awayEn);
  
  for (const homeAlias of homeAliases) {
    const homeKey = homeAlias.toLowerCase();
    const homeIdx = lowerHtml.indexOf(homeKey);
    if (homeIdx < 0) continue;
    
    for (const awayAlias of awayAliases) {
      const awayKey = awayAlias.toLowerCase();
      const region = lowerHtml.substring(Math.max(0, homeIdx - 500), homeIdx + 2000);
      if (!region.includes(awayKey)) continue;
      
      const regionHtml = html.substring(Math.max(0, homeIdx - 500), homeIdx + 2000);
      const scoreMatch = regionHtml.match(/(\d+)\s*[-–:]\s*(\d+)/);
      if (scoreMatch) {
        const hg = parseInt(scoreMatch[1]), ag = parseInt(scoreMatch[2]);
        if (hg < 20 && ag < 20) {
          return {
            predicted_score: `${hg}-${ag}`,
            predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무',
          };
        }
      }
    }
  }
  return null;
}

// ====== 영문 팀명 별칭 매핑 ======
// DB에 저장된 영문명 → 해외사이트에서 사용할 수 있는 다양한 표기
const ALIAS_MAP = {
  // A-League
  'Western Sydney': ['Western Sydney', 'WS Wanderers', 'Western Sydney Wanderers', 'W. Sydney'],
  'Wellington Phoenix': ['Wellington Phoenix', 'Wellington', 'Well. Phoenix'],
  'Melbourne Victory': ['Melbourne Victory', 'Melb Victory', 'Melbourne Vic'],
  'Brisbane Roar': ['Brisbane Roar', 'Brisbane'],
  'Sydney FC': ['Sydney FC', 'Sydney'],
  'Adelaide United': ['Adelaide United', 'Adelaide Utd', 'Adelaide'],
  'Perth Glory': ['Perth Glory', 'Perth'],
  'Newcastle Jets': ['Newcastle Jets', 'Newc. Jets'],
  'Central Coast Mariners': ['Central Coast Mariners', 'Central Coast', 'CC Mariners'],
  'Macarthur FC': ['Macarthur FC', 'Macarthur'],
  'Melbourne City': ['Melbourne City', 'Melb City'],
  'Auckland FC': ['Auckland FC', 'Auckland'],
  
  // J-League
  'Vissel Kobe': ['Vissel Kobe', 'Kobe'],
  'V-Varen Nagasaki': ['V-Varen Nagasaki', 'V-Varen', 'Nagasaki'],
  'Kashima Antlers': ['Kashima Antlers', 'Kashima'],
  'Yokohama F. Marinos': ['Yokohama F. Marinos', 'Yokohama FM', 'Yokohama Marinos', 'Yokohama F Marinos', 'Yokohama F.Marinos', 'Y. Marinos'],
  'FC Tokyo': ['FC Tokyo', 'Tokyo'],
  'Urawa Reds': ['Urawa Reds', 'Urawa Red Diamonds', 'Urawa'],
  'Machida Zelvia': ['Machida Zelvia', 'Machida'],
  'Mito HollyHock': ['Mito HollyHock', 'Mito Hollyhock', 'Mito'],
  'Shimizu S-Pulse': ['Shimizu S-Pulse', 'Shimizu S Pulse', 'Shimizu'],
  'Kyoto Sanga': ['Kyoto Sanga', 'Kyoto Sanga FC', 'Kyoto'],
  'Sanfrecce Hiroshima': ['Sanfrecce Hiroshima', 'Hiroshima', 'Sanfrecce'],
  'Fagiano Okayama': ['Fagiano Okayama', 'Okayama'],
  'Yokohama FC': ['Yokohama FC'],
  'Vegalta Sendai': ['Vegalta Sendai', 'Sendai'],
  'Omiya Ardija': ['Omiya Ardija', 'Omiya'],
  'Consadole Sapporo': ['Consadole Sapporo', 'Sapporo', 'Hokkaido Consadole'],
  'Kashiwa Reysol': ['Kashiwa Reysol', 'Kashiwa'],
  'Tokyo Verdy': ['Tokyo Verdy', 'Verdy'],
  'Tochigi SC': ['Tochigi SC', 'Tochigi'],
  'Blaublitz Akita': ['Blaublitz Akita', 'Akita'],
  'Tokushima Vortis': ['Tokushima Vortis', 'Tokushima'],
  'Albirex Niigata': ['Albirex Niigata', 'Niigata', 'Albirex'],
  'Avispa Fukuoka': ['Avispa Fukuoka', 'Fukuoka'],
  'Cerezo Osaka': ['Cerezo Osaka', 'C. Osaka', 'C Osaka'],
  'Gamba Osaka': ['Gamba Osaka', 'G. Osaka', 'G Osaka'],
  'Nagoya Grampus': ['Nagoya Grampus', 'Nagoya'],
  'JEF United': ['JEF United', 'JEF United Chiba', 'JEF Utd'],
  'Kawasaki Frontale': ['Kawasaki Frontale', 'Kawasaki'],
  'Ventforet Kofu': ['Ventforet Kofu', 'Kofu'],
  'Jubilo Iwata': ['Jubilo Iwata', 'Iwata', 'Jubilo'],
  'Sagan Tosu': ['Sagan Tosu', 'Tosu'],
  
  // Premier League
  'Liverpool': ['Liverpool'],
  'Brighton': ['Brighton', 'Brighton & Hove', 'Brighton Hove'],
  'Aston Villa': ['Aston Villa', 'A. Villa'],
  'Newcastle United': ['Newcastle United', 'Newcastle Utd', 'Newcastle'],
  'Manchester City': ['Manchester City', 'Man City', 'Man. City'],
  'Arsenal': ['Arsenal'],
  'Chelsea': ['Chelsea'],
  'Manchester United': ['Manchester United', 'Man United', 'Man. United', 'Man Utd'],
  'Tottenham': ['Tottenham', 'Tottenham Hotspur', 'Spurs'],
  'Everton': ['Everton'],
  'West Ham': ['West Ham', 'West Ham United', 'West Ham Utd'],
  'Fulham': ['Fulham'],
  'Bournemouth': ['Bournemouth', 'AFC Bournemouth'],
  'Wolverhampton': ['Wolverhampton', 'Wolverhampton Wanderers', 'Wolves'],
  'Crystal Palace': ['Crystal Palace', 'C. Palace'],
  'Nottingham Forest': ['Nottingham Forest', 'Nott. Forest', 'Nottingham', 'Nott\'m Forest'],
  'Brentford': ['Brentford'],
  'Southampton': ['Southampton'],
  'Leicester City': ['Leicester City', 'Leicester'],
  'Ipswich Town': ['Ipswich Town', 'Ipswich'],
  'Leeds United': ['Leeds United', 'Leeds Utd', 'Leeds'],
  'Sunderland': ['Sunderland'],
  'Burnley': ['Burnley'],
  
  // Championship
  'Hull City': ['Hull City', 'Hull'],
  'Wrexham': ['Wrexham'],
  'Derby County': ['Derby County', 'Derby'],
  'Swansea City': ['Swansea City', 'Swansea'],
  'Portsmouth': ['Portsmouth'],
  'Sheffield United': ['Sheffield United', 'Sheffield Utd', 'Sheff Utd', 'Sheff. United'],
  'Preston': ['Preston', 'Preston North End'],
  'Watford': ['Watford'],
  'QPR': ['QPR', 'Queens Park Rangers'],
  'Blackburn': ['Blackburn', 'Blackburn Rovers'],
  'Sheffield Wednesday': ['Sheffield Wednesday', 'Sheffield Wed', 'Sheff Wed', 'Sheff. Wednesday'],
  'Millwall': ['Millwall'],
  'Norwich City': ['Norwich City', 'Norwich'],
  'West Brom': ['West Brom', 'West Bromwich', 'WBA', 'West Bromwich Albion'],
  'Birmingham City': ['Birmingham City', 'Birmingham'],
  'Oxford United': ['Oxford United', 'Oxford Utd', 'Oxford'],
  'Stoke City': ['Stoke City', 'Stoke'],
  'Cardiff City': ['Cardiff City', 'Cardiff'],
  'Middlesbrough': ['Middlesbrough'],
  'Coventry City': ['Coventry City', 'Coventry'],
  'Luton Town': ['Luton Town', 'Luton'],
  'Plymouth Argyle': ['Plymouth Argyle', 'Plymouth'],
  'Bristol City': ['Bristol City', 'Bristol'],
  
  // La Liga
  'Espanyol': ['Espanyol', 'RCD Espanyol'],
  'Celta Vigo': ['Celta Vigo', 'Celta', 'RC Celta'],
  'Getafe': ['Getafe'],
  'Villarreal': ['Villarreal'],
  'Sevilla': ['Sevilla', 'Sevilla FC'],
  'Alaves': ['Alaves', 'Deportivo Alaves', 'Alavés'],
  'Real Madrid': ['Real Madrid', 'R. Madrid'],
  'Real Sociedad': ['Real Sociedad', 'R. Sociedad', 'Sociedad'],
  'Rayo Vallecano': ['Rayo Vallecano', 'Rayo'],
  'Atletico Madrid': ['Atletico Madrid', 'Atl. Madrid', 'Atletico', 'At. Madrid', 'Atl Madrid'],
  'Mallorca': ['Mallorca', 'RCD Mallorca'],
  'Real Betis': ['Real Betis', 'Betis', 'R. Betis'],
  'Barcelona': ['Barcelona', 'FC Barcelona'],
  'Valencia': ['Valencia', 'Valencia CF'],
  'Osasuna': ['Osasuna', 'CA Osasuna'],
  'Girona': ['Girona', 'Girona FC'],
  'Las Palmas': ['Las Palmas', 'UD Las Palmas'],
  'Leganes': ['Leganes', 'CD Leganes', 'Leganés'],
  'Real Valladolid': ['Real Valladolid', 'Valladolid', 'R. Valladolid'],
  'Levante': ['Levante', 'Levante UD'],
  'Real Oviedo': ['Real Oviedo', 'Oviedo', 'R. Oviedo'],
  'Athletic Bilbao': ['Athletic Bilbao', 'Ath Bilbao', 'Ath. Bilbao', 'Athletic Club', 'Athletic'],
  
  // Serie A
  'AC Milan': ['AC Milan', 'Milan', 'AC Milano', 'A.C. Milan'],
  'Como': ['Como', 'Como 1907', 'Calcio Como', 'FC Como'],
  'Fiorentina': ['Fiorentina', 'ACF Fiorentina'],
  'Lazio': ['Lazio', 'SS Lazio'],
  'Atalanta': ['Atalanta'],
  'Inter Milan': ['Inter Milan', 'Inter', 'Internazionale', 'FC Inter'],
  'Juventus': ['Juventus', 'Juve'],
  'Udinese': ['Udinese'],
  'Genoa': ['Genoa'],
  'Parma': ['Parma'],
  'Hellas Verona': ['Hellas Verona', 'Verona', 'H. Verona'],
  'Torino': ['Torino'],
  'Bologna': ['Bologna'],
  'Napoli': ['Napoli', 'SSC Napoli'],
  'AS Roma': ['AS Roma', 'Roma'],
  'Empoli': ['Empoli'],
  'Cagliari': ['Cagliari'],
  'Lecce': ['Lecce'],
  'Monza': ['Monza'],
  'Venezia': ['Venezia'],
  
  // Bundesliga
  'Dortmund': ['Dortmund', 'Borussia Dortmund', 'B. Dortmund'],
  'Mainz': ['Mainz', 'Mainz 05', 'FSV Mainz'],
  'Bayer Leverkusen': ['Bayer Leverkusen', 'Leverkusen', 'B. Leverkusen'],
  'St. Pauli': ['St. Pauli', 'FC St. Pauli', 'Sankt Pauli'],
  'Eintracht Frankfurt': ['Eintracht Frankfurt', 'E. Frankfurt', 'Frankfurt'],
  'Monchengladbach': ['Monchengladbach', 'B. Monchengladbach', 'Borussia M\'gladbach', 'Gladbach', 'M\'gladbach', 'Mönchengladbach'],
  'Werder Bremen': ['Werder Bremen', 'Bremen', 'W. Bremen'],
  'Bayern Munich': ['Bayern Munich', 'Bayern', 'FC Bayern', 'Bayern München'],
  'Hoffenheim': ['Hoffenheim', 'TSG Hoffenheim'],
  'Freiburg': ['Freiburg', 'SC Freiburg'],
  'Stuttgart': ['Stuttgart', 'VfB Stuttgart'],
  'Koln': ['Koln', 'FC Koln', 'Köln', 'FC Köln', 'Cologne'],
  'Augsburg': ['Augsburg', 'FC Augsburg'],
  'Heidenheim': ['Heidenheim', 'FC Heidenheim'],
  'RB Leipzig': ['RB Leipzig', 'Leipzig', 'Red Bull Leipzig'],
  'Wolfsburg': ['Wolfsburg', 'VfL Wolfsburg'],
  'Bochum': ['Bochum', 'VfL Bochum'],
  'Hamburger SV': ['Hamburger SV', 'Hamburg', 'HSV'],
  'Union Berlin': ['Union Berlin', 'FC Union Berlin'],
  
  // Ligue 1
  'Rennes': ['Rennes', 'Stade Rennais'],
  'PSG': ['PSG', 'Paris Saint-Germain', 'Paris Saint Germain', 'Paris SG'],
  'Monaco': ['Monaco', 'AS Monaco'],
  'Nantes': ['Nantes', 'FC Nantes'],
  'Marseille': ['Marseille', 'Olympique Marseille', 'OM', 'O. Marseille'],
  'Strasbourg': ['Strasbourg', 'RC Strasbourg'],
  'Lille': ['Lille', 'LOSC Lille', 'LOSC'],
  'Brest': ['Brest', 'Stade Brestois'],
  'Le Havre': ['Le Havre'],
  'Toulouse': ['Toulouse', 'Toulouse FC'],
  'Auxerre': ['Auxerre', 'AJ Auxerre'],
  'Lyon': ['Lyon', 'Olympique Lyon', 'Olympique Lyonnais', 'OL'],
  'Nice': ['Nice', 'OGC Nice'],
  'Lens': ['Lens', 'RC Lens'],
  'Montpellier': ['Montpellier', 'Montpellier HSC'],
  'Angers SCO': ['Angers SCO', 'Angers'],
  'Saint-Etienne': ['Saint-Etienne', 'St Etienne', 'AS Saint-Etienne', 'St. Etienne'],
  
  // Eredivisie
  'Feyenoord': ['Feyenoord'],
  'PSV': ['PSV', 'PSV Eindhoven'],
  'Heracles': ['Heracles', 'Heracles Almelo'],
  'NAC Breda': ['NAC Breda', 'NAC'],
  'AZ Alkmaar': ['AZ Alkmaar', 'AZ'],
  'Ajax': ['Ajax', 'AFC Ajax'],
  'Fortuna Sittard': ['Fortuna Sittard', 'Sittard'],
  'Groningen': ['Groningen', 'FC Groningen'],
  'Utrecht': ['Utrecht', 'FC Utrecht'],
  'Go Ahead Eagles': ['Go Ahead Eagles', 'Go Ahead'],
  'Heerenveen': ['Heerenveen', 'SC Heerenveen'],
  'PEC Zwolle': ['PEC Zwolle', 'Zwolle'],
  'Sparta Rotterdam': ['Sparta Rotterdam', 'Sparta R.'],
  'NEC Nijmegen': ['NEC Nijmegen', 'NEC'],
  'Twente': ['Twente', 'FC Twente'],
  'Willem II': ['Willem II'],
  'Almere City': ['Almere City', 'Almere'],

  // UCL/UEL/UECL 추가 팀명
  'Qarabag': ['Qarabag', 'Qarabağ', 'Qarabag FK', 'Qarabağ FK', 'Qarabagh'],
  'Bodo/Glimt': ['Bodo/Glimt', 'Bodø/Glimt', 'Bodo Glimt', 'Bodoe/Glimt', 'Bodoe Glimt', 'FK Bodo/Glimt', 'FK Bodø/Glimt'],
  'Olympiacos': ['Olympiacos', 'Olympiakos', 'Olympiacos Piraeus', 'Olympiakos Piraeus', 'Olympiacos FC'],
  'Club Brugge': ['Club Brugge', 'Club Bruges', 'Brugge', 'FC Bruges'],
  'Dinamo Zagreb': ['Dinamo Zagreb', 'NK Dinamo Zagreb', 'GNK Dinamo', 'D. Zagreb'],
  'KRC Genk': ['KRC Genk', 'Genk', 'Racing Genk'],
  'Celtic': ['Celtic', 'Celtic FC', 'Celtic Glasgow'],
  'Fenerbahce': ['Fenerbahce', 'Fenerbahçe', 'Fenerbahce SK'],
  'Galatasaray': ['Galatasaray', 'Galatasaray SK'],
  'Besiktas': ['Besiktas', 'Beşiktaş', 'Besiktas JK'],
  'Benfica': ['Benfica', 'SL Benfica', 'Benfica Lisbon'],
  'Sporting CP': ['Sporting CP', 'Sporting Lisbon', 'Sporting', 'Sp. Lisbon'],
  'Porto': ['Porto', 'FC Porto'],
  'Braga': ['Braga', 'SC Braga', 'Sp. Braga'],
  'PAOK': ['PAOK', 'PAOK Thessaloniki', 'PAOK FC', 'PAOK Salonika'],
  'Panathinaikos': ['Panathinaikos', 'Panathinaikos Athens', 'PAO'],
  'Viktoria Plzen': ['Viktoria Plzen', 'Viktoria Plzeň', 'Plzen', 'Plzeň', 'FC Viktoria Plzen'],
  'Crvena Zvezda': ['Crvena Zvezda', 'Red Star Belgrade', 'Red Star', 'FK Crvena Zvezda'],
  'Ferencvaros': ['Ferencvaros', 'Ferencvarosi', 'Ferencvárosi', 'Ferencváros', 'FTC'],
  'Rapid Wien': ['Rapid Wien', 'Rapid Vienna', 'SK Rapid Wien'],
  'Sturm Graz': ['Sturm Graz', 'SK Sturm Graz'],
  'Young Boys': ['Young Boys', 'BSC Young Boys', 'YB Bern'],
  'Shakhtar Donetsk': ['Shakhtar Donetsk', 'Shakhtar', 'Shaktar Donetsk'],
  'Dynamo Kyiv': ['Dynamo Kyiv', 'Dynamo Kiev', 'D. Kyiv', 'FK Dynamo Kyiv'],
  'Slavia Prague': ['Slavia Prague', 'Slavia Praha', 'SK Slavia'],
  'Sparta Prague': ['Sparta Prague', 'Sparta Praha', 'AC Sparta'],
  'Malmo': ['Malmo', 'Malmö', 'Malmö FF', 'Malmo FF'],
  'Copenhagen': ['Copenhagen', 'FC Copenhagen', 'FC København', 'København'],
  'SK Brann': ['SK Brann', 'Brann', 'Brann Bergen'],
  'Molde': ['Molde', 'Molde FK'],
  'Larnaca': ['Larnaca', 'AEK Larnaca', 'AEK Larnaka'],
  'Omonia': ['Omonia', 'Omonia Nicosia', 'AC Omonia'],
  'LASK': ['LASK', 'LASK Linz'],
  'Djurgarden': ['Djurgarden', 'Djurgårdens', 'Djurgårdens IF', 'Djurgarden IF'],

  // UECL 추가 팀
  'KUPS': ['KUPS', 'KuPS Kuopio', 'Kuopion PS'],
  'FC Noah': ['FC Noah', 'Noah FC', 'Noah'],
  'Zrinjski': ['Zrinjski', 'Zrinjski Mostar', 'HŠK Zrinjski'],
  'Drita': ['Drita', 'FC Drita', 'KF Drita'],
  'Shkendija': ['Shkendija', 'KF Shkëndija', 'Shkendija Tetovo'],

  // ACL / 중동 팀
  'Al Ahli': ['Al Ahli', 'Al-Ahli', 'Al Ahli Saudi', 'Al Ahli SFC'],
  'Al Nassr': ['Al Nassr', 'Al-Nassr', 'Al Nassr FC'],
  'Al Hilal': ['Al Hilal', 'Al-Hilal', 'Al Hilal SFC'],
  'Al Ittihad': ['Al Ittihad', 'Al-Ittihad'],
  'Sepahan': ['Sepahan', 'Sepahan FC', 'Sepahan Isfahan'],
  'Persepolis': ['Persepolis', 'Persepolis FC', 'Persepolis Tehran'],

  // ACL2 / 동남아시아 / 중남미
  'Real Esteli': ['Real Esteli', 'Real Estelí', 'CD Real Esteli'],
  'Tampines Rovers': ['Tampines Rovers', 'Tampines'],
  'Persija Jakarta': ['Persija Jakarta', 'Persija'],
  'Ratchaburi': ['Ratchaburi', 'Ratchaburi FC', 'Ratchaburi Mitr Phol'],
  'Quan Ninh': ['Quan Ninh', 'Quang Ninh', 'Than Quang Ninh'],
  'LAFC': ['LAFC', 'Los Angeles FC', 'LA FC'],
  'Gangwon FC': ['Gangwon FC', 'Gangwon', 'Gangwon-do'],
  'Shanghai Haigang': ['Shanghai Haigang', 'Shanghai Port', 'Shanghai SIPG', 'Shanghai Haigang FC'],
  'Ulsan HD': ['Ulsan HD', 'Ulsan Hyundai', 'Ulsan', 'Ulsan HD FC'],

  // 기타 유럽 리그 추가 (자주 나오는 팀)
  'Midtjylland': ['Midtjylland', 'FC Midtjylland'],
  'Brondby': ['Brondby', 'Brøndby', 'Brøndby IF', 'Brondby IF'],
  'Rangers': ['Rangers', 'Rangers FC', 'Glasgow Rangers'],
  'Aberdeen': ['Aberdeen', 'Aberdeen FC'],
  'Anderlecht': ['Anderlecht', 'RSC Anderlecht'],
  'Gent': ['Gent', 'KAA Gent', 'Ghent'],
  'Standard Liege': ['Standard Liege', 'Standard Liège', 'Standard', 'R. Standard Liège'],
  'Legia Warsaw': ['Legia Warsaw', 'Legia Warszawa', 'Legia'],
  'Lech Poznan': ['Lech Poznan', 'Lech Poznań', 'Lech'],
  'Steaua Bucharest': ['Steaua Bucharest', 'FCSB', 'Steaua'],
  'CFR Cluj': ['CFR Cluj', 'CFR 1907 Cluj'],
  'Trabzonspor': ['Trabzonspor'],
  'Basaksehir': ['Basaksehir', 'Başakşehir', 'Istanbul Basaksehir'],

};

// 팀명에 대한 모든 별칭 가져오기
function getAliases(teamEn) {
  if (!teamEn) return [];
  // ALIAS_MAP에서 직접 찾기
  if (ALIAS_MAP[teamEn]) return ALIAS_MAP[teamEn];
  // 값에서 찾기 (이미 별칭인 경우)
  for (const [key, aliases] of Object.entries(ALIAS_MAP)) {
    if (aliases.some(a => a.toLowerCase() === teamEn.toLowerCase())) {
      return aliases;
    }
  }
  // 없으면 원본만 반환
  return [teamEn];
}

// ====== 향상된 fuzzy 매칭 ======
function fuzzy(text, team) {
  if (!text || !team) return false;
  const t = text.toLowerCase();
  
  // 1. 원본 팀명으로 매칭
  const parts = team.toLowerCase().split(/\s+/);
  if (parts.every(p => t.includes(p))) return true;
  if (parts[0].length >= 4 && t.includes(parts[0])) return true;
  if (parts.length > 1 && parts[1].length >= 4 && t.includes(parts[1])) return true;
  
  // 2. 별칭으로 매칭
  const aliases = getAliases(team);
  for (const alias of aliases) {
    if (alias === team) continue; // 원본은 이미 체크함
    const aliasParts = alias.toLowerCase().split(/\s+/);
    if (aliasParts.every(p => t.includes(p))) return true;
    // 단일 단어 별칭 (예: 'Kobe', 'Bayern')은 4자 이상이면 매칭
    if (aliasParts.length === 1 && aliasParts[0].length >= 4 && t.includes(aliasParts[0])) return true;
    if (aliasParts[0].length >= 4 && t.includes(aliasParts[0])) return true;
  }
  
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
    const extraWait = (site === 'forebet' || site === 'predictz') ? 15000 : 0;
    const html = await getPage(urls[site], null, 60000, extraWait);
    
    const idx = html.toLowerCase().indexOf(team.toLowerCase());
    const samples = [];
    
    if (idx >= 0) {
      const start = Math.max(0, idx - 200);
      const end = Math.min(html.length, idx + 300);
      samples.push(html.substring(start, end));
    }
    
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
  '웰링턴': 'Wellington Phoenix', '멜번빅토': 'Melbourne Victory', '멜번시티': 'Melbourne City',
  '센트럴코': 'Central Coast Mariners', '브리즈번': 'Brisbane Roar', '애들레유': 'Adelaide United',
  '매콰리유': 'Macarthur FC', '웨스시드': 'Western Sydney',
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
  '요코FM': 'Yokohama F. Marinos', '감바오사': 'Gamba Osaka',
  // J리그 추가
  '토쿄V': 'Tokyo Verdy', '오이타': 'Oita Trinita', '에히메': 'Ehime FC',
  '야마가타': 'Montedio Yamagata', '로아소쿠': 'Roasso Kumamoto', '이와키': 'Iwaki FC',
  '레노파야': 'Renofa Yamaguchi', '반포레': 'Ventforet Kofu', '자스파쿠': 'Zweigen Kanazawa',
  '가이나레': 'Gainare Tottori', '후지에다': 'Fujieda MYFC', '카타프로': 'Kataller Toyama',
  '오미야아': 'Omiya Ardija', '츠에겐가': 'Zweigen Kanazawa',
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
  '빌바오': 'Athletic Bilbao', 'AT마드리': 'Atletico Madrid',
  // La Liga 2
  '레반테': 'Levante', '오비에도': 'Real Oviedo',
  // Serie A
  '피사SC': 'Pisa', 'AC밀란': 'AC Milan', '코모1907': 'Como', '피오렌티': 'Fiorentina',
  '라치오': 'Lazio', '아탈란타': 'Atalanta', '인테르': 'Inter Milan', '유벤투스': 'Juventus',
  '우디네세': 'Udinese', '사수올로': 'Sassuolo', '크레모네': 'Cremonese', '제노아': 'Genoa',
  '파르마': 'Parma', '엘라스': 'Hellas Verona', '토리노': 'Torino', '볼로나': 'Bologna',
  '나폴리': 'Napoli', 'AS로마': 'AS Roma', '엠폴리': 'Empoli', '카글리아': 'Cagliari',
  '레체': 'Lecce', '몬자': 'Monza', '베네치아': 'Venezia', '사레르니': 'Salernitana',
  '볼로냐': 'Bologna',
  // Bundesliga
  '도르트문': 'Dortmund', '마인츠05': 'Mainz', '레버쿠젠': 'Bayer Leverkusen', '장크트파': 'St. Pauli',
  '프랑크푸': 'Eintracht Frankfurt', '뮌헨글라': 'Monchengladbach', '브레멘': 'Werder Bremen',
  '바이뮌헨': 'Bayern Munich', '호펜하임': 'Hoffenheim', '프라이부': 'Freiburg',
  '슈투트가': 'Stuttgart', '퀼른': 'Koln', '아우크스': 'Augsburg', '하이덴하': 'Heidenheim',
  '라이프치': 'RB Leipzig', '볼프스부': 'Wolfsburg', '보훔': 'Bochum', '볼프스': 'Wolfsburg',
  '다름슈타': 'Darmstadt',
  // Bundesliga 2
  '함부르크': 'Hamburger SV', 'U베를린': 'Union Berlin', '키엘': 'Holstein Kiel',
  '카이저슬': 'Kaiserslautern', '뒤셀도르': 'Fortuna Dusseldorf', '뉘른베르': 'Nurnberg',
  '샬케04': 'Schalke 04', '파더보른': 'Paderborn', '헤르타B': 'Hertha Berlin',
  '그로이터': 'Greuther Furth', '마그데부': 'Magdeburg', '하노버96': 'Hannover 96',
  '브라운슈': 'Braunschweig', '엘베어슈': 'Elversberg', '카를스루': 'Karlsruher',
  // Ligue 1
  '스타드렌': 'Rennes', 'PSG': 'PSG', 'AS모나코': 'Monaco', '낭트': 'Nantes',
  '마르세유': 'Marseille', 'RC스트라': 'Strasbourg', '릴OSC': 'Lille', '브레스투': 'Brest',
  '르아브르': 'Le Havre', '툴루즈': 'Toulouse', '메스': 'Metz', '오세르': 'Auxerre',
  '리옹': 'Lyon', 'OGC니스': 'Nice', '랑스': 'Lens', '몽펠리에': 'Montpellier',
  '클레르몽': 'Clermont', '로리앙': 'Lorient', '생테티엔': 'Saint-Etienne',
  '앙제': 'Angers SCO', '렌느': 'Rennes',
  // Ligue 2
  '파리FC': 'Paris FC', '앙제SCO': 'Angers SCO',
  // Eredivisie
  '플렌담': 'Feyenoord', 'PSV': 'PSV', '헤라클레': 'Heracles', '브레다': 'NAC Breda',
  '엑셀시오': 'Excelsior', '알크마르': 'AZ Alkmaar', '아약스': 'Ajax', 'F시타르': 'Fortuna Sittard',
  '흐로닝언': 'Groningen', '위트레흐': 'Utrecht', '페예노르': 'Feyenoord', '고어헤드': 'Go Ahead Eagles',
  '헤이렌베': 'Heerenveen', '즈볼러': 'PEC Zwolle', '스파로테': 'Sparta Rotterdam',
  '네이메헌': 'NEC Nijmegen', '트벤테': 'Twente', '텔스타': 'Telstar',
  '빌렘II': 'Willem II', '알메르시': 'Almere City',
  // 기타
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
  'UEFA유로': 'UEFAEuropa', 'UEFA챔': 'UEFAChampions',
  'FA컵': 'FACup', '코파델레': 'CopaDelRey', '국왕컵': 'CopaDelRey',
  'DFB포칼': 'DFBPokal',
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

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
    
    let roundYear = new Date().getFullYear().toString();
    let roundNumber = null;
    
    // "2026년도" / "22회차" 텍스트에서 추출
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
    
    // fallback 2: "22회차 발매중" 같은 텍스트에서 추출
    if (!roundNumber) {
      const saleMatch = html.match(/승부식\s*(\d+)회차\s*발매/);
      if (saleMatch) roundNumber = parseInt(saleMatch[1]);
    }
    
    console.log(`  Round: ${roundYear}-${roundNumber || '?'}`);

    // 5. 경기 목록 파싱 (WiseToto는 ul/li 구조)
    const matches = [];
    
    $('ul').each((_, ul) => {
      const $ul = $(ul);
      const noEl = $ul.find('li.a1');
      if (!noEl.length) return;
      
      const matchNum = parseInt(noEl.text().trim());
      if (isNaN(matchNum)) return;
      
      // 유형 칸 - 핸디캡(H), 언오버(U), 합계(SUM) 등은 제외, 빈칸만 일반 승무패
      const typeEl = $ul.find('li.hm');
      const typeText = typeEl.text().trim();
      if (typeText && typeText !== '') return;
      
      // 추가 필터: a5 클래스도 체크 (일부 행에서 li.a5에 유형 표시)
      const a5El = $ul.find('li.a5');
      const a5Text = a5El.text().trim();
      if (a5Text && /^(H|U|SUM|핸디|언오버|합계)/i.test(a5Text)) return;
      
      // 리그
      const league = $ul.find('li.a4').text().trim().replace(/[⚽🏀🏐⚾]/g, '').trim();
      
      // 홈팀명 + 홈스코어
      const a6 = $ul.find('li.a6');
      const homeKr = a6.find('span.tn').text().trim() || a6.find('span.tnb').text().trim();
      
      // 원정팀명 + 원정스코어
      const a8 = $ul.find('li.a8');
      const awayKr = a8.find('span.tnb').text().trim() || a8.find('span.tn').text().trim();
      
      if (!homeKr || !awayKr) return;
      
      // 경기 결과(스코어) 파싱
      let actualHomeScore = null, actualAwayScore = null, actualResult = null;
      const homeScoreEl = a6.find('span.win, span.lose, span.draw');
      const awayScoreEl = a8.find('span.win, span.lose, span.draw');
      if (homeScoreEl.length && awayScoreEl.length) {
        actualHomeScore = parseInt(homeScoreEl.text().trim());
        actualAwayScore = parseInt(awayScoreEl.text().trim());
        if (!isNaN(actualHomeScore) && !isNaN(actualAwayScore)) {
          actualResult = actualHomeScore > actualAwayScore ? '승' : actualHomeScore < actualAwayScore ? '패' : '무';
        }
      }
      
      // 배당 파싱 (a9 li가 3개)
      const oddsEls = $ul.find('li.a9');
      let oddsHome = null, oddsDraw = null, oddsAway = null;
      if (oddsEls.length >= 3) {
        const o1 = parseFloat($(oddsEls[0]).find('span.pt').text().trim());
        const o2 = parseFloat($(oddsEls[1]).find('span.pt').text().trim());
        const o3 = parseFloat($(oddsEls[2]).find('span.pt').text().trim());
        if (o1 > 0) oddsHome = o1;
        if (o2 > 0) oddsDraw = o2;
        if (o3 > 0) oddsAway = o3;
      }
      
      const homeEn = TEAM_MAP[homeKr] || '';
      const awayEn = TEAM_MAP[awayKr] || '';
      const leagueDb = LEAGUE_MAP[league] || league;
      
      const matchData = {
        round_year: roundYear,
        round_number: roundNumber,
        match_number: matchNum,
        home_team_kr: homeKr,
        away_team_kr: awayKr,
        home_team_en: homeEn,
        away_team_en: awayEn,
        league: leagueDb,
        match_type: 'normal',
        actual_home_score: (actualHomeScore !== null && !isNaN(actualHomeScore)) ? actualHomeScore : null,
        actual_away_score: (actualAwayScore !== null && !isNaN(actualAwayScore)) ? actualAwayScore : null,
        actual_result: actualResult || null,
        odds_home: oddsHome || null,
        odds_draw: oddsDraw || null,
        odds_away: oddsAway || null,
      };
      
      // 결과 로그
      if (matchData.actual_home_score !== null) {
        console.log(`    Match ${matchNum}: ${homeKr} ${matchData.actual_home_score}:${matchData.actual_away_score} ${awayKr} → ${matchData.actual_result}`);
      }
      
      matches.push(matchData);
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
// ====== 수익률 계산 API ======
app.get('/yield', async (req, res) => {
  try {
    const { round_year, round_number } = req.query;
    if (!round_year || !round_number) {
      return res.json({ error: 'round_year and round_number required' });
    }

    // 1. 해당 라운드 경기 가져오기 (결과 포함)
    const matches = await supabaseGet('proto_matches',
      `round_year=eq.${round_year}&round_number=eq.${round_number}&match_type=eq.normal&order=match_number&select=*`);
    
    if (!matches || matches.length === 0) {
      return res.json({ error: 'No matches found' });
    }

    // 2. 해당 라운드 예측 가져오기
    const matchIds = matches.map(m => m.id);
    const predictions = await supabaseGet('predictions',
      `match_id=in.(${matchIds.join(',')})&select=*`);

    // 3. 사이트별 수익률 계산
    const sources = ['windrawwin', 'predictz', 'fpai', 'vitibet'];
    const yieldData = {};

    for (const source of sources) {
      let totalBet = 0;
      let totalReturn = 0;
      let totalBetOverseas = 0;
      let totalReturnOverseas = 0;
      let matchCount = 0;

      for (const match of matches) {
        // 이 경기의 해당 소스 예측
        const pred = predictions?.find(p => p.match_id === match.id && p.source === source);
        if (!pred || !pred.predicted_result) continue;
        
        // 실제 결과가 있는지 확인
        if (!match.actual_result) continue;
        
        matchCount++;
        
        // 국내배당
        const domesticOdds = pred.predicted_result === '승' ? match.odds_home :
                             pred.predicted_result === '무' ? match.odds_draw :
                             pred.predicted_result === '패' ? match.odds_away : 0;
        
        // 해외배당
        const overseasOdds = pred.predicted_result === '승' ? match.odds_home_overseas :
                              pred.predicted_result === '무' ? match.odds_draw_overseas :
                              pred.predicted_result === '패' ? match.odds_away_overseas : 0;
        
        if (domesticOdds) {
          totalBet += 1;
          if (pred.predicted_result === match.actual_result) {
            totalReturn += domesticOdds;
          }
        }
        
        if (overseasOdds) {
          totalBetOverseas += 1;
          if (pred.predicted_result === match.actual_result) {
            totalReturnOverseas += overseasOdds;
          }
        }
      }

      const domesticYield = totalBet > 0 ? ((totalReturn / totalBet - 1) * 100).toFixed(0) : null;
      const overseasYield = totalBetOverseas > 0 ? ((totalReturnOverseas / totalBetOverseas - 1) * 100).toFixed(0) : null;
      
      yieldData[source] = {
        domestic: totalBet > 0 ? {
          return: totalReturn.toFixed(2),
          bet: totalBet,
          yield_pct: domesticYield
        } : null,
        overseas: totalBetOverseas > 0 ? {
          return: totalReturnOverseas.toFixed(2),
          bet: totalBetOverseas,
          yield_pct: overseasYield
        } : null,
        matchCount
      };
    }

    res.json({ success: true, round_year, round_number, yield: yieldData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proto Scraper Server running on port ${PORT}`);
  
  // 서버 시작 후 10초 뒤 자동 스크래핑
  setTimeout(async () => {
    try {
      // 먼저 경기 수 확인 → 부족하면 와이즈토토에서 가져오기
      const latest = await supabaseGet('proto_matches',
        'match_type=eq.normal&order=round_number.desc&limit=1&select=round_year,round_number');
      
      if (latest?.length) {
        const { round_year, round_number } = latest[0];
        const matches = await supabaseGet('proto_matches',
          `round_year=eq.${round_year}&round_number=eq.${round_number}&match_type=eq.normal&select=id`);
        
        console.log(`Current matches in DB: ${matches?.length || 0} (round ${round_year}-${round_number})`);
        
        if (!matches?.length || matches.length < 30) {
          console.log('Auto-trigger: fetching matches from WiseToto first...');
          await doFetchMatches();
          await new Promise(r => setTimeout(r, 5000));
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
