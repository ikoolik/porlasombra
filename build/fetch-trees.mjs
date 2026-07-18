// Valencia municipal tree inventory -> data/trees.json
//
// The Ajuntament publishes the inventory as an ArcGIS REST layer. 158,710 trees across the
// whole municipality, of which 97% fall inside the project bbox. Licence is CC BY 4.0
// (Ajuntament de València, Servicio de Parques y Jardines), updated annually — so this is an
// attribution line, not a constraint, and it wants re-running about as often as the cadastre.
//
// Why this and not OpenStreetMap. OSM has 65,777 trees in the same bbox and 86% of them have a
// municipal counterpart, so the two largely agree on *position* — but OSM carries `height` on
// 0.6% and `diameter_crown` on 0.5%, and that tagged minority is a biased sample of protected
// monumental specimens (median 15 m, where a Valencia street tree is nearer 6-10 m). The
// municipal set is 2.2x larger and carries species on every record, which is the only thing
// either source offers that leads to a dimension. Unioning the two would add ~9k OSM-only
// trees at the price of a dedup threshold that is visibly fuzzy — matches run 49% at 2 m and
// 82% at 5 m, so the middle is survey offset rather than distinct trees. Not worth it.
//
// The server caps a page at 2,000 rows (maxRecordCount) and pages with resultOffset. Asking for
// outSR=4326 gets WGS84 straight out, so nothing here needs to know about EPSG:25830.
import fs from "node:fs";
import path from "node:path";

const LAYER = "https://geoportal.valencia.es/server/rest/services/OPENDATA/MedioAmbiente/MapServer/151";
const PAGE = 2000;
const RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(offset) {
  const url = `${LAYER}/query?where=1%3D1&outFields=nom_botanico,grupo,tipo_situacion` +
              `&outSR=4326&f=json&resultOffset=${offset}&resultRecordCount=${PAGE}`;
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // ArcGIS reports failures in a 200 body, so this has to be checked explicitly.
      if (json.error) throw new Error(`ArcGIS ${json.error.code}: ${json.error.message}`);
      return json.features || [];
    } catch (err) {
      last = err;
      if (attempt < RETRIES) await sleep(1500 * attempt); // 80 pages over one endpoint: back off
    }
  }
  throw new Error(`page at offset ${offset} failed after ${RETRIES} tries: ${last.message}`);
}

export async function fetchTrees(outPath) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const feats = await getPage(offset);
    for (const f of feats) {
      const g = f.geometry;
      if (!g || g.x == null || g.y == null) continue;
      out.push({
        lon: +g.x.toFixed(6),
        lat: +g.y.toFixed(6),
        s: f.attributes.nom_botanico,
        g: f.attributes.grupo,
        t: f.attributes.tipo_situacion,
      });
    }
    process.stdout.write(`\r  ${out.length} trees`);
    if (feats.length < PAGE) break;
  }
  process.stdout.write("\n");
  if (out.length < 100000) throw new Error(`only ${out.length} trees — the layer returned short`);
  fs.writeFileSync(outPath, JSON.stringify(out));
  return out.length;
}

if (import.meta.filename === process.argv[1]) {
  const out = process.argv[2] || path.join(import.meta.dirname, "../data/trees.json");
  console.log("→ trees (Ajuntament de València, CC BY 4.0)");
  const n = await fetchTrees(out);
  console.log(`✓ ${n} trees -> ${path.basename(out)}`);
}
