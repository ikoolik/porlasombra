// Catastro INSPIRE buildingpart.gml -> compact building prisms (ring + floor count).
//
// Two things matter here and both are easy to get wrong:
//   * It must be the *buildingpart* layer. In building.gml numberOfFloorsAboveGround is
//     xsi:nil "unpopulated" — the spec is explicit that the figure only exists on BuildingPart.
//   * Parts, not buildings, are what we want anyway: a tower on a retail podium is two parts
//     with different floor counts, which a single OSM footprint cannot express.
//
// The file is ~536 MB of ISO-8859-1 XML, so this streams and never holds the document.
import fs from "node:fs";
import readline from "node:readline";
import { toWgs84 } from "./lib/geo.mjs";

const FLOOR_HEIGHT_M = 3; // the cadastre's own assumption for its heightBelowGround estimate

export async function parseCatastro(gmlPath, bbox, outPath) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const stream = fs.createReadStream(gmlPath, { encoding: "latin1", highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const out = [];
  let buf = "", inFeature = false;
  let seen = 0, kept = 0, noFloors = 0, outside = 0, degenerate = 0;

  const flush = (block) => {
    seen++;
    // First exterior ring only; interior rings (courtyards) don't change the shadow hull.
    const pos = /<gml:exterior>\s*<gml:LinearRing>\s*<gml:posList[^>]*>([^<]+)</.exec(block);
    if (!pos) { degenerate++; return; }
    const fl = /<bu-ext2d:numberOfFloorsAboveGround>(\d+)</.exec(block);
    if (!fl) { noFloors++; return; }
    const floors = +fl[1];
    if (!floors) { noFloors++; return; }

    const nums = pos[1].trim().split(/\s+/).map(Number);
    const ring = [];
    let inBox = false;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const [lon, lat] = toWgs84(nums[i], nums[i + 1]);
      ring.push([+lon.toFixed(6), +lat.toFixed(6)]);
      if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) inBox = true;
    }
    if (ring.length < 4) { degenerate++; return; }
    if (!inBox) { outside++; return; }
    out.push({ r: ring, h: floors * FLOOR_HEIGHT_M });
    kept++;
  };

  for await (const line of rl) {
    if (!inFeature) {
      if (line.includes("<gml:featureMember>")) { inFeature = true; buf = line; }
      continue;
    }
    buf += line;
    if (line.includes("</gml:featureMember>")) { flush(buf); inFeature = false; buf = ""; }
  }

  fs.writeFileSync(outPath, JSON.stringify(out));
  return { seen, kept, noFloors, outside, degenerate };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [gml, out] = process.argv.slice(2);
  const bbox = [39.42, -0.42, 39.51, -0.32];
  console.time("catastro");
  const stats = await parseCatastro(gml, bbox, out);
  console.timeEnd("catastro");
  console.log(stats);
}
