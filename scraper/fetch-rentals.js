/**
 * NestLK rental feed fetcher — pulls public room/annex listings from ikman.lk
 * and writes them in NestLK format (listings.json) for the web app to auto-load.
 *
 * Run:  npm install && npx playwright install chromium && node fetch-rentals.js
 * The site is client-rendered, so a headless browser is required (no login needed).
 *
 * Photos: for every NEW listing the script visits the ad page, grabs up to 3
 * gallery images and stores them under ../photos/<id>-<n>.jpg (repo root photos/
 * when run from scraper/). listings.json references them as "photos":
 * ["photos/<id>-1.jpg", ...]. The web app renders them; listings without photos
 * keep the gradient placeholder. Old photos whose listings aged out are pruned.
 *
 * Schedule it (example cron, twice daily):
 *   0 7,19 * * * cd /path/to/scraper && node fetch-rentals.js >> fetch.log 2>&1
 * Then copy listings.json next to the hosted nestlk.html (or push via the
 * GitHub Actions example in README.md). The app merges new entries automatically.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SEARCHES = [
  // verified 2026-10-12 via live page inspection:
  // cards are a[data-testid="ad-card-link"], title in h2, price in [class*="price--"],
  // location in [class*="description--"]. (Category URLs like /en/ads/colombo/...
  // return 404 — the ?query= search URL is the working entry point.)
  { url: 'https://ikman.lk/en/ads?query=room%20annex%20for%20rent', area: 'Sri Lanka' },
  { url: 'https://ikman.lk/en/ads?query=boarding%20room%20rent', area: 'Sri Lanka' },
];

/* city -> university + approx coords (jittered per listing) */
const CITY_MAP = [
  { k: ['moratuwa'], uni: 'University of Moratuwa', lat: 6.773, lng: 79.882 },
  { k: ['kollupitiya', 'colombo 03', 'colpetty'], uni: 'University of Colombo', lat: 6.915, lng: 79.856 },
  { k: ['bambalapitiya'], uni: 'University of Colombo', lat: 6.891, lng: 79.857 },
  { k: ['colombo 07', 'cinnamon gardens'], uni: 'University of Colombo', lat: 6.904, lng: 79.861 },
  { k: ['peradeniya'], uni: 'University of Peradeniya', lat: 7.260, lng: 80.597 },
  { k: ['kandy'], uni: 'University of Peradeniya', lat: 7.291, lng: 80.637 },
  { k: ['nugegoda'], uni: 'Univ. of Sri Jayewardenepura', lat: 6.872, lng: 79.890 },
  { k: ['kelaniya'], uni: 'University of Kelaniya', lat: 6.955, lng: 79.921 },
  { k: ['jaffna'], uni: 'University of Jaffna', lat: 9.662, lng: 80.026 },
  { k: ['galle'], uni: 'University of Ruhuna', lat: 6.054, lng: 80.221 },
  { k: ['kuliyapitiya'], uni: 'Wayamba University', lat: 7.468, lng: 80.040 },
];
function mapCity(locText) {
  const t = (locText || '').toLowerCase();
  for (const c of CITY_MAP) if (c.k.some(k => t.includes(k))) return c;
  return { uni: '', lat: 7.873, lng: 80.772 }; // fallback: island centre
}
function guessType(title) {
  const t = title.toLowerCase();
  if (t.includes('annex')) return 'Annex';
  if (t.includes('boarding')) return 'Boarding house';
  if (t.includes('sharing') || t.includes('double')) return 'Double sharing';
  return 'Single room';
}
function guessGender(title) {
  const t = title.toLowerCase();
  if (t.includes('girls') || t.includes('ladies') || t.includes('female')) return 'Girls';
  if (t.includes('boys') || t.includes('gents') || t.includes('male')) return 'Boys';
  return 'Any';
}
const priceNum = s => {
  const m = String(s || '').replace(/,/g, '').match(/(\d[\d]*)/);
  return m ? parseInt(m[1], 10) : 0;
};

/* ---------- photo helpers (same idea as UniPulse posters) ---------- */
const PHOTO_DIR = path.join(__dirname, '..', 'photos');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function dlFile(url, dest) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://ikman.lk/' } }, res => {
      const ct = res.headers['content-type'] || '';
      if (res.statusCode !== 200 || !ct.startsWith('image')) { res.resume(); return resolve(false); }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); try { resolve(fs.statSync(dest).size > 2000); } catch (e) { resolve(false); } });
      ws.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(25000, () => { req.destroy(); resolve(false); });
  });
}

async function fetchPhotos(browser, adUrl, id) {
  const photos = [];
  let ap = null;
  try {
    ap = await browser.newPage({ userAgent: UA });
    await ap.goto(adUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await ap.waitForTimeout(2500);
    const imgs = await ap.$$eval('img', els =>
      els.map(i => i.currentSrc || i.src).filter(Boolean)
    );
    const seenU = new Set(), cands = [];
    for (const u of imgs) {
      if (!u.startsWith('http') || seenU.has(u)) continue;
      seenU.add(u);
      const low = u.toLowerCase();
      if (u.startsWith('data:') || low.endsWith('.svg') || low.includes('logo')
        || low.includes('sprite') || low.includes('icon') || low.includes('avatar')
        || low.includes('placeholder') || low.includes('banner')) continue;
      cands.push(u);
    }
    console.log(`  gallery imgs: ${cands.length} @ ${id}`);
    for (let n = 0; n < Math.min(3, cands.length); n++) {
      const dest = path.join(PHOTO_DIR, `${id}-${n + 1}.jpg`);
      if (await dlFile(cands[n], dest)) photos.push(`photos/${id}-${n + 1}.jpg`);
      else { try { fs.unlinkSync(dest); } catch (e) {} }
    }
  } catch (e) {
    console.log('  photo fail', id, '-', String(e.message || e).split('\n')[0]);
  }
  if (ap) await ap.close().catch(() => {});
  return photos;
}

(async () => {
  // respect proxy env (e.g. sandboxed CI runners) — curl reads it automatically,
  // Chromium needs it passed explicitly
  let proxy;
  const pe = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (pe) {
    try {
      const u = new URL(pe);
      proxy = { server: `${u.protocol}//${u.host}` };
      if (u.username) { proxy.username = decodeURIComponent(u.username); proxy.password = decodeURIComponent(u.password); }
    } catch (e) {}
  }
  const browser = await chromium.launch({ headless: true, ...(proxy ? { proxy } : {}) });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  });
  const out = [];
  for (const s of SEARCHES) {
    try {
      console.log('→', s.url);
      await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // verified selector 2026-10-12: a[data-testid="ad-card-link"]
      await page.waitForSelector('a[data-testid="ad-card-link"]', { timeout: 20000 }).catch(() => {});
      const cards = await page.$$eval('a[data-testid="ad-card-link"]', els =>
        els.map(a => {
          const q = sel => { const el = a.querySelector(sel); return el ? el.innerText.trim() : ''; };
          return {
            title: q('h2'),
            price: q('[class*="price--"]'),
            loc: q('[class*="description--"]'),
            href: a.getAttribute('href') || '',
            img: (a.querySelector('img') || {}).getAttribute
              ? a.querySelector('img').getAttribute('src') : null,
          };
        })
      );
      console.log('  cards found:', cards.length);
      const seen = new Set(); // promoted ads render twice — dedupe by href
      for (const c of cards) {
        if (!c.href || seen.has(c.href)) continue;
        seen.add(c.href);
        const title = (c.title || 'Room for rent').slice(0, 90);
        const price = priceNum(c.price);
        if (!price || price > 200000) continue; // skip sales / junk
        const city = mapCity(c.loc || s.area);
        const id = 'ikman-' + Buffer.from(c.href).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 12);
        out.push({
          id, title,
          uni: city.uni, city: (c.loc || s.area).split(',')[0].trim().slice(0, 40),
          price, type: guessType(title), gender: guessGender(title),
          dist: 'see ad', facs: [], phone: null,
          days: 0, featured: false, source: 'ikman.lk',
          url: c.href.startsWith('http') ? c.href : 'https://ikman.lk' + c.href,
          lat: +(city.lat + (Math.random() - 0.5) * 0.02).toFixed(4),
          lng: +(city.lng + (Math.random() - 0.5) * 0.02).toFixed(4),
          desc: 'Imported from ikman.lk — open the original ad for photos, contact and full details.',
        });
      }
    } catch (e) { console.log('  !! failed:', e.message.split('\n')[0]); }
  }
  // merge with existing listings.json, dedupe by id
  const fp = path.join(__dirname, 'listings.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {}
  const have = new Set(existing.map(l => l.id));
  const fresh = out.filter(l => !have.has(l.id));

  // real photos for new listings only (existing ones keep theirs)
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  for (const l of fresh) {
    l.photos = await fetchPhotos(browser, l.url, l.id);
    l.desc = l.photos.length
      ? 'Imported from ikman.lk — photos shown; open the original ad for contact and full details.'
      : 'Imported from ikman.lk — open the original ad for photos, contact and full details.';
    await new Promise(r => setTimeout(r, 600)); // be gentle with ikman
  }
  await browser.close();

  const merged = [...fresh, ...existing].slice(0, 400); // cap file size
  fs.writeFileSync(fp, JSON.stringify(merged, null, 1));

  // prune photos whose listings aged out (bounds repo storage)
  try {
    const keep = new Set(merged.map(l => l.id));
    for (const f of fs.readdirSync(PHOTO_DIR)) {
      const m = f.match(/^(.+)-[0-9]+\.jpg$/);
      if (m && !keep.has(m[1])) fs.unlinkSync(path.join(PHOTO_DIR, f));
    }
  } catch (e) {}
  console.log(`done: ${fresh.length} new, ${merged.length} total → listings.json`);
})();
