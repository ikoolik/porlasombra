// Give every Catastro street the name a person would actually type.
//
// Catastro is authoritative for *where* an address is but writes names uppercased, unaccented,
// abbreviated and article-last ("CL ARGENTERS DELS"). OpenStreetMap carries the current official
// name, properly spelled and in Valencian ("Carrer dels Argenters"). Joining the two also buys
// bilingual search for free: "CL IBIZA" resolves to "Carrer d'Eivissa", so either spelling finds
// the street.
//
// The join is spatial — an address point takes the name of the nearest named way — and that is
// only safe with a guard. Where a street is missing from OSM its addresses fall through to the
// *cross* street and would silently adopt its name. Two rules contain that:
//
//   1. A majority of a street's addresses must agree on the winning name.
//   2. One OSM name is claimed by at most one Catastro street, best claim wins. A street that
//      loses its claim keeps its own name rather than borrowing someone else's.
//
// Anything unmatched falls back to the Catastro name, expanded and title-cased. That fallback is
// never *wrong*, only less idiomatic, so a doubtful join is always the worse trade.
import { metres } from "./lib/geo.mjs";

const MATCH_M = 25;      // an address further than this from its street is not evidence
const MIN_SHARE = 0.5;   // fraction of a street's matched addresses that must agree
const CELL = 0.0009;     // ~100 m segment grid

// Catastro's type abbreviations, in the Valencian forms OSM uses locally.
const KIND = {
  CL: "Carrer", AV: "Avinguda", PZ: "Plaça", PL: "Plaça", CM: "Camí", CR: "Carretera",
  PS: "Passeig", PJ: "Passatge", TR: "Travessera", GV: "Gran Via", SD: "Senda",
  BR: "Barri", GR: "Grup", PD: "Partida", LG: "Lloc", VI: "Via", ED: "Edifici",
  EN: "Entrada", SC: "Sector", TN: "Tuneu", RD: "Ronda", CA: "Calçada", MU: "Mur",
};

// Article dragged to the end by Catastro's sort-friendly ordering: "SAFOR LA" is "la Safor".
const TRAILING = new Set(["LA", "EL", "LOS", "LAS", "LES", "ELS", "DEL", "DELS", "DE LA", "DE LES"]);
const LOWER = new Set(["de", "del", "dels", "la", "el", "los", "las", "les", "els", "i", "y", "d'", "l'", "en"]);

const titleCase = (s) =>
  s.toLowerCase().split(/\s+/).filter(Boolean).map((w, i) => {
    if (i > 0 && LOWER.has(w)) return w;
    // Keep the elision attached: "d'alacant" -> "d'Alacant".
    const m = /^([dl]')(.+)$/.exec(w);
    if (m) return m[1] + m[2][0].toUpperCase() + m[2].slice(1);
    return w[0].toUpperCase() + w.slice(1);
  }).join(" ");

export function prettifyCatastro(kind, core) {
  let name = titleCase(core.trim()), lead = "";
  for (const art of TRAILING) {
    if (core.endsWith(" " + art)) {
      // The article leads the name once restored, and stays lowercase there: "la Safor".
      lead = art.toLowerCase() + " ";
      name = titleCase(core.slice(0, -art.length - 1));
      break;
    }
  }
  const k = KIND[kind];
  return k ? `${k} ${lead}${name}` : `${titleCase(kind)} ${lead}${name}`;
}

// Nearest point on a segment, in metres. Works in degrees then converts, which is fine at the
// tens-of-metres scale this is asked about.
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = (dx || dy)
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    : 0;
  return metres(p, [a[0] + t * dx, a[1] + t * dy]);
}

export function joinStreetNames(streets, addrs, ways, nodeCoords) {
  // --- index every named way segment ---
  const segs = [];
  const grid = new Map();
  for (const w of ways) {
    const nm = w.tags.name;
    if (!nm) continue;
    const cs = w.refs.map((r) => nodeCoords.get(r)).filter(Boolean);
    for (let i = 1; i < cs.length; i++) {
      const si = segs.length;
      segs.push([cs[i - 1], cs[i], nm]);
      const x0 = Math.floor(Math.min(cs[i - 1][0], cs[i][0]) / CELL);
      const x1 = Math.floor(Math.max(cs[i - 1][0], cs[i][0]) / CELL);
      const y0 = Math.floor(Math.min(cs[i - 1][1], cs[i][1]) / CELL);
      const y1 = Math.floor(Math.max(cs[i - 1][1], cs[i][1]) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = gx + ":" + gy;
        let c = grid.get(k); if (!c) grid.set(k, c = []);
        c.push(si);
      }
    }
  }

  // --- each address votes for the name of its nearest way ---
  const votes = streets.map(() => new Map()); // osm name -> { n, sumInvD }
  const tally = new Int32Array(streets.length);
  for (const a of addrs) {
    const p = [a.lon, a.lat];
    const gx = Math.floor(a.lon / CELL), gy = Math.floor(a.lat / CELL);
    let best = null, bestD = MATCH_M;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const c = grid.get((gx + dx) + ":" + (gy + dy));
      if (!c) continue;
      for (const si of c) {
        const d = distToSeg(p, segs[si][0], segs[si][1]);
        if (d < bestD) { bestD = d; best = segs[si][2]; }
      }
    }
    if (!best) continue;
    tally[a.s]++;
    const v = votes[a.s];
    let e = v.get(best); if (!e) v.set(best, e = { n: 0, sumInvD: 0 });
    e.n++;
    e.sumInvD += 1 / (1 + bestD);
  }

  // --- one claim per street, then one street per name ---
  const claims = [];
  streets.forEach((s, i) => {
    if (!tally[i]) return;
    let top = null;
    for (const [name, e] of votes[i]) if (!top || e.n > top.e.n) top = { name, e };
    const share = top.e.n / tally[i];
    if (share < MIN_SHARE) return;
    claims.push({ street: i, name: top.name, share, score: top.e.sumInvD });
  });
  // Strongest claim first: more agreeing addresses, sitting closer to the way.
  claims.sort((a, b) => b.score - a.score);

  const takenName = new Set();
  let joined = 0, contested = 0;
  for (const c of claims) {
    if (takenName.has(c.name)) { contested++; continue; }
    takenName.add(c.name);
    streets[c.street].osm = c.name;
    joined++;
  }

  // --- final display name, and the aliases search should also accept ---
  for (const s of streets) {
    s.display = s.osm || prettifyCatastro(s.kind, s.core);
    // The Catastro spelling stays searchable either way — it is what appears on older paperwork,
    // and it is the Spanish name where OSM gives the Valencian one.
    s.alias = s.osm ? prettifyCatastro(s.kind, s.core) : null;
  }

  return {
    stats: {
      streets: streets.length,
      voted: claims.length,
      joined,
      contested,
      fallback: streets.length - joined,
    },
  };
}
