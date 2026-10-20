// Downloads HDB resale transactions and amenity datasets from data.gov.sg,
// aggregates them per town, and writes compact JSON files for the static site.
//
// Usage: node scripts/build-data.mjs
// Optional env: DATA_GOV_SG_API_KEY (raises data.gov.sg rate limits)

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "site", "data");
const CACHE_DIR = path.join(ROOT, ".cache");

const DATASETS = {
  resale2015: "d_ea9ed51da2787afaf8e51f827c304208", // Jan 2015 - Dec 2016
  resale2017: "d_8b84c4ee58e3cfc0ece0d773c8ca6abc", // Jan 2017 onwards
  hdbProperty: "d_17f5382f26140b1fdae0ba2ef6239d2f", // block info, dwelling units per town
  schools: "d_688b934f82c1059ed0a6993d2a829089", // MOE general information of schools
  mrtExits: "d_b39d3a0871985372d7e1637193335da5", // LTA MRT station exits (GeoJSON)
  chasClinics: "d_548c33ea2d99e29ec63a7cc9edcccedc", // CHAS clinics (GeoJSON)
  planningAreas: "d_4765db0e87b9c86336792efe8a1f7a66", // URA Master Plan 2019 planning areas
};

const YEARS_OF_HISTORY = 10;
const FLAT_TYPES = ["2 ROOM", "3 ROOM", "4 ROOM", "5 ROOM", "EXECUTIVE"];
const PRICE_BIN = 50_000; // budget histogram bin size (SGD)

// HDB town -> URA planning area(s), used to place MRT stations and clinics in a town.
const TOWN_PLANNING_AREAS = {
  "CENTRAL AREA": ["DOWNTOWN CORE", "OUTRAM", "ROCHOR", "SINGAPORE RIVER", "MUSEUM"],
  "KALLANG/WHAMPOA": ["KALLANG", "NOVENA"],
};
// HDB town -> MOE "dgp_code" values (schools dataset).
const TOWN_SCHOOL_AREAS = {
  "CENTRAL AREA": ["CENTRAL"],
  "KALLANG/WHAMPOA": ["KALLANG", "NOVENA"],
  SENGKANG: ["SENG KANG"],
};
// HDB property dataset uses short town codes.
const TOWN_CODES = {
  AMK: "ANG MO KIO", BB: "BUKIT BATOK", BD: "BEDOK", BH: "BISHAN", BM: "BUKIT MERAH",
  BP: "BUKIT PANJANG", BT: "BUKIT TIMAH", CCK: "CHOA CHU KANG", CL: "CLEMENTI",
  CT: "CENTRAL AREA", GL: "GEYLANG", HG: "HOUGANG", JE: "JURONG EAST", JW: "JURONG WEST",
  KWN: "KALLANG/WHAMPOA", MP: "MARINE PARADE", PG: "PUNGGOL", PRC: "PASIR RIS",
  QT: "QUEENSTOWN", SB: "SEMBAWANG", SGN: "SERANGOON", SK: "SENGKANG", TAP: "TAMPINES",
  TG: "TENGAH", TP: "TOA PAYOH", WL: "WOODLANDS", YS: "YISHUN",
};

// ---------- download helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = process.env.DATA_GOV_SG_API_KEY ? { "x-api-key": process.env.DATA_GOV_SG_API_KEY } : {};

async function getJson(url, attempt = 0) {
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => null);
  if (res.status === 429 || body?.code === 24) {
    if (attempt > 12) throw new Error(`Rate limited too many times: ${url}`);
    await sleep(11_000);
    return getJson(url, attempt + 1);
  }
  if (!res.ok || !body) throw new Error(`HTTP ${res.status} for ${url}`);
  return body;
}

// Bulk-download a whole dataset file via the data.gov.sg download API (cached per run).
async function downloadDataset(id) {
  const cached = path.join(CACHE_DIR, id);
  if (process.env.USE_CACHE && existsSync(cached)) return readFile(cached, "utf8");

  const base = `https://api-open.data.gov.sg/v1/public/api/datasets/${id}`;
  let url = (await getJson(`${base}/initiate-download`)).data?.url;
  for (let i = 0; !url && i < 30; i++) {
    await sleep(3000);
    url = (await getJson(`${base}/poll-download`)).data?.url;
  }
  if (!url) throw new Error(`Download URL never became ready for ${id}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${id}`);
  const text = await res.text();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cached, text);
  console.log(`  downloaded ${id} (${(text.length / 1e6).toFixed(1)} MB)`);
  return text;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

// ---------- geometry ----------

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeometry(pt, geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  return polys.some(([outer, ...holes]) => pointInRing(pt, outer) && !holes.some((h) => pointInRing(pt, h)));
}

// ---------- main ----------

async function main() {
  console.log("Downloading datasets from data.gov.sg ...");
  const resaleRows = [];
  for (const key of ["resale2015", "resale2017"]) {
    for (const r of parseCsv(await downloadDataset(DATASETS[key]))) resaleRows.push(r);
  }
  const property = parseCsv(await downloadDataset(DATASETS.hdbProperty));
  const schools = parseCsv(await downloadDataset(DATASETS.schools));
  const mrt = JSON.parse(await downloadDataset(DATASETS.mrtExits));
  const clinics = JSON.parse(await downloadDataset(DATASETS.chasClinics));
  const areas = JSON.parse(await downloadDataset(DATASETS.planningAreas));

  // ----- resale aggregation -----
  const latestMonth = resaleRows.reduce((m, r) => (r.month > m ? r.month : m), "");
  const [ly, lm] = latestMonth.split("-").map(Number);
  // "Periods" are rolling 12-month windows ending at the latest month; period 0 is the most recent.
  const periodOf = (month) => {
    const [y, m] = month.split("-").map(Number);
    return Math.floor((ly * 12 + lm - (y * 12 + m)) / 12);
  };
  const periodLabels = Array.from({ length: YEARS_OF_HISTORY + 1 }, (_, p) => {
    const endIdx = ly * 12 + lm - 1 - p * 12;
    const fmt = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
    return { from: fmt(endIdx - 11), to: fmt(endIdx) };
  }).reverse(); // oldest first

  // agg[town][type][remainingLeaseYears][periodIdxOldestFirst] = [count, sumPricePerSqm, sumPrice, sumSqm]
  // budget[town][type][remainingLeaseYears] = { bin: count } for the most recent 12 months
  const agg = {}, budget = {};
  let used = 0;
  for (const r of resaleRows) {
    if (!FLAT_TYPES.includes(r.flat_type)) continue;
    const p = periodOf(r.month);
    if (p > YEARS_OF_HISTORY) continue;
    const price = Number(r.resale_price), sqm = Number(r.floor_area_sqm);
    const saleYear = Number(r.month.slice(0, 4));
    const lease = Number(r.lease_commence_date) + 99 - saleYear;
    if (!price || !sqm || !lease) continue;
    const idx = YEARS_OF_HISTORY - p;
    const cell = (((agg[r.town] ??= {})[r.flat_type] ??= {})[lease] ??= Array.from({ length: YEARS_OF_HISTORY + 1 }, () => [0, 0, 0, 0]))[idx];
    cell[0]++; cell[1] += price / sqm; cell[2] += price; cell[3] += sqm;
    if (p === 0) {
      const b = (((budget[r.town] ??= {})[r.flat_type] ??= {})[lease] ??= {});
      const bin = Math.floor(price / PRICE_BIN);
      b[bin] = (b[bin] || 0) + 1;
    }
    used++;
  }
  // Round sums so the JSON stays small; drop empty periods to sparse form [idx, count, avgPsm*count, ...].
  for (const town of Object.values(agg))
    for (const type of Object.values(town))
      for (const [lease, periods] of Object.entries(type))
        type[lease] = periods.flatMap((c, i) => (c[0] ? [i, c[0], Math.round(c[1]), Math.round(c[2]), Math.round(c[3])] : []));

  // ----- amenities per town -----
  const towns = Object.keys(agg).sort();
  const dwellings = {};
  for (const b of property) {
    const town = TOWN_CODES[b.bldg_contract_town];
    if (town && b.residential === "Y") dwellings[town] = (dwellings[town] || 0) + Number(b.total_dwelling_units || 0);
  }
  const unknownCodes = [...new Set(property.map((b) => b.bldg_contract_town))].filter((c) => !TOWN_CODES[c]);
  if (unknownCodes.length) console.warn("  unmapped HDB town codes:", unknownCodes.join(", "));

  const areaByName = Object.fromEntries(areas.features.map((f) => [f.properties.PLN_AREA_N, f.geometry]));
  const townGeoms = Object.fromEntries(
    towns.map((t) => [t, (TOWN_PLANNING_AREAS[t] ?? [t]).map((a) => areaByName[a]).filter(Boolean)])
  );
  for (const t of towns) if (!townGeoms[t].length) console.warn(`  no planning area boundary for ${t}`);
  const townOfPoint = (pt) => towns.find((t) => townGeoms[t].some((g) => pointInGeometry(pt, g)));

  // MRT/LRT: average exit locations into one point per station.
  const stations = {};
  for (const f of mrt.features) {
    const s = (stations[f.properties.STATION_NA] ??= { x: 0, y: 0, n: 0 });
    s.x += f.geometry.coordinates[0]; s.y += f.geometry.coordinates[1]; s.n++;
  }
  const mrtByTown = {};
  for (const [name, s] of Object.entries(stations)) {
    const t = townOfPoint([s.x / s.n, s.y / s.n]);
    if (t) (mrtByTown[t] ??= []).push(name.replace(/ (MRT|LRT) STATION$/, "").replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()));
  }
  const clinicsByTown = {};
  for (const f of clinics.features) {
    const t = townOfPoint(f.geometry.coordinates.slice(0, 2));
    if (t) clinicsByTown[t] = (clinicsByTown[t] || 0) + 1;
  }
  const primaryByTown = {};
  for (const s of schools) {
    if (!/PRIMARY|P1-S4/.test(s.mainlevel_code)) continue;
    const t = towns.find((t) => (TOWN_SCHOOL_AREAS[t] ?? [t]).includes(s.dgp_code));
    if (t) primaryByTown[t] = (primaryByTown[t] || 0) + 1;
  }

  const townInfo = Object.fromEntries(
    towns.map((t) => [t, {
      dwellings: dwellings[t] || 0,
      mrtStations: [...new Set(mrtByTown[t] || [])].sort(),
      primarySchools: primaryByTown[t] || 0,
      clinics: clinicsByTown[t] || 0,
    }])
  );

  await mkdir(OUT_DIR, { recursive: true });
  const meta = {
    generatedAt: new Date().toISOString(),
    latestMonth,
    periods: periodLabels,
    priceBin: PRICE_BIN,
    flatTypes: FLAT_TYPES,
    transactions: used,
    sources: Object.fromEntries(Object.entries(DATASETS).map(([k, id]) => [k, `https://data.gov.sg/datasets/${id}/view`])),
  };
  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 1));
  await writeFile(path.join(OUT_DIR, "towns.json"), JSON.stringify(townInfo, null, 1));
  await writeFile(path.join(OUT_DIR, "sales.json"), JSON.stringify({ agg, budget }));
  console.log(`Done: ${used} transactions across ${towns.length} towns, latest month ${latestMonth}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
