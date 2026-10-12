/**
 * NestLK rental feed fetcher — pulls public room/annex listings from ikman.lk
 * and writes them in NestLK format (listings.json) for the web app to auto-load.
 *
 * Run:  npm install && npx playwright install chromium && node fetch-rentals.js
 * The site is client-rendered, so a headless browser is required (no login needed).
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
  await browser.close();

  // merge with existing listings.json, dedupe by id
  const fp = path.join(__dirname, 'listings.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {}
  const have = new Set(existing.map(l => l.id));
  const fresh = out.filter(l => !have.has(l.id));
  const merged = [...fresh, ...existing].slice(0, 400); // cap file size
  fs.writeFileSync(fp, JSON.stringify(merged, null, 1));
  console.log(`done: ${fresh.length} new, ${merged.length} total → listings.json`);
})();
