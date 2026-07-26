// Regression tests for the build. Run with `node --test` (or `make test`).
//
// These guard the two failures that once shipped a graph routing people 2 km to walk 400 m:
//   1. the WALKABLE make variable expanding with embedded spaces, which dropped road carriageways;
//   2. an under-connected sidewalk graph (missing local welds / a decimated input).
// The heavy end-to-end guard is verify-artifact.mjs; these add fast static + unit checks and a
// negative test proving the gate is not a no-op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildGraph, weldLocal, components } from "./build-graph.mjs";
import { runChecks, loadGraph, THRESHOLDS } from "./verify-artifact.mjs";

const HERE = import.meta.dirname;
const DATA = path.resolve(HERE, "../data");

// --- 1. The exact bug: the WALKABLE highway list must expand to a single space-free token, or the
//        unquoted `w/highway=$(WALKABLE)` splits into several osmium arguments and carriageways vanish.
test("WALKABLE make variable expands with no embedded whitespace", () => {
  const dump = execSync("make -p", { cwd: HERE, encoding: "utf8" });
  const line = dump.split("\n").find((l) => /^WALKABLE\s*:?=/.test(l));
  assert.ok(line, "WALKABLE not found in `make -p` output");
  const value = line.replace(/^WALKABLE\s*:?=\s*/, "").trim();
  assert.doesNotMatch(value, /\s/, `WALKABLE expanded with whitespace — a \\-continuation adds a space that splits the osmium filter: "${value}"`);
  // and it must actually include the carriageway classes the sidewalk builder consumes
  for (const cls of ["residential", "tertiary", "secondary", "primary"]) {
    assert.ok(value.split(",").includes(cls), `WALKABLE is missing highway=${cls}`);
  }
});

// --- 2. weldLocal must link two pavement chains that touch at a coincident point but came from
//        different OSM ways (so byOsmNode never joined them). This is the grid-closing behaviour.
test("weldLocal welds coincident pavement nodes from different ways", () => {
  const nodeCoords = new Map([
    [1, [-0.370, 39.466]],
    [2, [-0.369, 39.466]], // chain A ends here
    [3, [-0.369, 39.466]], // chain B starts at the SAME point, different id
    [4, [-0.368, 39.466]],
  ]);
  const ways = [
    { refs: [1, 2], tags: { highway: "footway" } },
    { refs: [3, 4], tags: { highway: "footway" } },
  ];
  const graph = buildGraph(ways, nodeCoords);
  assert.equal(components(graph).sizes.length, 2, "expected two disconnected chains before welding");
  const welds = weldLocal(graph);
  assert.ok(welds >= 1, "weldLocal should weld the coincident endpoints");
  assert.equal(components(graph).sizes.length, 1, "the two chains should be one component after welding");
});

// --- 3. The gate must PASS on the shipped artifact (skipped if it hasn't been built yet).
test("built artifact passes the health gate", (t) => {
  const file = path.join(DATA, "valencia.json.gz");
  if (!fs.existsSync(file)) return t.skip("valencia.json.gz not built — run `make` first");
  const { checks, ok } = runChecks(loadGraph(file));
  const failed = checks.filter((c) => !c[3]).map((c) => `${c[0]} = ${c[1]} (want ${c[2]})`);
  assert.ok(ok, "failed checks:\n  " + failed.join("\n  "));
});

// --- 4. The gate must FAIL on an under-sized graph, so a green run means something.
test("health gate rejects an unhealthy graph", () => {
  // A tiny connected chain placed in the central box: enough to route, far below every threshold.
  const k = 40, CELL = 0.0007;
  const lon = new Float64Array(k), lat = new Float64Array(k);
  for (let i = 0; i < k; i++) { lon[i] = -0.375 + i * 0.0004; lat[i] = 39.466; }
  const m = k - 1;
  const head = new Int32Array(k + 1);
  for (let i = 0; i < k; i++) head[i + 1] = head[i] + ((i === 0 || i === k - 1) ? 1 : 2);
  const adjTo = new Int32Array(2 * m), adjLen = new Float32Array(2 * m), adjPen = new Float32Array(2 * m);
  const fill = head.slice(0, k);
  for (let i = 0; i < m; i++) {
    let a = fill[i]++; adjTo[a] = i + 1; adjLen[a] = 40;
    let b = fill[i + 1]++; adjTo[b] = i; adjLen[b] = 40;
  }
  const grid = new Map();
  for (let i = 0; i < k; i++) { const key = Math.floor(lon[i] / CELL) + ":" + Math.floor(lat[i] / CELL); let c = grid.get(key); if (!c) grid.set(key, c = []); c.push(i); }
  const G = { n: k, m, lon, lat, head, adjTo, adjLen, adjPen, grid, CELL };
  const { ok } = runChecks(G);
  assert.equal(ok, false, "a 40-node graph must not pass the health gate");
});

// --- 5. Thresholds must stay meaningfully below a healthy build (guards against someone loosening
//        them into uselessness). These mirror the reference build with margin.
test("thresholds are set to catch a footway-only or decimated graph", () => {
  assert.ok(THRESHOLDS.minNodes >= 150_000, "minNodes too low to catch the footway-only graph (152k)");
  assert.ok(THRESHOLDS.maxGoldenRatio <= 1.6, "maxGoldenRatio too loose to catch the 2.26× regression");
  assert.ok(THRESHOLDS.minResidentialWays >= 1_000, "minResidentialWays too low to catch a dropped carriageway filter");
});
