// Forecast GTA VI launch-day Twitch viewers, hours 2-24, as five quantiles an hour.
//
// Model (comparables-based, built from the case's own data at run time):
//  1. Take every comparable launch's release-day hourly curve and normalise it
//     by its hour-1 print. Keep the "still ramping" family: launches whose
//     hour-1 print is 8%-75% of their release-day peak. Those are the rolling
//     midnight-local launches (the US unlocks hours later), the same shape
//     family GTA VI belongs to; launches already at their peak in hour 1
//     (simultaneous global unlock) and launches that unlock later in the day
//     (tiny hour 1) are left out, because their curves answer a different
//     question. The GTA VI pre-release category entry is excluded too.
//  2. For each hour h = 2..24, regress the log ratio ln(viewers_h / viewers_1)
//     on ln(hour-1 print) across the family (ordinary least squares). Big
//     launches ramp less than small ones (correlation about -0.7 in the kit's
//     practice comparables), so the hour-1 print itself predicts how much the
//     curve still has to climb. The query's ln(hour-1) is clamped to the
//     family's observed range, so a record-size hour 1 never extrapolates the
//     fit beyond the launches it was fit on.
//  3. Quantiles are log-normal around the regression prediction: the spread is
//     the residual standard deviation of that hour's regression, shrunk by
//     0.85 (the factor that scored best on the kit's four practice launches),
//     with a floor of 0.12 in log terms. No randomness anywhere, so two runs
//     on the same case are byte-identical.
//
// Everything is computed from the case file at run time: no network, no
// bundled tables, standard library only.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Standard-normal quantiles at the levels 0.05 / 0.25 / 0.5 / 0.75 / 0.95.
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

// Family filter: hour-1 print as a share of the launch's release-day peak.
const RATIO_LO = 0.08;
const RATIO_HI = 0.75;

// Spread shrink and floor (log units), tuned on the kit's practice launches.
const SPREAD_SHRINK = 0.85;
const SPREAD_FLOOR = 0.12;

// Fallback median shape (log ratios to the hour-1 print, hours 2..24) used
// only if a case carries no usable comparable at all: the offline median
// shape of the ramping family. The live path below recomputes everything.
const FALLBACK_LOG_SHAPE = [
  -0.128, -0.301, -0.329, -0.288, -0.248, -0.248, -0.261, -0.301, -0.301,
  -0.198, -0.083, -0.041, 0.039, 0.148, 0.223, 0.270, 0.315, 0.380,
  0.405, 0.392, 0.470, 0.365, 0.165,
];
const FALLBACK_SPREAD = 0.45;

type HourlyMap = { [hour: number]: number };

interface LaunchCurve {
  h1: number;
  peak: number;
  byHour: HourlyMap;
}

function median(values: number[]): number {
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const ss = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return Math.sqrt(ss / values.length);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// Release-day hourly curve of one comparable, keyed by hour 1..24.
function extractCurve(comp: any): LaunchCurve | null {
  if (!comp || typeof comp !== "object") return null;
  if (typeof comp.name === "string" && /before release/i.test(comp.name)) return null;
  const dayStart = Date.parse(comp.day_start);
  if (!Number.isFinite(dayStart) || !Array.isArray(comp.hourly)) return null;
  const byHour: HourlyMap = {};
  for (const pt of comp.hourly) {
    if (!pt || typeof pt.viewers !== "number" || !Number.isFinite(pt.viewers)) continue;
    const t = Date.parse(pt.from);
    if (!Number.isFinite(t)) continue;
    const h = Math.round((t - dayStart) / 3600000) + 1;
    if (h >= 1 && h <= 24 && byHour[h] === undefined) byHour[h] = pt.viewers;
  }
  const h1 = byHour[1];
  if (h1 === undefined || h1 < 1) return null;
  let peak = 0;
  for (let h = 1; h <= 24; h++) if (byHour[h] !== undefined && byHour[h] > peak) peak = byHour[h];
  if (peak < 1) return null;
  return { h1, peak, byHour };
}

function familyOf(cases: any): LaunchCurve[] {
  const curves: LaunchCurve[] = [];
  const comps = Array.isArray(cases?.comparables) ? cases.comparables : [];
  for (const comp of comps) {
    const c = extractCurve(comp);
    if (c) curves.push(c);
  }
  // Primary family: still ramping at hour 1.
  let fam = curves.filter((c) => {
    const r = c.h1 / c.peak;
    return r >= RATIO_LO && r <= RATIO_HI;
  });
  // Widen if the primary family is too thin to regress on.
  if (fam.length < 8) {
    fam = curves.filter((c) => c.h1 >= 1000 && c.h1 / c.peak >= RATIO_LO);
  }
  if (fam.length < 8) fam = curves.filter((c) => c.h1 >= 1);
  return fam;
}

// One hour's OLS fit of log ratio on log hour-1 print across the family.
function hourFit(fam: LaunchCurve[], h: number): { alpha: number; beta: number; residSd: number } | null {
  const pts: { x: number; y: number }[] = [];
  for (const c of fam) {
    const v = c.byHour[h];
    if (v !== undefined && v > 0) pts.push({ x: Math.log(c.h1), y: Math.log(v / c.h1) });
  }
  if (pts.length < 5) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) * (p.x - mx);
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx <= 0) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const resid = pts.map((p) => p.y - (alpha + beta * p.x));
  return { alpha, beta, residSd: stddev(resid) };
}

function forecastCase(c: any): { hours: { hour: number; q: number[] }[] } {
  const known = Array.isArray(c?.known) ? c.known : [];
  const p1raw = known.length > 0 && typeof known[0].viewers === "number" ? known[0].viewers : 1;
  const p1 = Math.max(1, p1raw);

  const fam = familyOf(c);
  const logH1s = fam.map((x) => Math.log(x.h1));
  const loX = logH1s.length > 0 ? Math.min(...logH1s) : 0;
  const hiX = logH1s.length > 0 ? Math.max(...logH1s) : 0;
  // Never extrapolate the size regression past the launches it was fit on.
  const xq = logH1s.length > 0 ? clamp(Math.log(p1), loX, hiX) : Math.log(p1);

  const hours: { hour: number; q: number[] }[] = [];
  for (let h = 2; h <= 24; h++) {
    let mu: number;
    let sd: number;
    const fit = fam.length >= 8 ? hourFit(fam, h) : null;
    if (fit) {
      mu = fit.alpha + fit.beta * xq;
      sd = Math.max(SPREAD_FLOOR, fit.residSd * SPREAD_SHRINK);
    } else if (fam.length > 0) {
      // Too few points at this hour: family median log ratio, global spread.
      const lr = fam
        .map((x) => (x.byHour[h] !== undefined && x.byHour[h] > 0 ? Math.log(x.byHour[h] / x.h1) : null))
        .filter((v): v is number => v !== null);
      mu = lr.length > 0 ? median(lr) : FALLBACK_LOG_SHAPE[h - 2];
      sd = FALLBACK_SPREAD;
    } else {
      mu = FALLBACK_LOG_SHAPE[h - 2];
      sd = FALLBACK_SPREAD;
    }
    const q: number[] = Z.map((z) => {
      const v = p1 * Math.exp(mu + z * sd);
      return Math.min(1e9, Math.max(1, v));
    });
    // Round to 2 decimals, then restore non-decreasing order.
    for (let i = 0; i < q.length; i++) q[i] = Math.round(q[i] * 100) / 100;
    for (let i = 1; i < q.length; i++) if (q[i] < q[i - 1]) q[i] = q[i - 1];
    hours.push({ hour: h, q });
  }
  return { hours };
}

// Persistence fallback used only if a case file itself is unreadable: every
// hour at the hour-1 print with a widening spread. Keeps the case valid.
function fallbackForecast(p1: number): { hours: { hour: number; q: number[] }[] } {
  const hours: { hour: number; q: number[] }[] = [];
  for (let h = 2; h <= 24; h++) {
    const sd = 0.2 * Math.sqrt(h - 1);
    const q: number[] = Z.map((z) => {
      const v = p1 * Math.exp(z * sd);
      return Math.min(1e9, Math.max(1, Math.round(v * 100) / 100));
    });
    for (let i = 1; i < q.length; i++) if (q[i] < q[i - 1]) q[i] = q[i - 1];
    hours.push({ hour: h, q });
  }
  return { hours };
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const id = file.slice(0, -3);
    let out: { hours: { hour: number; q: number[] }[] };
    try {
      const c = JSON.parse(readFileSync(join(inDir, file), "utf8"));
      out = forecastCase(c);
    } catch {
      out = fallbackForecast(1);
    }
    writeFileSync(join(outDir, id + ".out"), JSON.stringify(out));
  }
}

main();
