// HDB Town Finder: ranks towns using pre-aggregated data built by scripts/build-data.mjs.

const WEIGHTS = { growth: 0.7, liquidity: 0.3 };
const AMENITY_POINTS = 15; // max +/- points the amenity score can move a town
const MIN_RECENT_SALES = 5;
const MIN_BUDGET_SHARE = 0.25;
const LIFE_STAGES = {
  couple: { label: "young couples", flatType: "4 ROOM", amenity: { mrt: 0.7, schools: 0.2, clinics: 0.1 } },
  family: { label: "families", flatType: "5 ROOM", amenity: { mrt: 0.4, schools: 0.5, clinics: 0.1 } },
  retiree: { label: "retirees", flatType: "3 ROOM", amenity: { mrt: 0.4, schools: 0, clinics: 0.6 } },
};
// Loan assumptions used to turn finances into a budget.
const LOAN = {
  hdbIncomeCeiling: 14_000,
  hdb: { rate: 0.026, maxTenure: 25, label: "HDB loan" },
  bank: { rate: 0.04, maxTenure: 30, label: "bank loan", minCashShare: 0.05 }, // 4% = MAS stress-test floor
  msr: 0.3, // Mortgage Servicing Ratio
  ltv: 0.75,
  repayByAge: 65,
  fees: 3_000, // legal and other fees, roughly
};

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => "$" + Math.round(n).toLocaleString("en-SG");
const fmtK = (n) => "$" + Math.round(n / 1000).toLocaleString("en-SG") + "k";
const fmtPct = (n, d = 1) => {
  const s = (n * 100).toFixed(d);
  return (Number(s) > 0 ? "+" : "") + (Number(s) === 0 ? (0).toFixed(d) : s) + "%";
};
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace("/w", "/W");
const num = (id) => (($(id).value ?? "") === "" ? null : Number($(id).value));

let meta, towns, sales, chart, selectedTown;

async function init() {
  [meta, towns, sales] = await Promise.all(
    ["meta", "towns", "sales"].map((f) => fetch(`data/${f}.json`).then((r) => r.json()))
  );
  $("flatType").innerHTML = meta.flatTypes.map((t) => `<option>${t}</option>`).join("");
  $("flatType").value = LIFE_STAGES.couple.flatType;
  $("stage").addEventListener("change", () => {
    $("flatType").value = LIFE_STAGES[$("stage").value].flatType;
    render();
  });
  $("form").addEventListener("input", render);
  $("form").addEventListener("submit", (e) => e.preventDefault());
  const updated = new Date(meta.generatedAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });
  $("meta").textContent = `Data: ${meta.transactions.toLocaleString()} resale transactions up to ${meta.latestMonth}, refreshed ${updated}. Source: data.gov.sg (HDB, MOE, LTA, MOH, URA).`;
  render();
}

function readInput() {
  const age = num("age") || 32;
  const coAge = num("coAge");
  const mode = document.querySelector('input[name="budgetMode"]:checked').value;
  $("financeInputs").hidden = mode !== "finances";
  $("manualInputs").hidden = mode !== "manual";
  const input = {
    age,
    youngest: coAge ? Math.min(age, coAge) : age,
    avgAge: coAge ? (age + coAge) / 2 : age,
    stage: $("stage").value,
    type: $("flatType").value,
    hold: Number($("hold").value),
    mode,
  };
  if (mode === "finances") {
    input.finance = financeBudget({ age: input.avgAge, income: num("income") || 0, cpf: num("cpf") || 0, cash: num("cash") || 0 });
    input.budget = input.finance.budget;
  } else {
    input.budget = num("budget") || 0;
  }
  return input;
}

const requiredLease = (youngestAge) => Math.max(20, 95 - youngestAge);

// ---------- budget from finances ----------

function stampDuty(p) {
  const bands = [[180_000, 0.01], [180_000, 0.02], [640_000, 0.03], [500_000, 0.04], [1_500_000, 0.05], [Infinity, 0.06]];
  let duty = 0, rest = p;
  for (const [size, rate] of bands) { const part = Math.min(rest, size); duty += part * rate; rest -= part; if (rest <= 0) break; }
  return duty;
}

function financeBudget({ age, income, cpf, cash }) {
  const useHdb = income <= LOAN.hdbIncomeCeiling;
  const loanType = useHdb ? LOAN.hdb : LOAN.bank;
  const tenure = Math.min(loanType.maxTenure, Math.floor(LOAN.repayByAge - age));
  const monthly = LOAN.msr * income;
  const r = loanType.rate / 12, n = tenure * 12;
  const maxLoan = tenure >= 5 && income > 0 ? (monthly * (1 - (1 + r) ** -n)) / r : 0;

  const funds = cpf + cash;
  const feasible = (p) => {
    const loan = Math.min(maxLoan, LOAN.ltv * p);
    const needed = p - loan + stampDuty(p) + LOAN.fees;
    const cashOk = useHdb || !loan || cash >= LOAN.bank.minCashShare * p;
    return needed <= funds && cashOk;
  };
  let lo = 0, hi = 5_000_000;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; feasible(mid) ? (lo = mid) : (hi = mid); }
  const budget = Math.floor(lo / 1000) * 1000;
  const loan = Math.min(maxLoan, LOAN.ltv * budget);
  const instalment = loan ? (loan * r) / (1 - (1 + r) ** -n) : 0;
  return { budget, loan, instalment, tenure, loanType, duty: stampDuty(budget), useHdb };
}

// ---------- market data ----------

// Sum all lease-year cells at or above the required lease into one yearly series.
function townSeries(town, type, minLease) {
  const n = meta.periods.length;
  const series = Array.from({ length: n }, () => ({ count: 0, psm: 0, price: 0, sqm: 0, lease: 0 }));
  const cells = sales.agg[town]?.[type] || {};
  for (const [lease, flat] of Object.entries(cells)) {
    if (Number(lease) < minLease) continue;
    for (let i = 0; i < flat.length; i += 5) {
      const s = series[flat[i]];
      s.count += flat[i + 1]; s.psm += flat[i + 2]; s.price += flat[i + 3]; s.sqm += flat[i + 4];
      s.lease += Number(lease) * flat[i + 1];
    }
  }
  return series;
}

function budgetShare(town, type, minLease, budget) {
  const bin = meta.priceBin;
  let total = 0, within = 0;
  for (const [lease, bins] of Object.entries(sales.budget[town]?.[type] || {})) {
    if (Number(lease) < minLease) continue;
    for (const [b, c] of Object.entries(bins)) {
      const lo = Number(b) * bin;
      total += c;
      within += c * Math.min(1, Math.max(0, (budget - lo) / bin));
    }
  }
  return total ? within / total : null;
}

// Annual growth from a log-linear fit of average price per sqm over the last `years` years.
function annualGrowth(series, years) {
  const pts = series
    .map((s, i) => [i, s.count >= 5 ? Math.log(s.psm / s.count) : null])
    .slice(-(years + 1))
    .filter((p) => p[1] !== null);
  if (pts.length < Math.ceil((years + 1) * 0.6)) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return Math.exp(slope) - 1;
}

// How price per sqm changes with remaining lease, estimated from the last 2 years of sales.
// Compares neighbouring 5-year lease bands within the same town, so location differences cancel out.
// Returns logValue(lease): log of relative value, comparable between two leases.
function leaseCurve(type) {
  const BIN = 5, FIRST = 4, LAST = 19; // bands 20-24 ... 95-99
  const last = meta.periods.length - 1;
  const steps = Array.from({ length: LAST }, () => ({ w: 0, d: 0 }));
  for (const town of Object.keys(towns)) {
    const bands = {};
    for (const [lease, flat] of Object.entries(sales.agg[town]?.[type] || {})) {
      const b = Math.floor(Number(lease) / BIN);
      for (let i = 0; i < flat.length; i += 5) {
        if (flat[i] < last - 1) continue;
        const x = (bands[b] ??= { c: 0, p: 0 });
        x.c += flat[i + 1]; x.p += flat[i + 2];
      }
    }
    for (let b = FIRST; b < LAST; b++) {
      const lo = bands[b], hi = bands[b + 1];
      if (!lo || !hi || lo.c < 5 || hi.c < 5) continue;
      const w = Math.min(lo.c, hi.c);
      steps[b].w += w;
      steps[b].d += w * (Math.log(hi.p / hi.c) - Math.log(lo.p / lo.c));
    }
  }
  // Average step per band (never negative: more lease should not be worth less); fill gaps from neighbours.
  const d = steps.map((s) => (s.w ? Math.max(0, s.d / s.w) : null));
  for (let b = FIRST; b < LAST; b++) {
    if (d[b] !== null) continue;
    let k = 1;
    while (d[b] === null && k < LAST) { d[b] = d[b - k] ?? d[b + k] ?? null; k++; }
    d[b] ??= 0.03;
  }
  const logV = { [FIRST]: 0 };
  for (let b = FIRST; b < LAST; b++) logV[b + 1] = logV[b] + d[b];
  return (lease) => {
    const x = (lease - BIN / 2) / BIN;
    if (x <= FIRST) return logV[FIRST] - (FIRST - x) * d[FIRST];
    if (x >= LAST) return logV[LAST] + (x - LAST) * d[LAST - 1];
    const b = Math.floor(x);
    return logV[b] + (x - b) * d[b];
  };
}

function percentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => (sorted.length > 1 ? (sorted.indexOf(v) + sorted.lastIndexOf(v)) / 2 / (sorted.length - 1) * 100 : 50));
}
const scale = (v, min, max) => (max > min ? ((v - min) / (max - min)) * 100 : 50);

function computeRanking({ youngest, stage, type, budget, hold }) {
  const minLease = requiredLease(youngest);
  const names = Object.keys(towns);
  const growthYears = hold <= 5 ? 5 : 10;
  const logValue = leaseCurve(type);

  // Amenity score (0-100) per town, from per-10k-home densities ranked across towns.
  const per10k = (k) => names.map((t) => (towns[t].dwellings ? (k(towns[t]) / towns[t].dwellings) * 1e4 : 0));
  const ranks = {
    mrt: percentileRanks(per10k((t) => t.mrtStations.length)),
    schools: percentileRanks(per10k((t) => t.primarySchools)),
    clinics: percentileRanks(per10k((t) => t.clinics)),
  };
  const w = LIFE_STAGES[stage].amenity;

  const rows = names.map((town, i) => {
    const series = townSeries(town, type, minLease);
    const last = series[series.length - 1];
    const growth = annualGrowth(series, growthYears);
    const avgLease = last.count ? last.lease / last.count : null;
    // Yearly value lost as the lease runs down from avgLease to avgLease - hold.
    const leaseDrag = avgLease ? Math.exp((logValue(avgLease - hold) - logValue(avgLease)) / hold) - 1 : null;
    return {
      town, series, growth, avgLease, leaseDrag,
      ret: growth !== null && leaseDrag !== null ? (1 + growth) * (1 + leaseDrag) - 1 : null,
      liquidity: series.slice(-3).reduce((a, s) => a + s.count, 0) / 3,
      recentCount: last.count,
      avgPrice: last.count ? last.price / last.count : null,
      avgSqm: last.count ? last.sqm / last.count : null,
      budgetShare: budgetShare(town, type, minLease, budget),
      amenity: w.mrt * ranks.mrt[i] + w.schools * ranks.schools[i] + w.clinics * ranks.clinics[i],
    };
  });

  const eligible = rows.filter((r) => r.ret !== null && r.recentCount >= MIN_RECENT_SALES);
  const g = eligible.map((r) => r.ret), l = eligible.map((r) => r.liquidity);
  const [gMin, gMax, lMin, lMax] = [Math.min(...g), Math.max(...g), Math.min(...l), Math.max(...l)];
  for (const r of eligible) {
    r.growthScore = scale(r.ret, gMin, gMax);
    r.liquidityScore = scale(r.liquidity, lMin, lMax);
    const base = WEIGHTS.growth * r.growthScore + WEIGHTS.liquidity * r.liquidityScore;
    r.score = Math.min(100, Math.max(0, base + (AMENITY_POINTS * (r.amenity - 50)) / 50));
    r.affordable = r.budgetShare !== null && r.budgetShare >= MIN_BUDGET_SHARE;
  }
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { rows, minLease, growthYears };
}

// ---------- rendering ----------

function reasons(r, input, growthYears) {
  const t = towns[r.town];
  const price = Math.min(r.avgPrice, input.budget || r.avgPrice);
  const future = price * (1 + r.ret) ** input.hold;
  const exitLease = Math.round(r.avgLease - input.hold);
  const out = [
    `Estimated ${fmtPct(r.ret)} a year: prices ${fmtPct(r.growth)}/yr over ${growthYears} years, ${fmtPct(r.leaseDrag)}/yr from lease run-down`,
    `A ${fmtK(price)} flat could be worth about ${fmtK(future)} after ${input.hold} years if past trends continue (about ${exitLease} years of lease left by then)`,
    `About ${Math.round(r.liquidity).toLocaleString()} matching sales a year; ${Math.round(r.budgetShare * 100)}% were within your budget`,
  ];
  if (input.stage === "family") out.push(`${t.primarySchools} primary schools, ${t.mrtStations.length} MRT/LRT stations`);
  else if (input.stage === "retiree") out.push(`${t.clinics} CHAS clinics, ${t.mrtStations.length} MRT/LRT stations`);
  else out.push(`${t.mrtStations.length} MRT/LRT stations${t.mrtStations.length ? ": " + t.mrtStations.slice(0, 4).join(", ") + (t.mrtStations.length > 4 ? "…" : "") : ""}`);
  return out;
}

function budgetNote(input) {
  if (input.mode !== "finances") return "";
  const f = input.finance;
  if (!f.budget) return "With these finances there isn't enough for the downpayment and fees. Try adding CPF or cash.";
  const loanText = f.loan
    ? `a ${f.loanType.label} of ${fmtK(f.loan)} over ${f.tenure} years at ${(f.loanType.rate * 100).toFixed(1)}% (about ${fmtMoney(f.instalment)}/month)`
    : `no loan (this assumes a loan must be repaid by age ${LOAN.repayByAge})`;
  return `Estimated budget: ${fmtMoney(f.budget)}. That's ${loanText}, plus ${fmtK(f.budget - f.loan)} from CPF and cash, ` +
    `with ${fmtMoney(f.duty + LOAN.fees)} set aside for stamp duty and fees. Grants would raise this; cash over valuation would lower it.`;
}

function render() {
  const input = readInput();
  const { rows, minLease, growthYears } = computeRanking(input);
  const latestYear = Number(meta.latestMonth.slice(0, 4));
  $("budgetNote").textContent = budgetNote(input);
  $("leaseNote").textContent =
    `${input.youngest === input.age ? `At age ${input.age}` : `With the youngest buyer aged ${input.youngest}`}, ` +
    `you need at least ${minLease} years of lease left to use CPF in full, ` +
    `so only ${input.type.toLowerCase()} flats with lease starting in ${latestYear + minLease - 99} or later are counted. ` +
    `Returns assume you sell after ${input.hold} years.`;

  const picks = rows.filter((r) => r.score !== undefined && r.affordable).slice(0, 3);
  $("picks").innerHTML = picks.length
    ? picks.map((r, i) => `
      <article class="pick" data-town="${r.town}">
        <div class="rank">#${i + 1} pick</div>
        <h3>${titleCase(r.town)}</h3>
        <div class="score">Score ${r.score.toFixed(0)} / 100</div>
        <ul>${reasons(r, input, growthYears).map((x) => `<li>${x}</li>`).join("")}</ul>
      </article>`).join("")
    : `<p class="note">No town has enough matching flats within this budget. Try raising the budget, choosing a smaller flat type, or check the full table below.</p>`;

  $("table").tBodies[0].innerHTML = rows.map((r, i) => {
    const t = towns[r.town];
    const scored = r.score !== undefined;
    const cls = [!scored || !r.affordable ? "excluded" : "", r.town === selectedTown ? "selected" : ""].join(" ");
    return `<tr class="${cls}" data-town="${r.town}">
      <td class="num">${scored ? i + 1 : "–"}</td>
      <td>${titleCase(r.town)}${!scored ? ' <span class="tag">too little data</span>' : !r.affordable ? ' <span class="tag">over budget</span>' : ""}</td>
      <td class="num">${scored ? `<span class="bar" style="width:${(r.score * 0.5).toFixed(0)}px"></span>${r.score.toFixed(0)}` : "–"}</td>
      <td class="num">${r.growth !== null ? fmtPct(r.growth) : "–"}</td>
      <td class="num">${r.ret !== null ? fmtPct(r.ret) : "–"}</td>
      <td class="num">${Math.round(r.liquidity).toLocaleString()}</td>
      <td class="num">${r.avgPrice ? fmtK(r.avgPrice) : "–"}</td>
      <td class="num">${r.avgSqm ? r.avgSqm.toFixed(0) + " sqm" : "–"}</td>
      <td class="num">${r.budgetShare !== null ? Math.round(r.budgetShare * 100) + "%" : "–"}</td>
      <td><span class="tag">${t.mrtStations.length} MRT · ${t.primarySchools} schools · ${t.clinics} clinics</span></td>
    </tr>`;
  }).join("");

  for (const el of document.querySelectorAll("[data-town]")) el.onclick = () => showDetail(el.dataset.town);
  if (selectedTown) showDetail(selectedTown, false);
}

function showDetail(town, scroll = true) {
  selectedTown = town;
  for (const tr of $("table").tBodies[0].rows) tr.classList.toggle("selected", tr.dataset.town === town);
  const { type, youngest } = readInput();
  const minLease = requiredLease(youngest);
  const series = townSeries(town, type, minLease);
  // Singapore-wide comparison series for the same filter.
  const all = meta.periods.map((_, i) => {
    let c = 0, p = 0;
    for (const t of Object.keys(towns)) { const s = townSeries(t, type, minLease)[i]; c += s.count; p += s.psm; }
    return c ? p / c : null;
  });
  const labels = meta.periods.map((p) => p.to.slice(0, 4) === p.from.slice(0, 4) ? p.to.slice(0, 4) : `${p.from.slice(2, 4)}/${p.to.slice(2, 4)}`);
  const t = towns[town];

  $("detail").hidden = false;
  $("detailTitle").textContent = `${titleCase(town)}: ${type.toLowerCase()} price per sqm`;
  $("detailText").textContent =
    `Average resale price per sqm for ${type.toLowerCase()} flats with ${minLease}+ years of lease left, in 12-month periods ending ${meta.latestMonth.slice(5)}/${meta.latestMonth.slice(0, 4)}. ` +
    `MRT/LRT: ${t.mrtStations.join(", ") || "none mapped"}.`;

  const css = getComputedStyle(document.documentElement);
  const color = (v) => css.getPropertyValue(v).trim();
  const data = {
    labels,
    datasets: [
      { label: titleCase(town), data: series.map((s) => (s.count >= 5 ? Math.round(s.psm / s.count) : null)), borderColor: color("--accent"), backgroundColor: color("--accent"), tension: 0.25, spanGaps: true },
      { label: "All towns", data: all.map((v) => (v ? Math.round(v) : null)), borderColor: color("--dim"), backgroundColor: color("--dim"), borderDash: [5, 4], tension: 0.25 },
    ],
  };
  const options = {
    responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { color: color("--muted") } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.parsed.y)}/sqm` } } },
    scales: {
      x: { ticks: { color: color("--muted") }, grid: { color: color("--border") } },
      y: { ticks: { color: color("--muted"), callback: (v) => fmtMoney(v) }, grid: { color: color("--border") } },
    },
  };
  if (chart) { chart.data = data; chart.options = options; chart.update(); }
  else chart = new Chart($("chart"), { type: "line", data, options });
  if (scroll) $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

init();
