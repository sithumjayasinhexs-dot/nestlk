# NestLK auto-update pipeline

The web app (`nestlk.html`) automatically merges **`listings.json`** when it loads
(it fetches it, falls back to built-in samples when offline). These scripts
produce that file.

## 1. Rental websites — automatic

`fetch-rentals.js` opens ikman.lk's public room/annex search pages in a headless
browser and extracts listings. No login needed.

```bash
cd scraper
npm install
npx playwright install chromium
node fetch-rentals.js        # writes/updates listings.json
```

**Schedule it** — e.g. twice a day with cron:

```
0 7,19 * * * cd /path/to/scraper && node fetch-rentals.js >> fetch.log 2>&1 && cp listings.json /var/www/nestlk/
```

**Or GitHub Actions** (runs in the cloud, pushes to your Pages site):

```yaml
# .github/workflows/rentals.yml
on:
  schedule: [{cron: "0 2 * * *"}, {cron: "0 14 * * *"}]  # 7:30 & 19:30 LK time
  workflow_dispatch:
jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: {node-version: 20}
      - run: npm install && npx playwright install --with-deps chromium
        working-directory: scraper
      - run: node fetch-rentals.js
        working-directory: scraper
      - run: cp scraper/listings.json ./listings.json   # next to hosted nestlk.html
      - uses: stefanzweifel/git-auto-commit-action@v5
        with: {commit_message: "rentals refresh", file_pattern: "listings.json"}
```

**Notes & limits**
- Selectors were verified on 2026-10-12. If the site redesigns, re-check the
  `waitForSelector('a[href*="/ad/"]')` line.
- ikman hides phone numbers behind a click; imported listings link back to the
  original ad for contact/photos. Keep the `url` field so users can tap through.
- Be polite: the default 4 city searches, twice a day, is light traffic.
- Same pattern works for patpat.lk / lankapropertyweb.com — add their search
  URLs to `SEARCHES` and adjust the card extraction.

## 2. Facebook groups — semi-automatic (import tool)

Facebook blocks bots (login wall, aggressive detection, ToS). Auto-scraping
groups is not feasible. The supported workflow:

1. Open the group (e.g. "Rooms & Annexes for Rent – Moratuwa"), copy the post text.
2. Paste into `posts.txt` in the block format shown at the top of `import-posts.js`.
3. Run `node import-posts.js posts.txt` → entries appended to `listings.json`.
4. Publish `listings.json` next to the hosted app.

Tip: group admins can skip all this — the **Post ad** tab in the app publishes
directly (stored per-device now; a real backend would share them).

## 3. What the app does

- On load: `fetch('listings.json')` → merges entries with new ids → toast "N new listings loaded".
- Pins with lat/lng appear on the **Map** tab; entries without coords still show in list/search.
- Built-in sample listings always remain as fallback (offline / `file://` use).
