// Post-build health gate for the routing artifact.
//
// Two separate failures once shipped a graph that routed people 2 km to walk 400 m: (1) a truncated
// walkable input decimated the sidewalk graph to a near-tree, and (2) a `\`-wrapped WALKABLE make
// variable expanded with embedded spaces, so the shell dropped every road-carriageway class and the
// graph became footway-only. Both are invisible in a spot check but obvious in aggregate — so this
// gate refuses to let an unhealthy artifact reach `dist`/`deploy`.
//
// Run directly (`node verify-artifact.mjs`) it decodes data/valencia.json.gz, checks every invariant,
// prints a table, and exits non-zero on any failure. The check functions are also imported by
// tests.test.mjs. Thresholds sit well below a healthy build so a normal quarterly rebuild never trips
// them; they only fire on the kind of collapse described above.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.resolve(import.meta.dirname, "../data");

// ---------- thresholds ----------
// Reference healthy build (2026-07-26): 296k nodes / 738k edges, 99.7% in one component, mean degree
// ~5.0, leaves ~0.5%, central detour median 1.24 / p90 1.44, golden routes ~1.1. Limits are loose
// enough for OSM to drift a quarter, tight enough that the footway-only (median 1.29 / p90 1.66,
// golden route 2.26) and decimated (median 1.96 / p90 3.70) graphs both fail.
export const THRESHOLDS = {
  minNodes: 200_000,
  minEdges: 450_000,
  minLargestComponentFrac: 0.97,
  minMeanDegree: 4.0,
  maxLeafFrac: 0.03,
  maxDetourMedian: 1.40,
  maxDetourP90: 1.80,
  maxGoldenRatio: 1.50,        // a real A→B must not wander more than 1.5× the straight line
  minResidentialWays: 3_000,   // walkable.opl must carry road carriageways, not footways alone
};

// Real routes through the centre that a person would expect to be near-straight. Each must route
// under maxGoldenRatio. The first is the Almirall Cadarso → Isabel la Católica line that regressed
// to 2.26× when the carriageways went missing.
export const GOLDEN_ROUTES = [
  { name: "Matíes Perelló → Colón (Almirall Cadarso / Isabel la Católica)", a: [-0.3668, 39.4636], b: [-0.3712, 39.4693] },
  { name: "Russafa → Gran Via del Marqués del Túria",                        a: [-0.3735, 39.4600], b: [-0.3690, 39.4665] },
  { name: "Sant Francesc → El Pla del Remei",                                a: [-0.3760, 39.4690], b: [-0.3705, 39.4700] },
];

// ---------- artifact decode → CSR graph ----------
export function loadGraph(file = path.join(DATA, "valencia.json.gz")) {
  const raw = fs.readFileSync(file);
  const text = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const a = JSON.parse(text);
  const Q = a.meta.quant;

  const n = a.meta.counts.nodes;
  const lon = new Float64Array(n), lat = new Float64Array(n);
  let px = 0, py = 0;
  for (let i = 0; i < n; i++) { px += a.nodes[2 * i]; py += a.nodes[2 * i + 1]; lon[i] = px / Q; lat[i] = py / Q; }

  const m = a.meta.counts.edges;
  const ef = new Int32Array(m), et = new Int32Array(m), elen = new Float32Array(m), ecross = new Uint8Array(m);
  let f = 0;
  for (let i = 0; i < m; i++) { f += a.eFrom[i]; ef[i] = f; et[i] = f + a.eTo[i]; elen[i] = a.eLen[i] / 10; ecross[i] = a.eCross[i]; }
  const deg = new Int32Array(n + 1);
  for (let i = 0; i < m; i++) { deg[ef[i]]++; deg[et[i]]++; }
  const head = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) head[i + 1] = head[i] + deg[i];
  const fill = head.slice(0, n);
  const adjTo = new Int32Array(2 * m), adjLen = new Float32Array(2 * m), adjPen = new Float32Array(2 * m);
  const CROSS = a.meta.crossPenaltyM ?? 18;
  for (let i = 0; i < m; i++) {
    const pen = ecross[i] ? CROSS : 0;
    let k = fill[ef[i]]++; adjTo[k] = et[i]; adjLen[k] = elen[i]; adjPen[k] = pen;
    k = fill[et[i]]++;     adjTo[k] = ef[i]; adjLen[k] = elen[i]; adjPen[k] = pen;
  }

  // node grid for snapping
  const CELL = 0.0007; // ~60 m
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const key = Math.floor(lon[i] / CELL) + ":" + Math.floor(lat[i] / CELL);
    let c = grid.get(key); if (!c) grid.set(key, c = []); c.push(i);
  }
  return { n, m, lon, lat, head, adjTo, adjLen, adjPen, grid, CELL };
}

const metres = (ax, ay, bx, by) => {
  const kx = Math.cos(by * Math.PI / 180) * 111320, ky = 110540;
  return Math.hypot((ax - bx) * kx, (ay - by) * ky);
};

function nearestNode(G, lonlat) {
  const [x, y] = lonlat;
  let best = -1, bestD = Infinity;
  for (let ring = 0; ring <= 20 && best < 0; ring++) {
    const gx = Math.floor(x / G.CELL), gy = Math.floor(y / G.CELL);
    for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
      if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
      for (const i of (G.grid.get((gx + dx) + ":" + (gy + dy)) || [])) {
        const d = metres(x, y, G.lon[i], G.lat[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
  }
  return best;
}

// binary min-heap of [priority, node]
class MinHeap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, s = i; if (l < a.length && a[l][0] < a[s][0]) s = l; if (r < a.length && a[r][0] < a[s][0]) s = r; if (s === i) break;[a[s], a[i]] = [a[i], a[s]]; i = s; } } return top; }
  get size() { return this.a.length; }
}

// A* shortest path (pure length, admissible straight-line heuristic). Returns metres or Infinity.
export function shortestLength(G, src, dst) {
  const dist = new Float64Array(G.n).fill(Infinity), done = new Uint8Array(G.n);
  const tx = G.lon[dst], ty = G.lat[dst], kx = Math.cos(ty * Math.PI / 180) * 111320, ky = 110540;
  const h = (v) => Math.hypot((G.lon[v] - tx) * kx, (G.lat[v] - ty) * ky);
  dist[src] = 0;
  const heap = new MinHeap(); heap.push([h(src), src]);
  while (heap.size) {
    const [, u] = heap.pop();
    if (done[u]) continue; done[u] = 1;
    if (u === dst) break;
    const g = dist[u];
    for (let k = G.head[u]; k < G.head[u + 1]; k++) {
      const v = G.adjTo[k]; if (done[v]) continue;
      const ng = g + G.adjLen[k]; // pure distance, penalties ignored for the connectivity check
      if (ng < dist[v]) { dist[v] = ng; heap.push([ng + h(v), v]); }
    }
  }
  return dist[dst];
}

// ---------- metrics ----------
export function graphMetrics(G) {
  let leaves = 0, degSum = 0;
  for (let u = 0; u < G.n; u++) { const d = G.head[u + 1] - G.head[u]; degSum += d; if (d === 1) leaves++; }
  // largest connected component
  const seen = new Uint8Array(G.n); let largest = 0;
  for (let s = 0; s < G.n; s++) {
    if (seen[s]) continue; let sz = 0; const st = [s]; seen[s] = 1;
    while (st.length) { const u = st.pop(); sz++; for (let k = G.head[u]; k < G.head[u + 1]; k++) { const v = G.adjTo[k]; if (!seen[v]) { seen[v] = 1; st.push(v); } } }
    if (sz > largest) largest = sz;
  }
  return { nodes: G.n, edges: G.m, meanDegree: degSum / G.n, leafFrac: leaves / G.n, largestComponentFrac: largest / G.n };
}

// Seeded sample of central pairs 300–900 m apart: shortest-path length / straight-line distance.
export function detourStats(G, { box = [-0.385, 39.455, -0.355, 39.478], samples = 200, seed = 4242 } = {}) {
  const central = [];
  for (let i = 0; i < G.n; i++) if (G.lon[i] > box[0] && G.lon[i] < box[2] && G.lat[i] > box[1] && G.lat[i] < box[3]) central.push(i);
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const ratios = [];
  for (let t = 0; t < samples; t++) {
    const src = central[Math.floor(rnd() * central.length)];
    let dst = -1;
    for (let k = 0; k < 300; k++) { const c = central[Math.floor(rnd() * central.length)]; const d = metres(G.lon[src], G.lat[src], G.lon[c], G.lat[c]); if (d > 300 && d < 900) { dst = c; break; } }
    if (dst < 0) continue;
    const len = shortestLength(G, src, dst);
    if (!isFinite(len)) continue;
    ratios.push(len / metres(G.lon[src], G.lat[src], G.lon[dst], G.lat[dst]));
  }
  ratios.sort((a, b) => a - b);
  const q = (p) => ratios[Math.floor(p * ratios.length)] ?? Infinity;
  return { count: ratios.length, median: q(0.5), p90: q(0.9), max: ratios[ratios.length - 1] ?? Infinity };
}

export function goldenRouteRatios(G, routes = GOLDEN_ROUTES) {
  return routes.map((r) => {
    const src = nearestNode(G, r.a), dst = nearestNode(G, r.b);
    const len = shortestLength(G, src, dst);
    const straight = metres(r.a[0], r.a[1], r.b[0], r.b[1]);
    return { name: r.name, ratio: isFinite(len) ? len / straight : Infinity };
  });
}

// Count road-carriageway ways in the walkable input. The sidewalk builder needs these; a broken
// highway filter leaves only footways. Returns null if the OPL isn't present (e.g. after `make clean`).
export function residentialWayCount(oplFile = path.join(DATA, "walkable.opl")) {
  if (!fs.existsSync(oplFile)) return null;
  const opl = fs.readFileSync(oplFile, "utf8");
  return (opl.match(/highway=residential/g) || []).length;
}

// ---------- gate ----------
export function runChecks(G = loadGraph()) {
  const met = graphMetrics(G);
  const det = detourStats(G);
  const golden = goldenRouteRatios(G);
  const res = residentialWayCount();
  const T = THRESHOLDS;
  const checks = [
    ["nodes", met.nodes, `≥ ${T.minNodes}`, met.nodes >= T.minNodes],
    ["edges", met.edges, `≥ ${T.minEdges}`, met.edges >= T.minEdges],
    ["largest component", (met.largestComponentFrac * 100).toFixed(1) + "%", `≥ ${(T.minLargestComponentFrac * 100)}%`, met.largestComponentFrac >= T.minLargestComponentFrac],
    ["mean degree", met.meanDegree.toFixed(2), `≥ ${T.minMeanDegree}`, met.meanDegree >= T.minMeanDegree],
    ["leaf fraction", (met.leafFrac * 100).toFixed(1) + "%", `≤ ${(T.maxLeafFrac * 100)}%`, met.leafFrac <= T.maxLeafFrac],
    ["detour median", det.median.toFixed(2), `≤ ${T.maxDetourMedian}`, det.median <= T.maxDetourMedian],
    ["detour p90", det.p90.toFixed(2), `≤ ${T.maxDetourP90}`, det.p90 <= T.maxDetourP90],
    ...golden.map((g) => [`route: ${g.name}`, g.ratio.toFixed(2) + "×", `≤ ${T.maxGoldenRatio}×`, g.ratio <= T.maxGoldenRatio]),
  ];
  if (res !== null) checks.push(["residential ways (walkable.opl)", res, `≥ ${T.minResidentialWays}`, res >= T.minResidentialWays]);
  return { checks, ok: checks.every((c) => c[3]) };
}

// Run as a script → print + exit code.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checks, ok } = runChecks();
  const w = Math.max(...checks.map((c) => c[0].length));
  console.log("→ artifact health");
  for (const [name, value, want, pass] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${name.padEnd(w)}  ${String(value).padStart(9)}   (want ${want})`);
  }
  console.log(ok ? "\n✓ artifact healthy" : "\n✗ artifact FAILED health checks — not fit to deploy");
  process.exit(ok ? 0 : 1);
}
