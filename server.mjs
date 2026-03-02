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
      console.log(`  Waiting for Cloudflare challenge...`);
      
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
        if (i >= 4) {
          console.log(`  CF blocked after ${i+1} attempts, giving up`);
          break;
        }
        
        if (humanize && i % 3 === 2) {
          try {
            await page.mouse.move(300 + Math.random() * 400, 200 + Math.random() * 300);
            await page.evaluate(() => window.scrollBy(0, 50 + Math.random() * 100));
          } catch(e) {}
        }
      }
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
let isRunningStartedAt = null;
const MAX_RUNNING_TIME = 30 * 60 * 1000; // 30분 타임아웃

function checkRunningLock() {
  if (isRunning && isRunningStartedAt && (Date.now() - isRunningStartedAt > MAX_RUNNING_TIME)) {
    console.log('⚠ isRunning lock timeout (30min) — force releasing');
    isRunning = false;
    isRunningStartedAt = null;
  }
  return isRunning;
}

// ====== SCRAPE & SAVE ======
app.post('/scrape-and-save', auth, async (req, res) => {
  if (checkRunningLock()) {
    return res.json({ message: 'Already running, skipped', timestamp: new Date().toISOString() });
  }
  res.json({ message: 'Scraping started', timestamp: new Date().toISOString() });
  doScrapeAndSave().catch(e => console.error('Background scrape error:', e.message));
});

app.get('/scrape-and-save', auth, async (req, res) => {
  if (checkRunningLock()) {
    return res.json({ message: 'Already running, skipped', timestamp: new Date().toISOString() });
  }
  res.json({ message: 'Scraping started', timestamp: new Date().toISOString() });
  doScrapeAndSave().catch(e => console.error('Background scrape error:', e.message));
});

async function doScrapeAndSave() {
  if (checkRunningLock()) return;
  isRunning = true;
  isRunningStartedAt = Date.now();

  try {
    console.log('=== Starting scrape & save ===');

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

    // 1.6 vitibet DELETE 제거 — upsert가 자동 덮어씀

    const sources = [
      { name: 'windrawwin', urls: [
        'https://www.windrawwin.com/predictions/today/',
        'https://www.windrawwin.com/predictions/tomorrow/',
        'https://www.windrawwin.com/predictions/weekend/',
        // 5대 리그 개별 페이지 (뒤쪽 번호 455+ 커버)
        'https://www.windrawwin.com/predictions/england-premier-league/',
        'https://www.windrawwin.com/predictions/spain-la-liga/',
        'https://www.windrawwin.com/predictions/italy-serie-a/',
        'https://www.windrawwin.com/predictions/germany-bundesliga/',
        'https://www.windrawwin.com/predictions/france-ligue-1/',
        // 유럽 대회
        'https://www.windrawwin.com/tips/champions-league/',
        'https://www.windrawwin.com/tips/europa-league/',
        'https://www.windrawwin.com/tips/europa-conference-league/',
        'https://www.windrawwin.com/predictions/japan-j-league/',
        'https://www.windrawwin.com/predictions/japan-j2-league/',
        'https://www.windrawwin.com/predictions/australia-a-league/',
        'https://www.windrawwin.com/predictions/usa-mls/',
        'https://www.windrawwin.com/predictions/england-championship/',
        'https://www.windrawwin.com/tips/south-korea-k-league-1/',
        'https://www.windrawwin.com/tips/south-korea-k-league-2/',
        'https://www.windrawwin.com/tips/world-cup-qualifying/',
        'https://www.windrawwin.com/predictions/netherlands-eredivisie/',
        'https://www.windrawwin.com/predictions/spain-la-liga-2/',
        'https://www.windrawwin.com/predictions/italy-serie-b/',
        'https://www.windrawwin.com/predictions/france-ligue-2/',
        'https://www.windrawwin.com/predictions/germany-2-bundesliga/',
      ], wait: null, extraWait: 0 },
      { name: 'predictz', urls: [
        'https://www.predictz.com/predictions/',
        'https://www.predictz.com/predictions/tomorrow/',
        // 5대 리그 개별 페이지
        'https://www.predictz.com/predictions/england/premier-league/',
        'https://www.predictz.com/predictions/spain/la-liga/',
        'https://www.predictz.com/predictions/italy/serie-a/',
        'https://www.predictz.com/predictions/germany/bundesliga/',
        'https://www.predictz.com/predictions/france/ligue-1/',
        // 유럽 대회
        'https://www.predictz.com/predictions/europe/champions-league/',
        'https://www.predictz.com/predictions/europe/europa-league/',
        'https://www.predictz.com/predictions/europe/europa-conference-league/',
        'https://www.predictz.com/predictions/japan/j-league/',
        'https://www.predictz.com/predictions/japan/j2-league/',
        'https://www.predictz.com/predictions/australia/a-league/',
        'https://www.predictz.com/predictions/usa/mls/',
        'https://www.predictz.com/predictions/england/championship/',
        'https://www.predictz.com/predictions/south-korea/k-league-1/',
        'https://www.predictz.com/predictions/south-korea/k-league-2/',
        'https://www.predictz.com/predictions/international/world-cup-2026-qualifying/',
        'https://www.predictz.com/predictions/netherlands/eredivisie/',
        'https://www.predictz.com/predictions/spain/segunda-division/',
        'https://www.predictz.com/predictions/italy/serie-b/',
        'https://www.predictz.com/predictions/france/ligue-2/',
        'https://www.predictz.com/predictions/germany/2-bundesliga/',
      ], wait: null, extraWait: 15000 },
      { name: 'vitibet', urls: [
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=champions2&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=champions3&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=champions4&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=anglie&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=angliedruha&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=spanelsko&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=italie&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=nemecko&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=francie&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=holandsko&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=spanelskodruha&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=nemeckodruha&lang=en',
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=franciedruha&lang=en',   // Ligue 2
        // J리그, A리그, K리그, MLS, Serie B 추가
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=japonsko&lang=en',      // J-League
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=japonsko2&lang=en',     // J2 League
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=australie&lang=en',     // A-League
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=korearepublic&lang=en', // K-League
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=mls&lang=en',           // MLS
        'https://www.vitibet.com/index.php?clanek=tips&sekce=fotbal&liga=italiedruha&lang=en',   // Serie B
      ], wait: 'table', extraWait: 0, usePuppeteer: false, useFetch: true },
    ];

    let saved = 0;

    for (const src of sources) {
      let html = '';
      try {
        for (let i = 0; i < src.urls.length; i++) {
          const url = src.urls[i];
          const label = i === 0 ? src.name : `${src.name}[${i}]`;
          console.log(`  Fetching ${label}...`);
          
          let pageHtml = '';
          try {
            if (src.usePuppeteer) {
              pageHtml = await getPage(url, src.wait, 30000, src.extraWait || 0);
              if (browser) { try { await browser.close(); } catch(e2) {} browser = null; }
            } else if (src.useFetch || src.name === 'vitibet') {
              const resp = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
                signal: AbortSignal.timeout(25000),
              });
              if (resp.ok) pageHtml = await resp.text();
              else throw new Error(`HTTP ${resp.status}`);
            } else {
              const urlTimeout = src.name === 'predictz' ? 40000 : 60000;
              pageHtml = await getPage(url, src.wait, urlTimeout, src.extraWait || 0, src.humanize || false);
            }
            console.log(`  ${label}: ${pageHtml.length} chars`);
          } catch (e) {
            console.log(`  ${label}: FAILED - ${e.message}`);
            if (src.name !== 'vitibet') {
              console.log(`  ${label}: force-closing browser after failure`);
              if (browser) { try { await browser.close(); } catch(e2) {} browser = null; }
            }
            if (src.name === 'predictz') {
              console.log(`  predictz: CF blocked on URL ${i}, skipping remaining URLs`);
              break;
            }
            continue;
          }
          
          if (pageHtml.includes('Just a moment') || pageHtml.includes('Checking your browser')) {
            console.log(`  ${label} WARNING: Cloudflare blocked! Skipping this URL...`);
            if (src.name === 'predictz') {
              console.log(`  predictz: CF in HTML on URL ${i}, skipping remaining`);
              if (browser) { try { await browser.close(); } catch(e2) {} browser = null; }
              break;
            }
            continue;
          }
          
          html += '\n' + pageHtml;

          if (browser) {
            try { await browser.close(); } catch(e) {}
            browser = null;
          }
        }
        
        console.log(`  ${src.name} TOTAL: ${html.length} chars`);
        
        if (html.length > 0) {
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
      
      if (unmatched > 0) {
        let debugCount = 0;
        const lowerHtml = html.toLowerCase();
        for (const match of matches || []) {
          if (debugCount >= 10) break;
          if (!match.home_team_en || !match.away_team_en) continue;
          const p = extractPrediction(html, match.home_team_en, match.away_team_en, src.name);
          if (!p) {
            const homeInHtml = lowerHtml.includes(match.home_team_en.toLowerCase().substring(0, 5));
            const awayInHtml = lowerHtml.includes(match.away_team_en.toLowerCase().substring(0, 5));
            console.log(`  DEBUG ${src.name}: no match for "${match.home_team_en}" vs "${match.away_team_en}" [inHTML: ${homeInHtml}/${awayInHtml}]`);
            debugCount++;
          }
        }
      }

      html = '';
    }

    console.log(`=== Main sources done: ${saved} predictions saved ===`);

    try {
      const fpaiSaved = await scrapeFpai(matches);
      saved += fpaiSaved;
      console.log(`  fpai: ${fpaiSaved} predictions saved`);
    } catch(e) {
      console.log(`  fpai ERROR: ${e.message}`);
    }

    console.log(`=== Done: ${saved} total predictions saved ===`);

  } finally {
    isRunning = false;
    isRunningStartedAt = null;
    if (browser) {
      try { await browser.close(); } catch(e) {}
      browser = null;
    }
  }
}


// ====== TEST ENDPOINT ======
app.get('/test/:site', auth, async (req, res) => {
  const urls = { windrawwin: 'https://www.windrawwin.com/predictions/today/', predictz: 'https://www.predictz.com/predictions/', forebet: 'https://www.forebet.com/en/football-predictions', vitibet: 'https://www.vitibet.com/index.php?clanek=quicktips&sekce=fotbal&lang=en' };
  const site = req.params.site;
  if (!urls[site]) return res.json({ error: 'Invalid site' });
  try { const extraWait = (site === 'forebet' || site === 'predictz') ? 15000 : 0; const html = await getPage(urls[site], null, 60000, extraWait); const blocked = html.includes('Just a moment') || html.includes('Checking your browser'); res.json({ site, chars: html.length, blocked, preview: html.substring(0, 500), timestamp: new Date().toISOString() }); } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { return null; }
}

let _wdwCache = { html: null, $: null };
function parseWindrawwin(html, homeEn, awayEn) {
  let $; if (_wdwCache.html === html) { $ = _wdwCache.$; } else { $ = cheerio.load(html); _wdwCache = { html, $ }; }
  let result = null;
  $('div.wtfixt, div[class*="wtfixt"], div.wttr').each((_, row) => {
    if (result) return; const text = $(row).text(); if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;
    const parent = $(row).parent(); const grandparent = parent.parent();
    let score = '';
    for (const container of [$(row), parent, grandparent]) { const sc = container.find('.predscore').first().text().trim(); if (sc) { score = sc; break; } const sc2 = container.find('.wtsc').first().text().trim(); if (sc2) { score = sc2; break; } }
    if (!score) { $(row).nextAll().each((_, sib) => { if (score) return; const t = $(sib).text().trim(); const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/); if (m) score = t; const ps = $(sib).find('.predscore').first().text().trim(); if (ps) score = ps; }); }
    const m = score.match(/(\d+)\s*[-–:]\s*(\d+)/); if (m) { const hg = parseInt(m[1]), ag = parseInt(m[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; }
    if (!result) { const tipMatch = text.match(/(?:Home Win|Away Win|Draw)\s*(\d+)\s*[-–]\s*(\d+)/i); if (tipMatch) { const hg = parseInt(tipMatch[1]), ag = parseInt(tipMatch[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } }
    if (!result) { const allText = (grandparent.text() || text).toLowerCase(); if (allText.includes('home win')) result = { predicted_score: null, predicted_result: '승' }; else if (allText.includes('away win')) result = { predicted_score: null, predicted_result: '패' }; else if (allText.includes('draw')) result = { predicted_score: null, predicted_result: '무' }; }
  });
  if (!result) { $('tr').each((_, row) => { if (result) return; const text = $(row).text(); if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return; $(row).find('td, span, a, div, strong').each((_, el) => { if (result) return; const t = $(el).text().trim(); const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/); if (m) { const hg = parseInt(m[1]), ag = parseInt(m[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } }); }); }
  return result;
}

let _predzCache = { html: null, $: null };
function parsePredictz(html, homeEn, awayEn) {
  let $; if (_predzCache.html === html) { $ = _predzCache.$; } else { $ = cheerio.load(html); _predzCache = { html, $ }; }
  let result = null;
  $('div.pttr, div.ptcnt, div[class*="pttr"]').each((_, container) => {
    if (result) return; const text = $(container).text(); if (text.length > 5000 || text.length < 10) return; if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;
    $(container).find('div[class*="ptpredbox"], div[class*="predbox"], .ptpredboxsml').each((_, el) => { if (result) return; const t = $(el).text().trim(); const m = t.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i); if (m) { const hg = parseInt(m[1]), ag = parseInt(m[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } });
    if (!result) { const predMatch = text.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i); if (predMatch) { const hg = parseInt(predMatch[1]), ag = parseInt(predMatch[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } }
  });
  if (!result) { $('div[class*="pointed"], div[class*="ptcon"], div[class*="ptdiv"], div[class*="pttr"], .pointed, table').each((_, container) => { if (result) return; const text = $(container).text(); if (text.length > 5000 || text.length < 10) return; if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return; $(container).find('div, span, a, td, strong').each((_, el) => { if (result) return; const t = $(el).text().trim(); const predM = t.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i); if (predM) { const hg = parseInt(predM[1]), ag = parseInt(predM[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; return; } const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/); if (m) { const hg = parseInt(m[1]), ag = parseInt(m[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } }); if (!result) { const allText = $(container).text(); const homeAwayDraw = allText.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i); if (homeAwayDraw) { const hg = parseInt(homeAwayDraw[1]), ag = parseInt(homeAwayDraw[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } else if (allText.toLowerCase().includes('home win')) result = { predicted_score: null, predicted_result: '승' }; else if (allText.toLowerCase().includes('away win')) result = { predicted_score: null, predicted_result: '패' }; else if (allText.toLowerCase().includes('draw')) result = { predicted_score: null, predicted_result: '무' }; } }); }
  if (!result) { $('tr').each((_, row) => { if (result) return; const text = $(row).text(); if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return; const predM = text.match(/(?:Home|Draw|Away)\s+(\d+)\s*[-–]\s*(\d+)/i); if (predM) { const hg = parseInt(predM[1]), ag = parseInt(predM[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; return; } $(row).find('td, span, a, div, strong').each((_, el) => { if (result) return; const t = $(el).text().trim(); const m = t.match(/^(\d+)\s*[-–:]\s*(\d+)$/); if (m) { const hg = parseInt(m[1]), ag = parseInt(m[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } }); }); }
  if (!result) { result = rawHtmlSearch(html, homeEn, awayEn); }
  return result;
}

function parseForebet(html, homeEn, awayEn) {
  const $ = cheerio.load(html); let result = null;
  $('.rcnt').each((_, row) => { if (result) return; const homeText = $(row).find('.homeTeam').text().trim(); const awayText = $(row).find('.awayTeam').text().trim(); if (homeText && awayText && fuzzy(homeText, homeEn) && fuzzy(awayText, awayEn)) { $(row).find('[class*="ex_sc"], [class*="score"], .foremark').each((_, el) => { if (result) return; const t = $(el).text().trim(); const m = t.match(/(\d+)\s*[-–:]\s*(\d+)/); if (m) { const hg = parseInt(m[1]), ag = parseInt(m[2]); result = { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } }); if (!result) { const probs = []; $(row).find('[class*="fprc"], [class*="prob"]').each((_, el) => { const pct = parseInt($(el).text().trim()); if (pct > 0 && pct <= 100) probs.push(pct); }); if (probs.length >= 3) { const maxIdx = probs.indexOf(Math.max(...probs)); if (maxIdx === 0) result = { predicted_score: null, predicted_result: '승', confidence: probs[0] }; else if (maxIdx === 1) result = { predicted_score: null, predicted_result: '무', confidence: probs[1] }; else if (maxIdx === 2) result = { predicted_score: null, predicted_result: '패', confidence: probs[2] }; } } } });
  if (!result) { result = rawHtmlSearch(html, homeEn, awayEn); }
  return result;
}

async function scrapeFpai(matches) {
  if (!matches?.length) return 0;
  console.log('  [fpai] Starting 2-stage scraping...');
  const listUrls = ['https://footballpredictions.ai/', 'https://footballpredictions.ai/tomorrow', 'https://footballpredictions.ai/after-tomorrow', 'https://footballpredictions.ai/weekend', 'https://footballpredictions.ai/football-predictions/correct-score-predictions/'];
  const matchUrls = new Map();
  for (const listUrl of listUrls) { try { const resp = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } }); if (!resp.ok) continue; const html = await resp.text(); const $ = cheerio.load(html); $('a[href*="/football-predictions/"][href*="-vs-"]').each((_, el) => { const href = $(el).attr('href') || ''; const title = $(el).attr('title') || $(el).text().trim(); if (href && title && href.includes('predictions-tips')) { const fullUrl = href.startsWith('http') ? href : `https://footballpredictions.ai${href}`; matchUrls.set(fullUrl, title); } }); } catch(e) {} }
  console.log(`  [fpai] Collected ${matchUrls.size} match URLs from listings`);
  const matchPairs = [];
  for (const match of matches) { if (!match.home_team_en || !match.away_team_en) continue; const homeAliases = [...getAliases(match.home_team_en), match.home_team_en]; const awayAliases = [...getAliases(match.away_team_en), match.away_team_en]; for (const [url, title] of matchUrls.entries()) { const searchText = (title + ' ' + url.replace(/-/g, ' ')).toLowerCase(); if (homeAliases.some(a => searchText.includes(a.toLowerCase())) && awayAliases.some(a => searchText.includes(a.toLowerCase()))) { matchPairs.push({ match, url }); break; } } }
  console.log(`  [fpai] Matched ${matchPairs.length}/${matches.length} matches to URLs`);
  let saved = 0;
  for (const { match, url } of matchPairs) { try { const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } }); if (!resp.ok) continue; const html = await resp.text(); const prediction = parseFpaiDetailPage(html); if (prediction) { const result = await supabaseUpsert('predictions', { match_id: match.id, source: 'fpai', predicted_score: prediction.predicted_score || null, predicted_result: prediction.predicted_result || null, confidence: prediction.confidence || null, scraped_at: new Date().toISOString() }, 'match_id,source'); if (result.ok) saved++; } await new Promise(r => setTimeout(r, 200)); } catch(e) {} }
  return saved;
}
function parseFpaiDetailPage(html) {
  if (!html) return null; const $ = cheerio.load(html); let predicted_score = null, predicted_result = null, confidence = null; const text = $('body').text();
  const csm = text.match(/Correct Score Prediction[\s\S]*?(\d+)\s*[-–]\s*(\d+)[\s\S]*?Odd:\s*([\d.]+)/);
  if (csm) { const hg = parseInt(csm[1]), ag = parseInt(csm[2]); predicted_score = `${hg}-${ag}`; predicted_result = hg > ag ? '승' : hg < ag ? '패' : '무'; }
  if (!predicted_result) { const mm = text.match(/(?:Main Prediction|1x2 Prediction)\s*([1X2])\s*Odd:/); if (mm) { predicted_result = mm[1] === '1' ? '승' : mm[1] === '2' ? '패' : '무'; } }
  if (!predicted_result) return null;
  return { predicted_score, predicted_result, confidence };
}
function parseFpai(html, homeEn, awayEn) { return null; }

let _vitibetCache = { html: null, $: null };
function parseVitibet(html, homeEn, awayEn) {
  let $; if (_vitibetCache.html === html) { $ = _vitibetCache.$; } else { $ = cheerio.load(html); _vitibetCache = { html, $ }; }
  let result = null;
  // 1차: vetsipismo + standardbunkaprocenta
  $('tr').each((_, row) => {
    if (result) return;
    const hasVetsipismo = $(row).find('td.vetsipismo').length > 0;
    const hasProba = $(row).find('td.standardbunkaprocenta').length > 0;
    if (!hasVetsipismo || !hasProba) return;
    const text = $(row).text(); if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return;
    const tds = []; $(row).find('td').each((_, td) => { tds.push({ text: $(td).text().trim(), class: $(td).attr('class') || '' }); });
    let homeGoals = null, awayGoals = null, foundColon = false;
    for (let i = 0; i < tds.length; i++) { const td = tds[i]; if (td.class.includes('vetsipismo') && /^\d+$/.test(td.text)) { if (homeGoals === null) homeGoals = parseInt(td.text); else if (foundColon) { awayGoals = parseInt(td.text); break; } } if (td.text === ':' && homeGoals !== null) foundColon = true; }
    if (homeGoals !== null && awayGoals !== null) { result = { predicted_score: `${homeGoals}-${awayGoals}`, predicted_result: homeGoals > awayGoals ? '승' : homeGoals < awayGoals ? '패' : '무' }; return; }
    for (const td of tds) { if (result) break; if (td.class.includes('barvapodtipek') || td.class.includes('tip')) { const tip = td.text.trim(); if (tip === '1' || tip === '10' || tip === '01') result = { predicted_score: null, predicted_result: '승' }; else if (tip === '2' || tip === '20' || tip === '02') result = { predicted_score: null, predicted_result: '패' }; else if (tip.toUpperCase() === 'X' || tip === '0X' || tip === 'X0') result = { predicted_score: null, predicted_result: '무' }; } }
  });
  // 1.5차: vetsipismo만 있는 행
  if (!result) { $('tr').each((_, row) => { if (result) return; if ($(row).find('td.vetsipismo').length === 0) return; if ($(row).find('td[class*="barvapodtipek"]').length > 0) return; const text = $(row).text(); if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return; const tds = []; $(row).find('td').each((_, td) => { tds.push({ text: $(td).text().trim(), class: $(td).attr('class') || '' }); }); let homeGoals = null, awayGoals = null, foundColon = false; for (let i = 0; i < tds.length; i++) { const td = tds[i]; if (td.class.includes('vetsipismo') && /^\d+$/.test(td.text)) { if (homeGoals === null) homeGoals = parseInt(td.text); else if (foundColon) { awayGoals = parseInt(td.text); break; } } if (td.text === ':' && homeGoals !== null) foundColon = true; } if (homeGoals !== null && awayGoals !== null) result = { predicted_score: `${homeGoals}-${awayGoals}`, predicted_result: homeGoals > awayGoals ? '승' : homeGoals < awayGoals ? '패' : '무' }; }); }
  // 2차: fallback
  if (!result) { $('tr').each((_, row) => { if (result) return; const text = $(row).text(); if (!fuzzy(text, homeEn) || !fuzzy(text, awayEn)) return; const tds = []; $(row).find('td').each((_, td) => { tds.push({ text: $(td).text().trim(), class: $(td).attr('class') || '' }); }); let lastMatch = null; for (let i = 0; i < tds.length - 2; i++) { const a = tds[i].text, sep = tds[i+1].text, b = tds[i+2].text; if (/^\d+$/.test(a) && sep === ':' && /^\d+$/.test(b)) { const hg = parseInt(a), ag = parseInt(b); if (hg < 20 && ag < 20) lastMatch = { hg, ag }; } } if (lastMatch) { result = { predicted_score: `${lastMatch.hg}-${lastMatch.ag}`, predicted_result: lastMatch.hg > lastMatch.ag ? '승' : lastMatch.hg < lastMatch.ag ? '패' : '무' }; return; } for (const td of tds) { if (result) break; if (td.class.includes('barvapodtipek') || td.class.includes('tip')) { const tip = td.text.trim(); if (tip === '1' || tip === '10' || tip === '01') result = { predicted_score: null, predicted_result: '승' }; else if (tip === '2' || tip === '20' || tip === '02') result = { predicted_score: null, predicted_result: '패' }; else if (tip.toUpperCase() === 'X' || tip === '0X' || tip === 'X0') result = { predicted_score: null, predicted_result: '무' }; } } if (!result) { for (const td of [...tds].reverse()) { if (result) break; if (td.text === '1') result = { predicted_score: null, predicted_result: '승' }; else if (td.text === '2') result = { predicted_score: null, predicted_result: '패' }; else if (td.text.toUpperCase() === 'X') result = { predicted_score: null, predicted_result: '무' }; } } }); }
  return result;
}

function rawHtmlSearch(html, homeEn, awayEn) {
  const lowerHtml = html.toLowerCase(); const homeAliases = getAliases(homeEn); const awayAliases = getAliases(awayEn);
  for (const homeAlias of homeAliases) { const homeKey = homeAlias.toLowerCase(); const homeIdx = lowerHtml.indexOf(homeKey); if (homeIdx < 0) continue; for (const awayAlias of awayAliases) { const awayKey = awayAlias.toLowerCase(); const region = lowerHtml.substring(Math.max(0, homeIdx - 500), homeIdx + 2000); if (!region.includes(awayKey)) continue; const regionHtml = html.substring(Math.max(0, homeIdx - 500), homeIdx + 2000); const scoreMatch = regionHtml.match(/(\d+)\s*[-–:]\s*(\d+)/); if (scoreMatch) { const hg = parseInt(scoreMatch[1]), ag = parseInt(scoreMatch[2]); if (hg < 20 && ag < 20) return { predicted_score: `${hg}-${ag}`, predicted_result: hg > ag ? '승' : hg < ag ? '패' : '무' }; } } }
  return null;
}
// ====== ALIAS_MAP ======
const ALIAS_MAP = {
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
  'Shonan Bellmare': ['Shonan Bellmare', 'Shonan'],
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
  'Nottingham Forest': ['Nottingham Forest', 'Nott. Forest', 'Nottingham', "Nott'm Forest"],
  'Brentford': ['Brentford'],
  'Southampton': ['Southampton'],
  'Leicester City': ['Leicester City', 'Leicester'],
  'Ipswich Town': ['Ipswich Town', 'Ipswich'],
  'Leeds United': ['Leeds United', 'Leeds Utd', 'Leeds'],
  'Sunderland': ['Sunderland'],
  'Burnley': ['Burnley'],
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
  'Sassuolo': ['Sassuolo'],
  'Cremonese': ['Cremonese'],
  'Dortmund': ['Dortmund', 'Borussia Dortmund', 'B. Dortmund'],
  'Mainz': ['Mainz', 'Mainz 05', 'FSV Mainz'],
  'Bayer Leverkusen': ['Bayer Leverkusen', 'Leverkusen', 'B. Leverkusen'],
  'St. Pauli': ['St. Pauli', 'FC St. Pauli', 'Sankt Pauli'],
  'Eintracht Frankfurt': ['Eintracht Frankfurt', 'E. Frankfurt', 'Frankfurt'],
  'Monchengladbach': ['Monchengladbach', 'B. Monchengladbach', "Borussia M'gladbach", 'Gladbach', "M'gladbach", 'Mönchengladbach'],
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
  'Excelsior': ['Excelsior'],
  'Qarabag': ['Qarabag', 'Qarabağ', 'Qarabag FK', 'Qarabağ FK', 'Qarabagh'],
  'Bodo/Glimt': ['Bodo/Glimt', 'Bodø/Glimt', 'Bodo Glimt', 'Bodoe/Glimt', 'Bodoe Glimt', 'FK Bodo/Glimt', 'FK Bodø/Glimt'],
  'Olympiacos': ['Olympiacos', 'Olympiakos', 'Olympiacos Piraeus', 'Olympiakos Piraeus'],
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
  'Viktoria Plzen': ['Viktoria Plzen', 'Viktoria Plzeň', 'Plzen', 'Plzeň'],
  'Crvena Zvezda': ['Crvena Zvezda', 'Red Star Belgrade', 'Red Star'],
  'Ferencvaros': ['Ferencvaros', 'Ferencvarosi', 'Ferencvárosi', 'Ferencváros', 'FTC'],
  'Rapid Wien': ['Rapid Wien', 'Rapid Vienna', 'SK Rapid Wien'],
  'Sturm Graz': ['Sturm Graz', 'SK Sturm Graz'],
  'Young Boys': ['Young Boys', 'BSC Young Boys', 'YB Bern'],
  'Shakhtar Donetsk': ['Shakhtar Donetsk', 'Shakhtar', 'Shaktar Donetsk'],
  'Dynamo Kyiv': ['Dynamo Kyiv', 'Dynamo Kiev', 'D. Kyiv'],
  'Slavia Prague': ['Slavia Prague', 'Slavia Praha', 'SK Slavia'],
  'Sparta Prague': ['Sparta Prague', 'Sparta Praha', 'AC Sparta'],
  'Malmo': ['Malmo', 'Malmö', 'Malmö FF', 'Malmo FF'],
  'Copenhagen': ['Copenhagen', 'FC Copenhagen', 'FC København'],
  'SK Brann': ['SK Brann', 'Brann', 'Brann Bergen'],
  'Molde': ['Molde', 'Molde FK'],
  'Larnaca': ['Larnaca', 'AEK Larnaca', 'AEK Larnaka'],
  'Omonia': ['Omonia', 'Omonia Nicosia', 'AC Omonia'],
  'LASK': ['LASK', 'LASK Linz'],
  'Djurgarden': ['Djurgarden', 'Djurgårdens', 'Djurgårdens IF'],
  'KUPS': ['KUPS', 'KuPS Kuopio', 'Kuopion PS'],
  'FC Noah': ['FC Noah', 'Noah FC', 'Noah'],
  'Zrinjski': ['Zrinjski', 'Zrinjski Mostar'],
  'Drita': ['Drita', 'FC Drita', 'KF Drita'],
  'Shkendija': ['Shkendija', 'KF Shkëndija', 'Shkendija Tetovo', 'Skendija'],
  'Al Ahli': ['Al Ahli', 'Al-Ahli'],
  'Al Nassr': ['Al Nassr', 'Al-Nassr'],
  'Al Hilal': ['Al Hilal', 'Al-Hilal'],
  'Al Ittihad': ['Al Ittihad', 'Al-Ittihad'],
  'LAFC': ['LAFC', 'Los Angeles FC', 'LA FC'],
  'Gangwon FC': ['Gangwon FC', 'Gangwon'],
  'Ulsan HD': ['Ulsan HD', 'Ulsan Hyundai', 'Ulsan', 'Ulsan HD FC'],
  'Midtjylland': ['Midtjylland', 'FC Midtjylland'],
  'Rangers': ['Rangers', 'Rangers FC', 'Glasgow Rangers'],
  'Anderlecht': ['Anderlecht', 'RSC Anderlecht'],
  'Gent': ['Gent', 'KAA Gent', 'Ghent'],
  'Legia Warsaw': ['Legia Warsaw', 'Legia Warszawa', 'Legia'],
  'Lech Poznan': ['Lech Poznan', 'Lech Poznań', 'Lech'],
  'Trabzonspor': ['Trabzonspor'],
  'Basaksehir': ['Basaksehir', 'Başakşehir', 'Istanbul Basaksehir'],
  'Ludogorets': ['Ludogorets', 'Ludogorets Razgrad'],
  'Rijeka': ['Rijeka', 'HNK Rijeka'],
  'Samsunspor': ['Samsunspor'],
  'NK Celje': ['NK Celje', 'Celje'],
  'Lausanne Sport': ['Lausanne Sport', 'Lausanne'],
  'Sigma Olomouc': ['Sigma Olomouc', 'SK Sigma Olomouc', 'Olomouc'],
  'Jagiellonia': ['Jagiellonia', 'Jagiellonia Bialystok'],
  'KuPS': ['KuPS', 'KUPS', 'KuPS Kuopio'],
  // ★ 국가대표팀 별칭 (매칭 개선)
  'Ukraine': ['Ukraine'], 'Spain': ['Spain'], 'Iraq': ['Iraq'], 'Syria': ['Syria'],
  'Iran': ['Iran'], 'Jordan': ['Jordan'], 'Greece': ['Greece'], 'Montenegro': ['Montenegro'],
  'Austria': ['Austria'], 'Netherlands': ['Netherlands', 'Holland'],
  'Hungary': ['Hungary'], 'France': ['France'], 'Denmark': ['Denmark'], 'Georgia': ['Georgia'],
  'Latvia': ['Latvia'], 'Poland': ['Poland'], 'Slovenia': ['Slovenia'],
  'Czech Republic': ['Czech Republic', 'Czech Rep.', 'Czechia'],
  'Serbia': ['Serbia'], 'Turkey': ['Turkey', 'Türkiye', 'Turkiye'],
  'Sweden': ['Sweden'], 'Estonia': ['Estonia'], 'Portugal': ['Portugal'], 'Romania': ['Romania'],
  'Bosnia': ['Bosnia', 'Bosnia and Herzegovina', 'Bosnia & Herzegovina'],
  'Switzerland': ['Switzerland'], 'Croatia': ['Croatia'], 'Germany': ['Germany'],
  'Israel': ['Israel'], 'Cyprus': ['Cyprus'], 'Lebanon': ['Lebanon'],
  'Saudi Arabia': ['Saudi Arabia'], 'England': ['England'], 'Italy': ['Italy'],
  'Iceland': ['Iceland'], 'Lithuania': ['Lithuania'], 'Belgium': ['Belgium'], 'Finland': ['Finland'],
  'Brazil': ['Brazil'], 'Venezuela': ['Venezuela'], 'Chile': ['Chile'], 'Colombia': ['Colombia'],
  'Argentina': ['Argentina'], 'Uruguay': ['Uruguay'], 'Cuba': ['Cuba'], 'Panama': ['Panama'],
  'Mexico': ['Mexico'], 'USA': ['USA', 'United States', 'U.S.A.'],
  'Canada': ['Canada'], 'Japan': ['Japan'], 'Australia': ['Australia'],
  'South Korea': ['South Korea', 'Korea Republic', 'Korea Rep.'],
  'China': ['China', 'China PR'], 'New Zealand': ['New Zealand'],
  'Philippines': ['Philippines'], 'Guam': ['Guam'], 'Taiwan': ['Taiwan', 'Chinese Taipei'],
  'Jamaica': ['Jamaica'], 'Dominican Republic': ['Dominican Republic'],
  'Nicaragua': ['Nicaragua'], 'Puerto Rico': ['Puerto Rico'], 'Bahamas': ['Bahamas'],
};

function getAliases(teamEn) {
  if (!teamEn) return [];
  if (ALIAS_MAP[teamEn]) return ALIAS_MAP[teamEn];
  for (const [key, aliases] of Object.entries(ALIAS_MAP)) {
    if (aliases.some(a => a.toLowerCase() === teamEn.toLowerCase())) return aliases;
  }
  return [teamEn];
}

function fuzzy(text, team) {
  if (!text || !team) return false;
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = norm(text);
  const parts = norm(team).split(/\s+/);
  if (parts.every(p => t.includes(p))) return true;
  if (parts[0].length >= 4 && t.includes(parts[0])) return true;
  if (parts.length > 1 && parts[1].length >= 4 && t.includes(parts[1])) return true;
  const aliases = getAliases(team);
  for (const alias of aliases) {
    if (alias === team) continue;
    const aliasParts = norm(alias).split(/\s+/);
    if (aliasParts.every(p => t.includes(p))) return true;
    if (aliasParts.length === 1 && aliasParts[0].length >= 4 && t.includes(aliasParts[0])) return true;
    if (aliasParts[0].length >= 4 && t.includes(aliasParts[0])) return true;
  }
  return false;
}

// ====== TEAM_MAP (한국팀명 → 영문) ======
const TEAM_MAP = {
  '웨스원더': 'Western Sydney', '웰링피닉': 'Wellington Phoenix', '멜버빅토': 'Melbourne Victory',
  '브리로어': 'Brisbane Roar', '시드니FC': 'Sydney FC', '애들유나': 'Adelaide United',
  '퍼스글로': 'Perth Glory', '뉴캐제츠': 'Newcastle Jets', '센트마리': 'Central Coast Mariners',
  '맥아서': 'Macarthur FC', '멜버시티': 'Melbourne City', '오클랜드': 'Auckland FC',
  '웰링턴': 'Wellington Phoenix', '멜번빅토': 'Melbourne Victory', '멜번시티': 'Melbourne City',
  '센트럴코': 'Central Coast Mariners', '브리즈번': 'Brisbane Roar', '애들레유': 'Adelaide United',
  '매콰리유': 'Macarthur FC', '웨스시드': 'Western Sydney',
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
  '토쿄V': 'Tokyo Verdy', '오이타': 'Oita Trinita', '에히메': 'Ehime FC',
  '야마가타': 'Montedio Yamagata', '로아소쿠': 'Roasso Kumamoto', '이와키': 'Iwaki FC',
  '레노파야': 'Renofa Yamaguchi', '반포레': 'Ventforet Kofu', '자스파쿠': 'Zweigen Kanazawa',
  '가이나레': 'Gainare Tottori', '후지에다': 'Fujieda MYFC', '카타프로': 'Kataller Toyama',
  '오미야아': 'Omiya Ardija', '츠에겐가': 'Zweigen Kanazawa',
  '쇼난': 'Shonan Bellmare', '하치노헤': 'Vanraure Hachinohe', '미야자키': 'Tegevajaro Miyazaki',
  '고후': 'Ventforet Kofu', '오클FC': 'Auckland FC',
  '전북현대': 'Jeonbuk Hyundai', '대전하나': 'Daejeon Hana Citizen',
  '리버풀': 'Liverpool', '브라이턴': 'Brighton', 'A빌라': 'Aston Villa', '뉴캐슬U': 'Newcastle United',
  '맨시티': 'Manchester City', '아스널': 'Arsenal', '첼시': 'Chelsea', '맨유': 'Manchester United',
  '토트넘': 'Tottenham', '에버턴': 'Everton', '웨스트햄': 'West Ham', '풀럼': 'Fulham',
  '본머스': 'Bournemouth', '울버햄프': 'Wolverhampton', '크리스탈': 'Crystal Palace',
  '노팅엄': 'Nottingham Forest', '브렌트포': 'Brentford', '사우샘프': 'Southampton',
  '레스터C': 'Leicester City', '입스위치': 'Ipswich Town', '리즈유나': 'Leeds United',
  '선덜랜드': 'Sunderland', '번리': 'Burnley',
  '헐시티': 'Hull City', '렉섬': 'Wrexham', '더비카운': 'Derby County', '스완지C': 'Swansea City',
  '포츠머스': 'Portsmouth', '셰필드U': 'Sheffield United', '프레스턴': 'Preston', '왓포드': 'Watford',
  '퀸즈파크': 'QPR', '블랙번': 'Blackburn', '셰필드웬': 'Sheffield Wednesday', '밀월': 'Millwall',
  '노리치C': 'Norwich City', '웨스브로': 'West Brom', '버밍엄C': 'Birmingham City', '리즈U': 'Leeds United',
  '옥스퍼드': 'Oxford United', '스토크C': 'Stoke City', '카디프': 'Cardiff City',
  '미들즈브': 'Middlesbrough', '코벤트리': 'Coventry City', '루턴타운': 'Luton Town',
  '플리머스': 'Plymouth Argyle', '브리스톨': 'Bristol City',
  '에스파뇰': 'Espanyol', 'RC셀타': 'Celta Vigo', '헤타페': 'Getafe', '비야레알': 'Villarreal',
  '세비야': 'Sevilla', '알라베스': 'Alaves', '레알마드': 'Real Madrid', '소시에다': 'Real Sociedad',
  '라요': 'Rayo Vallecano', 'AT마드': 'Atletico Madrid', '마요르카': 'Mallorca', '베티스': 'Real Betis',
  '바르셀로': 'Barcelona', '발렌시아': 'Valencia', '오사수나': 'Osasuna', '지로나': 'Girona',
  '라스팔마': 'Las Palmas', '레가네스': 'Leganes', '발라돌리': 'Real Valladolid',
  '빌바오': 'Athletic Bilbao', 'AT마드리': 'Atletico Madrid',
  '레반테': 'Levante', '오비에도': 'Real Oviedo',
  '피사SC': 'Pisa', 'AC밀란': 'AC Milan', '코모1907': 'Como', '피오렌티': 'Fiorentina',
  '라치오': 'Lazio', '아탈란타': 'Atalanta', '인테르': 'Inter Milan', '유벤투스': 'Juventus',
  '우디네세': 'Udinese', '사수올로': 'Sassuolo', '크레모네': 'Cremonese', '제노아': 'Genoa',
  '파르마': 'Parma', '엘라스': 'Hellas Verona', '토리노': 'Torino', '볼로나': 'Bologna',
  '나폴리': 'Napoli', 'AS로마': 'AS Roma', '엠폴리': 'Empoli', '카글리아': 'Cagliari',
  '레체': 'Lecce', '몬자': 'Monza', '베네치아': 'Venezia', '사레르니': 'Salernitana', '볼로냐': 'Bologna',
  '도르트문': 'Dortmund', '마인츠05': 'Mainz', '레버쿠젠': 'Bayer Leverkusen', '장크트파': 'St. Pauli',
  '프랑크푸': 'Eintracht Frankfurt', '뮌헨글라': 'Monchengladbach', '브레멘': 'Werder Bremen',
  '바이뮌헨': 'Bayern Munich', '호펜하임': 'Hoffenheim', '프라이부': 'Freiburg',
  '슈투트가': 'Stuttgart', '퀼른': 'Koln', '아우크스': 'Augsburg', '하이덴하': 'Heidenheim',
  '라이프치': 'RB Leipzig', '볼프스부': 'Wolfsburg', '보훔': 'Bochum', '볼프스': 'Wolfsburg',
  '다름슈타': 'Darmstadt',
  '함부르크': 'Hamburger SV', 'U베를린': 'Union Berlin', '키엘': 'Holstein Kiel',
  '카이저슬': 'Kaiserslautern', '뒤셀도르': 'Fortuna Dusseldorf', '뉘른베르': 'Nurnberg',
  '샬케04': 'Schalke 04', '파더보른': 'Paderborn', '헤르타B': 'Hertha Berlin',
  '그로이터': 'Greuther Furth', '마그데부': 'Magdeburg', '하노버96': 'Hannover 96',
  '브라운슈': 'Braunschweig', '엘베어슈': 'Elversberg', '카를스루': 'Karlsruher',
  '스타드렌': 'Rennes', 'PSG': 'PSG', 'AS모나코': 'Monaco', '낭트': 'Nantes',
  '마르세유': 'Marseille', 'RC스트라': 'Strasbourg', '릴OSC': 'Lille', '브레스투': 'Brest',
  '르아브르': 'Le Havre', '툴루즈': 'Toulouse', '메스': 'Metz', '오세르': 'Auxerre',
  '리옹': 'Lyon', 'OGC니스': 'Nice', '랑스': 'Lens', '몽펠리에': 'Montpellier',
  '클레르몽': 'Clermont', '로리앙': 'Lorient', '생테티엔': 'Saint-Etienne',
  '앙제': 'Angers SCO', '렌느': 'Rennes', '파리FC': 'Paris FC', '앙제SCO': 'Angers SCO',
  '플렌담': 'Feyenoord', '헤라클레': 'Heracles', '브레다': 'NAC Breda',
  '엑셀시오': 'Excelsior', '알크마르': 'AZ Alkmaar', '아약스': 'Ajax', 'F시타르': 'Fortuna Sittard',
  '흐로닝언': 'Groningen', '위트레흐': 'Utrecht', '페예노르': 'Feyenoord', '고어헤드': 'Go Ahead Eagles',
  '헤이렌베': 'Heerenveen', '즈볼러': 'PEC Zwolle', '스파로테': 'Sparta Rotterdam',
  '네이메헌': 'NEC Nijmegen', '트벤테': 'Twente', '텔스타': 'Telstar',
  '빌렘II': 'Willem II', '알메르시': 'Almere City',
  '엘체': 'Elche', '오사수니': 'Osasuna',
  '맨체스U': 'Manchester United', '클뤼브뤼': 'Club Brugge', '브리스C': 'Bristol City',
  '찰턴': 'Charlton Athletic', '올림피아': 'Olympiacos', '보되글림': 'Bodo/Glimt',
  '카라바흐': 'Qarabag', 'LAFC': 'LAFC', '레알에스': 'Real Estelí',
  '삼순스포': 'Samsunspor', '스켄디야': 'Shkendija', 'NK첼레': 'NK Celje', '드리타': 'Drita',
  '리예카': 'Rijeka', '오모니아': 'Omonia', '페렌츠바': 'Ferencvaros', '루도고레': 'Ludogorets',
  '플젠': 'Viktoria Plzen', '파나티나': 'Panathinaikos', '츠르베나': 'Crvena Zvezda',
  '셀틱': 'Celtic', 'L포즈난': 'Lech Poznan', 'KuPS': 'KuPS',
  'FC노아': 'FC Noah', '크리스털': 'Crystal Palace', '즈린스키': 'Zrinjski',
  '로잔스포': 'Lausanne Sport', 'SK시그마': 'Sigma Olomouc', 'KRC헹크': 'KRC Genk',
  'D자그레': 'Dinamo Zagreb', 'PAOK': 'PAOK', 'SK브란': 'SK Brann',
  '노팅엄포': 'Nottingham Forest', '페네르SK': 'Fenerbahce',
  '코번트리': 'Coventry City', '갈라타사': 'Galatasaray', 'SL벤피카': 'Benfica',
  '야기엘로': 'Jagiellonia', '아이슬란': 'Iceland',
  '괌M': 'Guam', '호주M': 'Australia', '일본M': 'Japan', '중국M': 'China',
  '대만M': 'Taiwan', '한국M': 'South Korea', '필리핀M': 'Philippines', '뉴질랜M': 'New Zealand',
  '멕시코': 'Mexico',
  '자메이M': 'Jamaica', '바하마M': 'Bahamas', '푸에르M': 'Puerto Rico',
  '캐나다M': 'Canada', '니카라M': 'Nicaragua', '멕시코M': 'Mexico',
  '미국M': 'USA', '도미공M': 'Dominican Republic',
  '우크라M': 'Ukraine', '스페인M': 'Spain', '이라크M': 'Iraq', '시리아M': 'Syria',
  '이란M': 'Iran', '요르단M': 'Jordan', '그리스M': 'Greece', '몬테네M': 'Montenegro',
  '오스트M': 'Austria', '네덜란M': 'Netherlands', '헝가리M': 'Hungary', '프랑스M': 'France',
  '덴마크M': 'Denmark', '조지아M': 'Georgia', '라트비M': 'Latvia', '폴란드M': 'Poland',
  '슬로베M': 'Slovenia', '체코M': 'Czech Republic', '세르비M': 'Serbia', '튀르키M': 'Turkey',
  '스웨덴M': 'Sweden', '에스토M': 'Estonia', '포르투M': 'Portugal', '루마니M': 'Romania',
  '보스니M': 'Bosnia', '스위스M': 'Switzerland', '크로아M': 'Croatia', '독일M': 'Germany',
  '이스라M': 'Israel', '키프로M': 'Cyprus', '레바논M': 'Lebanon', '사우디M': 'Saudi Arabia',
  '영국M': 'England', '이탈리M': 'Italy', '아이슬M': 'Iceland', '리투아M': 'Lithuania',
  '벨기에M': 'Belgium', '핀란드M': 'Finland',
  '브라질M': 'Brazil', '베네수M': 'Venezuela', '칠레M': 'Chile', '콜롬비M': 'Colombia',
  '아르헨M': 'Argentina', '우루과M': 'Uruguay', '쿠바M': 'Cuba', '파나마M': 'Panama',
  '인천유나': 'Incheon United', 'FC서울': 'FC Seoul', '울산HDFC': 'Ulsan HD FC',
  '강원FC': 'Gangwon FC', '김해FC': 'Gimhae FC', '안산그리': 'Ansan Greeners',
  '센트매리': 'Central Coast Mariners', '김천상무': 'Gimcheon Sangmu',
  '포항스틸': 'Pohang Steelers', '수원삼성': 'Suwon Samsung', '서울이랜': 'Seoul E-Land',
  '제주SKFC': 'Jeju United', '광주FC': 'Gwangju FC', '경남FC': 'Gyeongnam FC',
  '전남드래': 'Jeonnam Dragons', '부천FC': 'Bucheon FC', '용인FC': 'Yongin FC',
  '천안시티': 'Cheonan City FC', '대구FC': 'Daegu FC', '화성FC': 'Hwaseong FC',
  '충북청주': 'Chungbuk Cheongju', '수원FC': 'Suwon FC', 'FC안양': 'FC Anyang',
  '충남아산': 'Chungnam Asan', '파주프런': 'Paju Frontier',
  '시카파이': 'Chicago Fire', 'CF몽레알': 'CF Montreal', '뉴욕레드': 'New York Red Bulls',
  '뉴잉레벌': 'New England Revolution', '콜로래피': 'Colorado Rapids', '포틀팀버': 'Portland Timbers',
  '미네유나': 'Minnesota United', 'FC신시내': 'FC Cincinnati', '레알솔트': 'Real Salt Lake',
  '시애사운': 'Seattle Sounders', '새너어스': 'San Jose Earthquakes', '애틀유나': 'Atlanta United',
  'FC댈러스': 'FC Dallas', '내슈빌SC': 'Nashville SC', '휴스다이': 'Houston Dynamo',
  '스포캔자': 'Sporting Kansas City', '콜럼크루': 'Columbus Crew', '밴쿠화이': 'Vancouver Whitecaps',
  '토론토FC': 'Toronto FC', 'LA갤럭시': 'LA Galaxy', '샬럿FC': 'Charlotte FC',
  '오스틴FC': 'Austin FC', 'DC유나이': 'DC United', '필라유니': 'Philadelphia Union',
  '뉴욕시티': 'New York City FC', '올랜시티': 'Orlando City', '인터마이': 'Inter Miami',
  '샌디에FC': 'San Diego FC', '세인시티': 'St. Louis City',
  '쾰른': 'Koln', '칼리아리': 'Cagliari', 'US레체': 'Lecce', '묀헨글라': 'Monchengladbach',
  '브렌트퍼': 'Brentford', '맨체스C': 'Manchester City', '맥아서FC': 'Macarthur FC',
  '폴렌담': 'Volendam', '이마바리': 'FC Imabari',
};

const LEAGUE_MAP = {
  'A리그': 'A-League', 'J1백년': 'J리그', 'J2백년': 'J2리그', 'J1리그': 'J리그', 'J2리그': 'J2리그',
  'J2J3백년': 'J2리그',
  '프리미어': 'PremierLeague', 'EPL': 'PremierLeague',
  'EFL챔': 'Championship', 'EFL챔피': 'Championship',
  '라리가': 'LaLiga', '라리가2': 'LaLiga2', '세리에A': 'SerieA', '세리에B': 'SerieB',
  '분데스리': 'Bundesliga', '분데스2': 'Bundesliga2',
  '프리그1': 'Ligue1', '리그1': 'Ligue1', '리그2': 'Ligue2', '프리그2': 'Ligue2',
  '에레디비': 'Eredivisie', '에레디2': 'Eredivisie2',
  'UEFA유로': 'UEFAEuropa', 'UEFA챔': 'UEFAChampions', 'UCL': 'UEFAChampions', 'UEL': 'UEFAEuropa',
  'UECL': 'UEFAConference', 'MLS': 'MLS', 'CONCACAF': 'CONCACAF',
  'FA컵': 'FACup', '코파델레': 'CopaDelRey', '국왕컵': 'CopaDelRey', 'DFB포칼': 'DFBPokal',
  'K슈퍼컵': 'KLeague', 'K리그1': 'KLeague', 'K리그2': 'KLeague2',
  '남농월예': 'WCQ', '남미월예': 'WCQ', '월드컵예': 'WCQ', '월예선': 'WCQ',
  'AFC월예': 'WCQ', '리그앙': 'Ligue1',
};

// ====== HTML SAMPLE ======
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
    if (idx >= 0) { samples.push(html.substring(Math.max(0, idx - 200), Math.min(html.length, idx + 300))); }
    const $ = cheerio.load(html);
    const rows = [];
    $('tr, .rcnt, div[class*="match"], div[class*="row"]').each((_, el) => {
      const text = $(el).text();
      if (text.toLowerCase().includes(team.toLowerCase()) && text.length < 1000) {
        rows.push({ tag: el.name, class: $(el).attr('class') || '', html: $.html(el).substring(0, 500), text: text.substring(0, 300) });
      }
    });
    if (browser) { try { await browser.close(); } catch(e) {} browser = null; }
    res.json({ site, team, found: idx >= 0, htmlLength: html.length, context: samples[0] || 'NOT FOUND', matchingRows: rows.slice(0, 3) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== FETCH MATCHES ======
app.get('/fetch-matches', auth, async (req, res) => {
  if (checkRunningLock()) return res.json({ error: 'Scraping in progress, try again later' });
  if (isFetchingMatches) return res.json({ error: 'Already fetching matches' });
  const roundParam = req.query.round;
  const urlParam = req.query.url;
  res.json({ message: `Fetching matches started${roundParam ? ` (round ${roundParam})` : ''}`, timestamp: new Date().toISOString() });
  doFetchMatches(roundParam ? parseInt(roundParam) : null, urlParam).catch(e => console.error('Fetch matches error:', e.message));
});

let isFetchingMatches = false;

async function doFetchMatches(overrideRound = null, urlVariant = null) {
  if (isFetchingMatches) { console.log('  doFetchMatches already running, skip'); return; }
  if (checkRunningLock()) { console.log('  Scraping in progress, skip fetch-matches'); return; }
  isFetchingMatches = true;
  try {
    console.log(`=== Fetching match results (no Puppeteer)${overrideRound ? ` [round ${overrideRound}]` : ''} ===`);
    let html = '', source = '', roundYear = new Date().getFullYear().toString(), roundNumber = null;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ko-KR,ko;q=0.9' };

    try {
      const wtResp = await fetch('https://www.wisetoto.com/index.htm?tab_type=proto&game_type=pt&game_category=pt1', { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      const wtHtml = await wtResp.text();
      console.log(`  WiseToto round check: ${wtHtml.length} chars`);
      const rm = wtHtml.match(/(\d{4})년도.*?(\d+)회차/s) || wtHtml.match(/game_year=(\d{4})&game_round=(\d+)/);
      if (rm) { roundYear = rm[1]; roundNumber = parseInt(rm[2]); }
      console.log(`  Current round: ${roundYear}-${roundNumber || '?'}`);
      if (overrideRound) { roundNumber = overrideRound; console.log(`  Override round: ${roundYear}-${roundNumber}`); }
      if (wtHtml.includes('id="TRID"') || wtHtml.includes('f12px_orange')) { html = wtHtml; source = 'wisetoto-ssr'; console.log('  WiseToto has SSR match data!'); }
    } catch (e) { console.log(`  WiseToto fetch failed: ${e.message}`); }

    if (!source) {
      try {
        console.log('  Trying Spojoy...');
        const sjResp = await fetch('https://www.spojoy.com/live/?mct=toto&sct=proto', { headers: HEADERS, signal: AbortSignal.timeout(30000) });
        const sjHtml = await sjResp.text();
        console.log(`  Spojoy: ${sjHtml.length} chars`);
        if (sjHtml.includes('id="TRID"') || sjHtml.includes('f12px_orange')) { html = sjHtml; source = 'spojoy'; }
        else console.log('  Spojoy: no SSR data');
      } catch (e) { console.log(`  Spojoy fetch failed: ${e.message}`); }
    }

    if (!source) {
      const zentotoUrls = urlVariant === 'games' ? ['https://www.zentoto.com/proto/games'] : ['https://www.zentoto.com/proto/games', 'https://www.zentoto.com/proto'];
      for (const zUrl of zentotoUrls) {
        try {
          console.log(`  Trying Zentoto (${zUrl.split('/').pop()})...`);
          const zResp = await fetch(zUrl, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
          const zHtml = await zResp.text();
          console.log(`  Zentoto: ${zHtml.length} chars`);
          const z$ = cheerio.load(zHtml);
          if (z$('table tr td').length > 50) { html = zHtml; source = 'zentoto'; console.log('  Zentoto has data'); break; }
        } catch (e) { console.log(`  Zentoto fetch failed: ${e.message}`); }
      }
    }

    if (!source || !html) { console.log('  No data source available'); return; }
    console.log(`  Round: ${roundYear}-${roundNumber || '?'}`);
    const $ = cheerio.load(html);
    const matches = [];
    const seenTeams = new Set();
    let debugCount = 0;

    if (source === 'zentoto') {
      console.log('  Parsing Zentoto HTML (table structure)...');
      if (!roundNumber) {
        try {
          const wtResp = await fetch('https://www.wisetoto.com/index.htm?tab_type=proto&game_type=pt&game_category=pt1', { headers: HEADERS, signal: AbortSignal.timeout(15000) });
          const wtHtml = await wtResp.text();
          const rm = wtHtml.match(/(\d{4})년도.*?(\d+)회차/s) || wtHtml.match(/game_year=(\d{4})&game_round=(\d+)/);
          if (rm) { roundYear = rm[1]; roundNumber = parseInt(rm[2]); }
        } catch (e) {}
      }
      $('tr').each((_, tr) => {
        const $tr = $(tr);
        const cells = $tr.find('> td');
        if (cells.length < 6) return;
        const noText = $(cells[0]).text().trim();
        const noMatch = noText.match(/^(\d+)/);
        if (!noMatch) return;
        const matchNum = parseInt(noMatch[1]);
        if (isNaN(matchNum) || matchNum < 1) return;
        const typeText = $(cells[4]).text().trim();
        if (typeText && (typeText.includes('H-') || typeText.includes('H+') || typeText.includes('U/O') || typeText.includes('승5패') || typeText === 'NONE')) return;
        const league = $(cells[1]).text().trim();
        const nonSoccerLeagues = ['NBA', 'KBL', 'WKBL', 'KOVO남', 'KOVO여', 'KBO', 'MLB', 'NPB', 'NHL', 'NFL'];
        if (nonSoccerLeagues.some(l => league.includes(l))) return;
        const matchCell = $(cells[3]).text().trim().replace(/\s+/g, ' ');
        const statusText = $(cells[cells.length - 1]).text().trim();
        const isFinished = statusText.includes('경기종료') || statusText.includes('종료');
        let homeKr = '', awayKr = '', actualHomeScore = null, actualAwayScore = null, actualResult = null;
        const scoreMatch = matchCell.match(/^(.+?)\s+(\d+)\s*:\s*(\d+)\s+(.+)$/);
        if (scoreMatch) {
          homeKr = scoreMatch[1].trim(); awayKr = scoreMatch[4].trim();
          if (isFinished) {
            actualHomeScore = parseInt(scoreMatch[2]); actualAwayScore = parseInt(scoreMatch[3]);
            if (!isNaN(actualHomeScore) && !isNaN(actualAwayScore)) actualResult = actualHomeScore > actualAwayScore ? '승' : actualHomeScore < actualAwayScore ? '패' : '무';
          }
        } else {
          const vsMatch = matchCell.match(/^(.+?)\s+(?:vs|-\s*:\s*-)\s+(.+)$/);
          if (vsMatch) { homeKr = vsMatch[1].trim(); awayKr = vsMatch[2].trim(); }
        }
        if (!homeKr || !awayKr) return;
        const teamKey = `${homeKr}_${awayKr}`;
        if (seenTeams.has(teamKey)) return;
        seenTeams.add(teamKey);
        if (debugCount < 5) { console.log(`    [debug] #${matchNum}: ${league} | ${homeKr} ${actualHomeScore ?? '?'}:${actualAwayScore ?? '?'} ${awayKr} | status: "${statusText}" | type: "${typeText}"`); debugCount++; }
        if (actualHomeScore !== null) console.log(`    Match ${matchNum}: ${homeKr} ${actualHomeScore}:${actualAwayScore} ${awayKr} → ${actualResult} (${statusText})`);
        matches.push({ round_year: roundYear, round_number: roundNumber, match_number: matchNum, home_team_kr: homeKr, away_team_kr: awayKr, home_team_en: TEAM_MAP[homeKr] || '', away_team_en: TEAM_MAP[awayKr] || '', league: LEAGUE_MAP[league] || league, match_type: 'normal', actual_home_score: actualHomeScore, actual_away_score: actualAwayScore, actual_result: actualResult, odds_home: null, odds_draw: null, odds_away: null });
      });
    }

    console.log(`  Parsed ${matches.length} matches from ${source}`);
    if (!matches.length) { console.log('  No matches found.'); return; }
    const unmapped = matches.filter(m => !m.home_team_en || !m.away_team_en);
    if (unmapped.length) {
      console.log(`  ⚠ ${unmapped.length} matches with unmapped teams:`);
      unmapped.forEach(m => { if (!m.home_team_en) console.log(`    Missing: '${m.home_team_kr}'`); if (!m.away_team_en) console.log(`    Missing: '${m.away_team_kr}'`); });
    }
    const result = await supabaseUpsert('proto_matches', matches, 'round_year,round_number,match_number');
    console.log(`  DB upsert: ${result.status} (${result.ok ? 'OK' : 'FAIL'})`);
    if (!result.ok) console.log(`  DB error: ${result.body}`);
    console.log(`=== Done: ${matches.length} matches saved for round ${roundYear}-${roundNumber} ===`);
  } catch (e) { console.error('Fetch matches error:', e.message);
  } finally { isFetchingMatches = false; }
}

// ====== UPDATE ODDS ======
app.get('/update-odds', auth, async (req, res) => {
  try {
    const { round, odds } = req.query;
    if (!round || !odds) return res.json({ error: 'round and odds required' });
    const roundNumber = parseInt(round);
    const roundYear = '2026';
    const entries = odds.split(',').map(e => { const parts = e.trim().split(':'); if (parts.length < 4) return null; return { match_number: parseInt(parts[0]), odds_home: parseFloat(parts[1]), odds_draw: parseFloat(parts[2]), odds_away: parseFloat(parts[3]) }; }).filter(e => e && !isNaN(e.match_number));
    if (!entries.length) return res.json({ error: 'No valid odds entries' });
    const matchesResp = await fetch(`${SUPABASE_URL}/rest/v1/proto_matches?round_year=eq.${roundYear}&round_number=eq.${roundNumber}&match_type=eq.normal&select=id,match_number`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const matches = await matchesResp.json();
    let updated = 0;
    for (const entry of entries) {
      const match = matches.find(m => m.match_number === entry.match_number);
      if (!match) continue;
      const updateResp = await fetch(`${SUPABASE_URL}/rest/v1/proto_matches?id=eq.${match.id}`, { method: 'PATCH', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, body: JSON.stringify({ odds_home: entry.odds_home, odds_draw: entry.odds_draw, odds_away: entry.odds_away }) });
      if (updateResp.ok) updated++;
    }
    res.json({ ok: true, updated, total: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== YIELD ======
app.get('/yield', async (req, res) => {
  try {
    const { round_year, round_number } = req.query;
    if (!round_year || !round_number) return res.json({ error: 'round_year and round_number required' });
    const matches = await supabaseGet('proto_matches', `round_year=eq.${round_year}&round_number=eq.${round_number}&match_type=eq.normal&order=match_number&select=*`);
    if (!matches || matches.length === 0) return res.json({ error: 'No matches found' });
    const matchIds = matches.map(m => m.id);
    const predictions = await supabaseGet('predictions', `match_id=in.(${matchIds.join(',')})&select=*`);
    const sources = ['windrawwin', 'predictz', 'fpai', 'vitibet'];
    const yieldData = {};
    for (const source of sources) {
      let totalBet = 0, totalReturn = 0, matchCount = 0;
      for (const match of matches) {
        const pred = predictions?.find(p => p.match_id === match.id && p.source === source);
        if (!pred || !pred.predicted_result || !match.actual_result) continue;
        matchCount++;
        const domesticOdds = pred.predicted_result === '승' ? match.odds_home : pred.predicted_result === '무' ? match.odds_draw : pred.predicted_result === '패' ? match.odds_away : 0;
        if (domesticOdds) { totalBet += 1; if (pred.predicted_result === match.actual_result) totalReturn += domesticOdds; }
      }
      yieldData[source] = { domestic: totalBet > 0 ? { return: totalReturn.toFixed(2), bet: totalBet, yield_pct: ((totalReturn / totalBet - 1) * 100).toFixed(0) } : null, matchCount };
    }
    res.json({ success: true, round_year, round_number, yield: yieldData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`Proto Scraper Server running on port ${PORT}`);
  setTimeout(async () => { try { await runFullCycle('startup'); } catch (e) { console.error('Auto startup error:', e.message); } }, 10000);

  async function runFullCycle(label) {
    console.log(`=== ${label}: full cycle start ===`);
    try {
      console.log(`${label}: scraping predictions...`);
      await doScrapeAndSave();
      if (global.gc) { global.gc(); console.log('  GC triggered'); }
      console.log(`${label}: fetching match results...`);
      try { await doFetchMatches(); } catch(e) { console.log(`  Result fetch failed: ${e.message}`); }
      if (global.gc) { global.gc(); console.log('  GC triggered'); }
      console.log(`=== ${label}: full cycle complete ===`);
    } catch (e) { console.error(`${label} error:`, e.message); }
  }

  setInterval(() => runFullCycle('Scheduled-3h'), 3 * 60 * 60 * 1000);

  function scheduleSaleTriggers() {
    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const day = kst.getDay();
    const saleDays = [1, 3, 5];
    for (const targetDay of saleDays) {
      let daysUntil = targetDay - day;
      if (daysUntil < 0) daysUntil += 7;
      if (daysUntil === 0) { const targetTime = new Date(kst); targetTime.setHours(14, 5, 0, 0); if (kst >= targetTime) daysUntil = 7; }
      const target = new Date(kst);
      target.setDate(target.getDate() + daysUntil);
      target.setHours(14, 5, 0, 0);
      const targetUTC = new Date(target.getTime() - 9 * 60 * 60 * 1000);
      const msUntil = targetUTC.getTime() - now.getTime();
      if (msUntil > 0 && msUntil < 7 * 24 * 60 * 60 * 1000) {
        const dayNames = ['일','월','화','수','목','금','토'];
        console.log(`  Sale trigger: ${dayNames[targetDay]}요일 14:05 KST (${Math.round(msUntil/60000)}분 후)`);
        setTimeout(() => { runFullCycle(`Sale-${dayNames[targetDay]}`); scheduleSaleTriggers(); }, msUntil);
      }
    }
  }
  scheduleSaleTriggers();
  console.log('Scheduled: 3h regular + Mon/Wed/Fri 14:05 KST sale triggers');
});

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
