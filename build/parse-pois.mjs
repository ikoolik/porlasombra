// Named landmarks from OpenStreetMap -> [{ name, alias, cat, lon, lat }]
//
// Input is osmium's GeoJSON-seq export, which resolves ways and multipolygon relations into real
// geometries — a park or a market hall is an area, and re-deriving that from raw node refs is
// work osmium already does correctly.
//
// The filtering is the point of this file. 10,712 named features pass the tag filter, and most
// would make the search worse: 1,196 restaurants, a bus platform tagged `Bioparc`, and six things
// called "Estació del Nord" of which one is the station. What ships is a curated set of places
// people actually walk *to*, deduplicated so a landmark appears once.
import { normalizeName } from "./lib/geo.mjs";

// Category -> [label shown in the results, rank]. Rank breaks ties when several features share a
// name: the station outranks the bus platform named after it. It also orders search results, so
// a park beats a dentist named after the park.
const CATS = {
  "amenity=marketplace":        ["Market", 9],
  "amenity=hospital":           ["Hospital", 8],
  "amenity=university":         ["University", 8],
  "amenity=college":            ["College", 7],
  "amenity=theatre":            ["Theatre", 7],
  "amenity=cinema":             ["Cinema", 6],
  "amenity=library":            ["Library", 6],
  "amenity=arts_centre":        ["Arts centre", 6],
  "amenity=place_of_worship":   ["Place of worship", 6],
  "amenity=townhall":           ["Town hall", 8],
  "amenity=courthouse":         ["Courthouse", 6],
  "amenity=conference_centre":  ["Conference centre", 6],
  "amenity=community_centre":   ["Community centre", 5],
  "amenity=bus_station":        ["Bus station", 8],
  "amenity=ferry_terminal":     ["Ferry terminal", 8],
  "amenity=school":             ["School", 5],
  "tourism=attraction":         ["Attraction", 9],
  "tourism=museum":             ["Museum", 9],
  "tourism=zoo":                ["Zoo", 9],
  "tourism=aquarium":           ["Aquarium", 9],
  "tourism=theme_park":         ["Theme park", 8],
  "tourism=gallery":            ["Gallery", 6],
  "tourism=viewpoint":          ["Viewpoint", 5],
  "leisure=park":               ["Park", 8],
  "leisure=garden":             ["Garden", 6],
  "leisure=nature_reserve":     ["Nature reserve", 7],
  "leisure=stadium":            ["Stadium", 8],
  "leisure=sports_centre":      ["Sports centre", 5],
  "leisure=marina":             ["Marina", 6],
  "leisure=beach_resort":       ["Beach", 7],
  "natural=beach":              ["Beach", 8],
  "place=square":               ["Square", 7],
  "place=neighbourhood":        ["Neighbourhood", 6],
  "place=suburb":               ["District", 7],
  "place=quarter":              ["Quarter", 6],
  "shop=mall":                  ["Shopping centre", 7],
  "shop=department_store":      ["Department store", 6],
  "office=government":          ["Government office", 5],
  "aeroway=terminal":           ["Terminal", 8],
  // Transport deliberately ranks below the venues, because stops are named *after* the place
  // they serve: the tram stop "Estadi Ciutat de València" and the stadium are 200 m apart and
  // share a name, and it is the stadium somebody is looking for.
  "railway=station":            ["Station", 8],
  "railway=halt":               ["Station", 6],
  "railway=tram_stop":          ["Tram stop", 3],
  "public_transport=station":   ["Station", 7],
  "historic=castle":            ["Castle", 8],
  "historic=monument":          ["Monument", 7],
  "historic=memorial":          ["Memorial", 5],
  "historic=ruins":             ["Ruins", 6],
  "historic=city_gate":         ["City gate", 7],
  "historic=tower":             ["Tower", 6],
};

// Checked in order, so a feature tagged both `tourism=attraction` and `leisure=park` is whichever
// of the two ranks higher rather than whichever key is looked at first.
const KEYS = ["tourism", "amenity", "leisure", "historic", "natural", "railway",
              "public_transport", "place", "shop", "office", "aeroway"];

const DEDUPE_M = 400; // two same-named features closer than this are one place, tagged twice

// Area-weighted centroid of a ring. A park's label belongs in the middle of it, and for the
// long thin ones (the Túria) any vertex would be a worse answer than the middle.
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) { // degenerate ring: fall back to the mean vertex
    let x = 0, y = 0;
    for (const p of ring) { x += p[0]; y += p[1]; }
    return [x / ring.length, y / ring.length, 0];
  }
  return [cx / (3 * a), cy / (3 * a), Math.abs(a / 2)];
}

function positionOf(geom) {
  if (!geom) return null;
  if (geom.type === "Point") return geom.coordinates;
  const polys = geom.type === "Polygon" ? [geom.coordinates]
              : geom.type === "MultiPolygon" ? geom.coordinates : null;
  if (!polys) return null;
  // Largest outer ring: a multipolygon's small satellite parts should not move the label.
  let best = null, bestA = -1;
  for (const rings of polys) {
    if (!rings || !rings[0] || rings[0].length < 3) continue;
    const [x, y, area] = ringCentroid(rings[0]);
    if (area > bestA) { bestA = area; best = [x, y]; }
  }
  return best;
}

const metresApart = (a, b) => {
  const dx = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * 111320;
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
};

export function parsePois(text, bbox) {
  const [S, W, N, E] = bbox;
  const out = [];
  const stats = { seen: 0, named: 0, categorised: 0, outside: 0, merged: 0 };

  for (const line of text.split("\n")) {
    const s = line.replace(/^\x1e/, "").trim(); // geojsonseq record separator
    if (!s) continue;
    stats.seen++;
    let f;
    try { f = JSON.parse(s); } catch { continue; }
    const p = f.properties || {};
    const name = p.name;
    if (!name) continue;
    stats.named++;

    let cat = null, rank = -1, label = null;
    for (const k of KEYS) {
      const hit = CATS[`${k}=${p[k]}`];
      if (hit && hit[1] > rank) { label = hit[0]; rank = hit[1]; cat = `${k}=${p[k]}`; }
    }
    if (!cat) continue;
    stats.categorised++;

    const pos = positionOf(f.geometry);
    if (!pos) continue;
    const [lon, lat] = pos;
    if (lat < S || lat > N || lon < W || lon > E) { stats.outside++; continue; }

    // Valencia labels bilingually and half its landmarks are known by an acronym, so *every*
    // distinct spelling is kept as a searchable alias rather than just the first one — the museum
    // displayed as "Institut Valencià d'Art Modern" is the one everybody calls the IVAM.
    const seen = new Set([normalizeName(name)]);
    const alts = [];
    for (const v of [p["name:es"], p["name:ca"], p["name:en"], p.alt_name, p.short_name, p.official_name]) {
      if (!v) continue;
      const k = normalizeName(v);
      if (seen.has(k)) continue;
      seen.add(k);
      alts.push(v);
    }
    const alt = alts.join(" / ") || null;

    out.push({ name, alias: alt, label, rank, lon, lat, key: normalizeName(name) });
  }

  // Same name, near enough to be the same place: keep the best-ranked one. This is what collapses
  // the station, its platforms and its tourist-information point into a single "Estació del Nord".
  out.sort((a, b) => b.rank - a.rank);
  const kept = [];
  const byName = new Map();
  for (const poi of out) {
    const near = byName.get(poi.key);
    if (near && near.some((k) => metresApart([k.lon, k.lat], [poi.lon, poi.lat]) < DEDUPE_M)) {
      stats.merged++;
      continue;
    }
    kept.push(poi);
    if (near) near.push(poi); else byName.set(poi.key, [poi]);
  }
  stats.kept = kept.length;
  return { pois: kept, stats };
}
