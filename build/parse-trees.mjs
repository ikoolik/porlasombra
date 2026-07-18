// Municipal tree inventory -> canopy columns for the artifact.
//
// Emits species *indices* plus one small shared table, not resolved dimensions per tree. Two
// reasons, and the second is the important one:
//
//   * Size. Indices gzip to ~0.57 MB against ~1.13 MB for baked-out dimensions, on a 5.5 MB
//     artifact. Half the cost for the same information.
//   * One resolution, shared. The router and the renderer are separate implementations of the
//     same physics — exact point tests for edges, a marched raster for pixels — and they have
//     to agree or the app draws sun over a route it called shady. Shipping the table and
//     resolving it once at load gives both consumers the identical numbers by construction.
//     Shipping dimensions per tree would work too; shipping indices and letting each side look
//     up its own copy of the species table is the version that silently drifts.
//
// Nothing downstream branches on species. It reads h/cd/cb/tau/dec, which means growing the
// species table later is a pure data change with no code to follow it.
import { resolve, TAU_BARE, SPECIES, GROUP } from "./lib/species.mjs";

// Dimensions ship as decimetres and tau as percent: integers gzip far better than floats, and
// 0.1 m on a crown is well inside the error of the species estimate that produced it.
const DM = (m) => Math.round(m * 10);
const PCT = (t) => Math.round(t * 100);

export function buildCanopy(trees, bbox, Q) {
  const [minLat, minLon, maxLat, maxLon] = bbox;

  // One row per distinct dimension set, not per species name. The tail of the inventory all
  // resolves to the same four group fallbacks, so 444 species collapse to ~50 rows.
  const rows = [], index = new Map();
  const rowFor = (d) => {
    const k = `${d.h}|${d.cd}|${d.cb}|${d.tau}|${d.dec}`;
    let i = index.get(k);
    if (i === undefined) {
      i = rows.length;
      index.set(k, i);
      rows.push([DM(d.h), DM(d.cd), DM(d.cb), PCT(d.tau), d.dec ? 1 : 0]);
    }
    return i;
  };

  const kept = [];
  const stats = { seen: 0, outside: 0, notATree: 0, bySpecies: 0, byGroup: 0 };
  for (const t of trees) {
    stats.seen++;
    if (t.lat < minLat || t.lat > maxLat || t.lon < minLon || t.lon > maxLon) { stats.outside++; continue; }
    const dims = resolve(t.s, t.g);
    if (!dims) { stats.notATree++; continue; } // `Falta` — an empty pit shades nothing
    if (SPECIES[(t.s || "").trim()]) stats.bySpecies++; else stats.byGroup++;
    kept.push([Math.round(t.lon * Q), Math.round(t.lat * Q), rowFor(dims)]);
  }

  // Z-order, matching what the node column does: neighbours in space become neighbours in
  // index, so the coordinate deltas stay small and the species column runs in streaks (a
  // street is planted with one species, so the tail of it is highly repetitive).
  const morton = (x, y) => {
    let k = 0n; const bx = BigInt(x), by = BigInt(y);
    for (let i = 0n; i < 32n; i++) k |= ((bx >> i) & 1n) << (2n * i) | ((by >> i) & 1n) << (2n * i + 1n);
    return k;
  };
  const ox = Math.round(minLon * Q), oy = Math.round(minLat * Q);
  const key = new Map(kept.map((t) => [t, morton(t[0] - ox, t[1] - oy)]));
  kept.sort((a, b) => (key.get(a) < key.get(b) ? -1 : key.get(a) > key.get(b) ? 1 : 0));

  const tLon = [], tLat = [], tSp = [];
  let px = 0, py = 0;
  for (const [x, y, sp] of kept) {
    tLon.push(x - px); tLat.push(y - py); tSp.push(sp);
    px = x; py = y;
  }

  return {
    tLon, tLat, tSp,
    species: rows,
    tauBare: PCT(TAU_BARE),
    stats: { ...stats, kept: kept.length, rows: rows.length },
  };
}

export { GROUP };
