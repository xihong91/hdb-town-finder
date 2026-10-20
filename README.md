# HDB Town Finder

A static web app that ranks Singapore HDB towns for a buyer's age, life stage, flat type and budget, and recommends the top 3 towns to buy in.

**Inputs:** your age, co-buyer's age (optional), life stage, flat type, holding period (5–20 years), and either a budget or your finances (monthly income, CPF OA and cash).

- **Estimated return (70%)**: yearly price-per-sqm trend (last 5 years for a 5-year hold, otherwise 10 years) minus the value lost as the lease runs down while you hold the flat. The lease effect is estimated from recent sales by comparing flats with different leases within each town.
- **Liquidity (30%)**: matching resale transactions per year over the last 3 years.
- **Amenities (±15 points)**: MRT/LRT stations, primary schools and CHAS clinics per 10,000 HDB homes, weighted by life stage.
- **Flat age**: only flats whose remaining lease lasts until the youngest buyer is 95 are counted (the CPF full-usage rule).
- **Budget from finances**: max loan at a 30% Mortgage Servicing Ratio and 75% loan-to-value, repaid by age 65. Uses an HDB loan (2.6%) if income is $14k or less, otherwise a bank loan tested at 4%. Stamp duty and fees are taken off; grants are not included.
- **Within budget**: share of recent matching sales at or below the budget; towns under 25% are left out of the top picks.

Not financial advice: rankings are based on past transactions only.

## How it works

```
data.gov.sg ──► scripts/build-data.mjs ──► site/data/*.json ──► site/ (HTML + JS + Chart.js)
```

A GitHub Action runs every night at 02:00 SGT. It downloads the latest data, rebuilds `site/data/`, and deploys `site/` to GitHub Pages. No server or database is needed.

Data sources (all on data.gov.sg): HDB resale flat prices (2015–2016 and 2017 onwards), HDB property information, MOE general information of schools, LTA MRT station exits, MOH CHAS clinics, URA Master Plan 2019 planning area boundaries.

## Run locally

Requires Node.js 20 or later.

```bash
npm run build-data
npm run serve
```

Then open http://localhost:8080. Set `USE_CACHE=1` to reuse downloaded files in `.cache/` when rebuilding.

## Deploy to GitHub Pages

1. Create a new GitHub repository and push this folder to its `main` branch.
2. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow runs on every push and nightly. To run it now, open **Actions → Refresh data and deploy → Run workflow**.
4. Optional: add a free data.gov.sg API key as a repository secret named `DATA_GOV_SG_API_KEY` to avoid rate limits.

## Tuning

Scoring settings are at the top of `site/app.js` (`WEIGHTS`, `AMENITY_POINTS`, `LIFE_STAGES`, `MIN_BUDGET_SHARE`). Town-to-planning-area mappings are at the top of `scripts/build-data.mjs`.

## Known limitations

- Amenities are counted by URA planning area, which only roughly matches HDB town boundaries.
- Averages per sqm can shift when a town's mix of flats changes (e.g. many new flats reaching their MOP).
- BTO prices are not included because there is no public API for them.
