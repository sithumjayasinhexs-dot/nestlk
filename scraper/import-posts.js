/**
 * NestLK manual import — for Facebook group posts & any text ads.
 *
 * Facebook groups block automated scraping (login wall + bot detection), so the
 * realistic workflow is: copy posts from the group, paste them into posts.txt
 * using the format below, then run:
 *
 *   node import-posts.js posts.txt
 *
 * New entries are appended to listings.json (deduped). Then publish
 * listings.json next to the hosted nestlk.html — the app picks it up automatically.
 *
 * ---- posts.txt format (blocks separated by ---) ----
 * Title: Single room near Moratuwa campus
 * Price: 22000
 * City: Moratuwa
 * University: University of Moratuwa
 * Type: Single room
 * For: Boys
 * Phone: 0771234567
 * Distance: 5 min walk
 * Facilities: WiFi, Meals, Attached bathroom
 * Details: Quiet room, meals included, 5 min to main gate.
 * ---
 * Title: ...
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('usage: node import-posts.js posts.txt'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');

const blocks = raw.split(/^---\s*$/m).map(b => b.trim()).filter(Boolean);
const CITY_COORDS = {
  moratuwa: [6.773, 79.882], colombo: [6.927, 79.861], peradeniya: [7.260, 80.597],
  kandy: [7.291, 80.637], nugegoda: [6.872, 79.890], kelaniya: [6.955, 79.921],
  jaffna: [9.662, 80.026], galle: [6.054, 80.221], kuliyapitiya: [7.468, 80.040],
};
function coordsFor(city) {
  const t = (city || '').toLowerCase();
  for (const k of Object.keys(CITY_COORDS))
    if (t.includes(k)) { const c = CITY_COORDS[k]; return [+(c[0] + (Math.random() - .5) * .02).toFixed(4), +(c[1] + (Math.random() - .5) * .02).toFixed(4)]; }
  return [7.8731, 80.7718];
}

const made = [];
for (const b of blocks) {
  const kv = {};
  for (const line of b.split('\n')) {
    const m = line.match(/^([A-Za-z ]+):\s*(.*)$/);
    if (m) kv[m[1].trim().toLowerCase()] = m[2].trim();
  }
  if (!kv.title) { console.log('  skipped block (no Title)'); continue; }
  const digits = (kv.phone || '').replace(/\D/g, '').replace(/^94/, '').replace(/^0/, '');
  const [lat, lng] = coordsFor(kv.city);
  made.push({
    id: 'manual-' + Buffer.from(kv.title + (kv.phone || '')).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 10),
    title: kv.title.slice(0, 90),
    uni: kv.university || '', city: kv.city || '', price: parseInt(kv.price, 10) || 0,
    type: kv.type || 'Single room', gender: kv.for || 'Any',
    dist: kv.distance || 'near campus',
    facs: (kv.facilities || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8),
    phone: digits ? '94' + digits : null, days: 0, featured: false, source: 'manual',
    lat, lng, desc: kv.details || 'Contact the owner for more details.',
  });
}

const fp = path.join(__dirname, 'listings.json');
let existing = [];
try { existing = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {}
const have = new Set(existing.map(l => l.id));
const fresh = made.filter(l => !have.has(l.id) && l.price > 0);
fs.writeFileSync(fp, JSON.stringify([...fresh, ...existing].slice(0, 400), null, 1));
console.log(`imported ${fresh.length} new (${made.length} parsed) → listings.json`);
