/**
 * NestLK patpat.lk feed fetcher — pulls public room/annex rental listings from
 * patpat.lk's "Annexes and rooms for rent" category and merges them into
 * listings.json in NestLK format.
 *
 * Run AFTER fetch-rentals.js (both merge into the same scraper/listings.json):
 *   node fetch-rentals.js && node fetch-patpat.js
 *
 * Page structure verified 2026-10-16 via live inspection:
 * - Category: https://patpat.lk/en/sri-lanka/property/annexes-and-rooms/all/rent
 * - Cards are sibling <a href="/en/ad/property/<slug>-<id>"> elements; the info
 *   link carries class "block w-full" and contains h2 (title) + price span
 *   (text like "Rs: 25,000") + date | location spans.
 * - Classic pagination ("Showing 1-20 of N ads"), 20 cards per page.
 *
 * Photos: for every NEW listing the script visits the ad page, grabs up to 3
 * gallery images (cdn.patpat.lk) into ../photos/<id>-<n>.jpg.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CATEGORY = 'https://patpat.lk/en/sri-lanka/property/annexes-and-rooms/all/rent';
const MAX_PAGES = 6; // 20 cards/page — gentle cap

/* city -> university + approx coords (jittered per listing) */
const CITY_MAP = [
  { k: ['moratuwa'], uni: 'University of Moratuwa', lat: 6.773, lng: 79.882 },
  { k: ['colombo'], uni: 'University of Colombo', lat: 6.927, lng: 79.861 },
  { k: ['dehiwala', 'mount lavinia'], uni: '', lat: 6.851, lng: 79.871 },
  { k: ['nugegoda'], uni: 'Univ. of Sri Jayewardenepura', lat: 6.872, lng: 79.890 },
  { k: ['maharagama'], uni: '', lat: 6.845, lng: 79.941 },
  { k: ['kottawa'], uni: '', lat: 6.843, lng: 79.959 },
  { k: ['piliyandala'], uni: '', lat: 6.802, lng: 79.922 },
  { k: ['rajagiriya'], uni: '', lat: 6.909, lng: 79.888 },
  { k: ['battaramulla'], uni: '', lat: 6.904, lng: 79.919 },
  { k: ['malabe'], uni: '', lat: 6.907, lng: 79.952 },
  { k: ['kaduwela'], uni: '', lat: 6.937, lng: 79.983 },
  { k: ['peliyagoda'], uni: '', lat: 6.960, lng: 79.880 },
  { k: ['kelaniya'], uni: 'University of Kelaniya', lat: 6.955, lng: 79.921 },
  { k: ['gampaha'], uni: '', lat: 7.088, lng: 79.994 },
  { k: ['negombo'], uni: '', lat: 7.208, lng: 79.838 },
  { k: ['panadura'], uni: '', lat: 6.713, lng: 79.903 },
  { k: ['kalutara'], uni: '', lat: 6.585, lng: 79.960 },
  { k: ['peradeniya'], uni: 'University of Peradeniya', lat: 7.260, lng: 80.597 },
  { k: ['kandy', 'katugastota'], uni: 'University of Peradeniya', lat: 7.291, lng: 80.637 },
  { k: ['galle'], uni: 'University of Ruhuna', lat: 6.054, lng: 80.221 },
  { k: ['matara'], uni: 'University of Ruhuna', lat: 5.948, lng: 80.535 },
  { k: ['jaffna'], uni: 'University of Jaffna', lat: 9.662, lng: 80.026 },
  { k: ['batticaloa'], uni: 'Eastern University', lat: 7.717, lng: 81.700 },
  { k: ['kuliyapitiya'], uni: 'Wayamba University', lat: 7.468, lng: 80.040 },
  { k: ['kurunegala'], uni: 'Wayamba University', lat: 7.486, lng: 80.365 },
  { k: ['anuradhapura'], uni: 'Rajarata University', lat: 8.312, lng: 80.413 },
  { k: ['trincomalee'], uni: 'Eastern University', lat: 8.587, lng: 81.215 },
];
function mapCity(locText) {
  const t = (locText || '').toLowerCase();
  for (const c of CITY_MAP) if (c.k.some(k => t.includes(k))) return c;
  return { uni: '', lat: 7.873, lng: 80.772 };
}
function guessType(title) {
  const t = title.toLowerCase();
  if (t.includes('annex')) return 'Annex';
  if (t.includes('boarding')) return 'Boarding house';
  if (t.includes('apartment') || t.includes('flat')) return 'Apartment';
  if (t.includes('house')) return 'House';
  if (t.includes('sharing') || t.includes('double')) return 'Double sharing';
  return 'Single room';
}
function guessGender(title) {
  const t = title.toLowerCase();
  if (t.includes('girl') || t.includes('ladies') || t.includes('female')) return 'Girls';
  if (t.includes('boy') || t.includes('gents') || t.includes('male')) return 'Boys';
  return 'Any';
}
const priceNum = s => {
  const m = String(s || '').replace(/,/g, '').match(/(\d[\d]*)/);
  return m ? parseInt(m[1], 10) : 0;
};

const PHOTO_DIR = path.join(__dirname, '..', 'photos');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function dlFile(url, dest) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://patpat.lk/' } }, res => {
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
  const page = await browser.newPage({ userAgent: UA });
  const out = [];
  const seenHref = new Set();

  let pageUrl = CATEGORY;
  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    try {
      console.log(`→ page ${pg}: ${pageUrl}`);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      // info-link cards: a.block.w-full[href*="/en/ad/property/"]
      const cards = await page.$$eval('a[href*="/en/ad/property/"]', els => {
        const out = [];
        for (const a of els) {
          const href = a.getAttribute('href') || '';
          const h2 = a.querySelector('h2');
          if (!h2) continue; // overlay links carry no h2 — only info cards
          const spans = Array.from(a.querySelectorAll('span')).map(s => s.innerText.trim()).filter(Boolean);
          out.push({ title: h2.innerText.trim(), spans, href });
        }
        return out;
      });
      console.log('  info cards found:', cards.length);
      if (!cards.length) break;
      for (const c of cards) {
        const href = c.href.startsWith('http') ? c.href : 'https://patpat.lk' + c.href;
        if (seenHref.has(href)) continue;
        seenHref.add(href);
        const priceSpan = c.spans.find(s => /^Rs:\s*[\d,]+/i.test(s)) || '';
        const price = priceNum(priceSpan);
        if (!price || price > 200000) continue;
        // location = span right after a "|" separator span, else last short span
        let loc = '';
        for (let i = 0; i < c.spans.length; i++) {
          if (c.spans[i] === '|' && c.spans[i + 1]) { loc = c.spans[i + 1]; break; }
        }
        if (!loc) loc = c.spans.filter(s => !/^Rs:/i.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s) && s.length < 40).pop() || '';
        const title = (c.title || 'Room for rent').slice(0, 90);
        const city = mapCity(loc);
        const m = href.match(/-(\d+)\/?$/);
        const id = 'patpat-' + (m ? m[1] : Buffer.from(href).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 12));
        out.push({
          id, title,
          uni: city.uni, city: loc.split(',')[0].trim().slice(0, 40) || 'Sri Lanka',
          price, type: guessType(title), gender: guessGender(title),
          dist: 'see ad', facs: [], phone: null,
          days: 0, featured: false, source: 'patpat.lk', url: href,
          lat: +(city.lat + (Math.random() - 0.5) * 0.02).toFixed(4),
          lng: +(city.lng + (Math.random() - 0.5) * 0.02).toFixed(4),
          desc: 'Imported from patpat.lk — open the original ad for photos, contact and full details.',
        });
      }
      // next page link
      const next = await page.$$eval('a', els => {
        const links = els.map(a => ({ t: (a.innerText || '').trim(), h: a.getAttribute('href') || '' }));
        const nums = links.filter(l => /^\d+$/.test(l.t) && l.h.includes('/property/'));
        return nums.map(l => l.h);
      });
      const nextHrefs = [...new Set(next)];
      const cur = parseInt(new URL(pageUrl).searchParams.get('page') || '1', 10);
      const nxt = nextHrefs.map(h => h.startsWith('http') ? h : 'https://patpat.lk' + h)
        .find(h => parseInt(new URL(h).searchParams.get('page') || '1', 10) === cur + 1);
      if (!nxt) { console.log('  no further pages'); break; }
      pageUrl = nxt;
      await new Promise(r => setTimeout(r, 1200));
    } catch (e) { console.log('  !! failed:', String(e.message || e).split('\n')[0]); break; }
  }

  // merge with existing listings.json, dedupe by id
  const fp = path.join(__dirname, 'listings.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {}
  const have = new Set(existing.map(l => l.id));
  const fresh = out.filter(l => !have.has(l.id));

  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  for (const l of fresh) {
    l.photos = await fetchPhotos(browser, l.url, l.id);
    l.desc = l.photos.length
      ? 'Imported from patpat.lk — photos shown; open the original ad for contact and full details.'
      : 'Imported from patpat.lk — open the original ad for photos, contact and full details.';
    await new Promise(r => setTimeout(r, 800));
  }
  await browser.close();

  const merged = [...fresh, ...existing].slice(0, 400);
  fs.writeFileSync(fp, JSON.stringify(merged, null, 1));

  try {
    const keep = new Set(merged.map(l => l.id));
    for (const f of fs.readdirSync(PHOTO_DIR)) {
      const m = f.match(/^(.+)-[0-9]+\.jpg$/);
      if (m && !keep.has(m[1])) fs.unlinkSync(path.join(PHOTO_DIR, f));
    }
  } catch (e) {}
  console.log(`done: ${fresh.length} new, ${merged.length} total → listings.json`);
})();
