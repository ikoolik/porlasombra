// Precompute the Valencia routing artifact.
//
//   Catastro buildingpart.gml  ->  building prisms (ring + height)
//   osmium OPL of walkable ways ->  sidewalk graph (L/R pavements, penalised crossings)
//   Valencia tree inventory     ->  canopy points (position + species index)
//
// Output is a single static file the browser fetches once. No Overpass at query time, no
// graph construction at query time, and no routing server anywhere.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { parseOpl } from "./parse-osm.mjs";
import { buildGraph, components, stitch, CROSS_PENALTY_M } from "./build-graph.mjs";
import { buildCanopy } from "./parse-trees.mjs";
import { parseAddresses } from "./parse-addresses.mjs";
import { joinStreetNames } from "./join-streets.mjs";

const DATA = path.resolve(import.meta.dirname, "../data");
const BBOX = [39.42, -0.42, 39.51, -0.32]; // s,w,n,e — Valencia city
const Q = 1e6;                             // coordinate quantisation (~0.1 m)

const pct = (a, b) => (a / b * 100).toFixed(1) + "%";

console.log("→ streets");
const { nodes: nodeCoords, ways, wayTotal } = await parseOpl(path.join(DATA, "walkable.opl"));
console.log(`  ${ways.length} walkable of ${wayTotal} ways, ${nodeCoords.size} osm nodes`);

console.log("→ graph");
const graph = buildGraph(ways, nodeCoords);
let { comp, sizes } = components(graph);
const before = { comps: sizes.length, largest: Math.max(...sizes) };
console.log(`  ${graph.nodes.length} nodes, ${sizes.length} components, ` +
            `largest ${before.largest} (${pct(before.largest, graph.nodes.length)})`);

console.log("→ stitch");
const welds = stitch(graph, comp, sizes.length);
({ comp, sizes } = components(graph));
const largest = Math.max(...sizes), keep = sizes.indexOf(largest);
console.log(`  ${welds} welds -> ${sizes.length} components, ` +
            `largest ${largest} (${pct(largest, graph.nodes.length)})`);

// Ship only the reachable network. Everything else is, by definition, unroutable.
// Order the survivors along a Z-order curve first: neighbours in space become neighbours in
// index, which makes both the coordinate deltas and the edge endpoints small numbers.
const survivors = [];
for (let i = 0; i < graph.nodes.length; i++) if (comp[i] === keep) survivors.push(i);

const morton = (x, y) => {
  let k = 0n, bx = BigInt(x), by = BigInt(y);
  for (let i = 0n; i < 32n; i++) k |= ((bx >> i) & 1n) << (2n * i) | ((by >> i) & 1n) << (2n * i + 1n);
  return k;
};
const originLon = Math.round(BBOX[1] * Q), originLat = Math.round(BBOX[0] * Q);
const key = new Map();
for (const i of survivors) {
  const c = graph.nodes[i].coord;
  key.set(i, morton(Math.round(c[0] * Q) - originLon, Math.round(c[1] * Q) - originLat));
}
survivors.sort((a, b) => (key.get(a) < key.get(b) ? -1 : key.get(a) > key.get(b) ? 1 : 0));

const remap = new Int32Array(graph.nodes.length).fill(-1);
const keptNodes = [];
for (const i of survivors) { remap[i] = keptNodes.length; keptNodes.push(graph.nodes[i]); }
// Columnar + delta: each column holds like-magnitude numbers, which gzip handles far better
// than the same values interleaved. `from` ascends so its deltas are mostly 0/1, and Z-ordering
// keeps `to - from` small (median 5).
const pairs = [];
for (let i = 0; i < graph.nodes.length; i++) {
  if (remap[i] < 0) continue;
  for (const e of graph.adj[i]) {
    if (e.to <= i || remap[e.to] < 0) continue; // store each undirected edge once
    pairs.push([remap[i], remap[e.to], Math.round(e.len * 10), e.pen ? 1 : 0]);
  }
}
pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const eFrom = [], eTo = [], eLen = [], eCross = [];
let pf = 0;
for (const [f, t, len, cross] of pairs) {
  eFrom.push(f - pf); pf = f;
  eTo.push(t - f);
  eLen.push(len);
  eCross.push(cross);
}
console.log(`  kept ${keptNodes.length} nodes / ${pairs.length} edges`);

console.log("→ buildings");
const buildings = JSON.parse(fs.readFileSync(path.join(DATA, "buildings.json"), "utf8"));

// Cadastral outlines carry vertices at 0.1 m accuracy, far finer than a convex-hull shadow can
// use. Simplifying to ~0.3 m drops a third of them with no visible effect on the shade, and the
// deltas that survive are small integers that gzip extremely well.
const SIMPLIFY = 3; // quantised units, ~0.3 m
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const [ax, ay] = pts[lo], [bx, by] = pts[hi];
    const dx = bx - ax, dy = by - ay, den = Math.hypot(dx, dy) || 1;
    let far = -1, fd = tol;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / den;
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([lo, far], [far, hi]); }
  }
  return pts.filter((_, i) => keep[i]);
}

let vBefore = 0, vAfter = 0;
const bRings = [], bHeights = [];
for (const b of buildings) {
  let pts = b.r.map(([lon, lat]) => [Math.round(lon * Q), Math.round(lat * Q)]);
  vBefore += pts.length;
  // Rings arrive closed; drop the repeated last vertex, it is implied.
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  pts = simplify(pts, SIMPLIFY);
  if (pts.length < 3) continue;
  vAfter += pts.length;
  // Delta encode: absolute first vertex, then step-to-step deltas.
  const flat = [pts[0][0], pts[0][1]];
  for (let i = 1; i < pts.length; i++) flat.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  bRings.push(flat);
  bHeights.push(b.h);
}
console.log(`  ${bRings.length} parts, ${vBefore} -> ${vAfter} vertices (${pct(vAfter, vBefore)})`);

console.log("→ trees");
const trees = JSON.parse(fs.readFileSync(path.join(DATA, "trees.json"), "utf8"));
const canopy = buildCanopy(trees, BBOX, Q);
{
  const s = canopy.stats;
  console.log(`  ${s.seen} inventory -> ${s.kept} in bbox ` +
              `(${s.outside} outside, ${s.notATree} empty pits)`);
  console.log(`  ${pct(s.bySpecies, s.kept)} dimensioned by species, ` +
              `${pct(s.byGroup, s.kept)} by group fallback, ${s.rows} distinct crowns`);
}

console.log("→ addresses");
const { streets, addrs } = await parseAddresses(path.join(DATA, "A.ES.SDGC.AD.46900.gml"));
// Clip to the routed bbox first: an address outside it has no graph to snap to, so shipping it
// would only offer the user a destination the router cannot reach.
const inBox = addrs.filter((a) =>
  a.lat >= BBOX[0] && a.lat <= BBOX[2] && a.lon >= BBOX[1] && a.lon <= BBOX[3]);
{
  const j = joinStreetNames(streets, inBox, ways, nodeCoords).stats;
  console.log(`  ${addrs.length} addresses -> ${inBox.length} in bbox, ${streets.length} streets`);
  console.log(`  ${j.joined} named from OSM (${pct(j.joined, j.streets)}), ` +
              `${j.contested} contested claims dropped, ${j.fallback} kept the Catastro name`);
}

// One entry per street, carrying its house numbers in human order. Numbers are what the search
// box completes against once a street is picked, so they ship grouped rather than as free points.
const byStreet = new Map();
for (const a of inBox) {
  let g = byStreet.get(a.s); if (!g) byStreet.set(a.s, g = []);
  g.push(a);
}
// "12", "12A", "12B" all exist; sort by the number first so the list reads the way a street does.
const numKey = (n) => {
  const m = /^(\d*)(.*)$/.exec(n);
  return [m[1] ? parseInt(m[1], 10) : Infinity, m[2]];
};
const sName = [], sAlias = [], sCount = [], aNum = [], aLon = [], aLat = [];
let px = 0, py = 0, dropped = 0;
for (const [si, list] of [...byStreet.entries()].sort((a, b) => a[0] - b[0])) {
  // Several entrances can share a number (a block with two doors); one suggestion is enough.
  const seen = new Set();
  const uniq = list.filter((a) => !seen.has(a.n) && seen.add(a.n));
  dropped += list.length - uniq.length;
  uniq.sort((a, b) => {
    const ka = numKey(a.n), kb = numKey(b.n);
    return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
  });
  const s = streets[si];
  sName.push(s.display);
  // Only when it says something the display name does not — the Catastro spelling is the Spanish
  // one where OSM gave us Valencian, and it is what older paperwork carries.
  sAlias.push(s.alias && s.alias !== s.display ? s.alias : "");
  sCount.push(uniq.length);
  for (const a of uniq) {
    aNum.push(a.n);
    const x = Math.round(a.lon * Q), y = Math.round(a.lat * Q);
    aLon.push(x - px); aLat.push(y - py);
    px = x; py = y;
  }
}
console.log(`  ${sName.length} streets, ${aNum.length} numbered entrances ` +
            `(${dropped} duplicate numbers merged)`);

const artifact = {
  meta: {
    city: "Valencia", bbox: BBOX, quant: Q,
    generated: new Date().toISOString().slice(0, 10),
    sources: {
      buildings: "Catastro INSPIRE BU 46900 (buildingpart)",
      streets: "OpenStreetMap via Geofabrik",
      trees: "Ajuntament de València, Servicio de Parques y Jardines (CC BY 4.0)",
      addresses: "Catastro INSPIRE AD 46900, street names from OpenStreetMap",
    },
    counts: {
      nodes: keptNodes.length, edges: eLen.length,
      buildings: bRings.length, trees: canopy.tSp.length,
      streets: sName.length, addresses: aNum.length,
    },
    crossPenaltyM: CROSS_PENALTY_M,
    // Crown dimension table, indexed by tSp: [height, crownDiameter, crownBase] in decimetres,
    // then [tau, deciduous] as percent and 0/1. tauBare is the transmittance a deciduous crown
    // falls back to once the leaves are off.
    species: canopy.species,
    tauBare: canopy.tauBare,
  },
  // Flat, quantised, delta-encoded arrays: JSON that gzips like a binary format.
  nodes: (() => {
    const out = [];
    let px = 0, py = 0;
    for (const n of keptNodes) {
      const x = Math.round(n.coord[0] * Q), y = Math.round(n.coord[1] * Q);
      out.push(x - px, y - py);
      px = x; py = y;
    }
    return out;
  })(),
  eFrom, eTo, eLen, eCross,
  bRings,
  bHeights,
  // Canopy. Positions delta-encoded like `nodes`; tSp indexes meta.species. Kept as its own
  // column rather than merged into the building prisms: a crown floats (it shades the slab
  // between crownBase and height, with open air beneath), and it is only opaque in leaf, so
  // it cannot ride the same path as a solid ground-standing prism.
  tLon: canopy.tLon,
  tLat: canopy.tLat,
  tSp: canopy.tSp,
  // Geocoder. Streets are a short list the browser scans linearly — 3k entries is nothing — and
  // house numbers hang off them by count rather than by a repeated street id, so `sCount` is the
  // only join needed. Positions are entrance points, delta-encoded like everything else.
  sName, sAlias, sCount, aNum, aLon, aLat,
};

const out = path.join(DATA, "valencia.json");
const json = JSON.stringify(artifact);
fs.writeFileSync(out, json);
const gz = zlib.gzipSync(json, { level: 9 });
fs.writeFileSync(out + ".gz", gz);
console.log(`\n✓ ${(json.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(1)} MB gzipped`);
