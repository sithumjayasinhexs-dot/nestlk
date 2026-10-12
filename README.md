# NestLK 🏠

Student rentals near Sri Lankan university campuses — rooms, annexes & boarding
houses, direct from owners. No brokers.

**Live site:** https://sithumjayasinhexs-dot.github.io/nestlk/
*(enable in repo Settings → Pages → Deploy from branch `main`)*

## What's here

| Path | What |
|---|---|
| `index.html` | The whole app — single file, works offline (map needs internet) |
| `listings.json` | Auto-updated rental feed, merged by the app on every load |
| `scraper/` | Feed pipeline: ikman.lk fetcher + Facebook/manual import tool |
| `.github/workflows/rentals.yml` | Refreshes `listings.json` twice daily (08:00 & 20:00 LK time) |

## Auto-update pipeline

- `scraper/fetch-rentals.js` — headless-browser scrape of ikman.lk room/annex
  search pages → `listings.json` (scheduled via GitHub Actions, no server needed)
- `scraper/import-posts.js` — paste Facebook group posts as text → `listings.json`
- The app fetches `listings.json` on load and merges new entries automatically,
  falling back to built-in samples when offline.
