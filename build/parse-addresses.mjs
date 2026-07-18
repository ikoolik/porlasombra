// Catastro INSPIRE Addresses GML -> { streets: [{ id, raw, kind, core }], addrs: [{ s, n, lon, lat }]
//
// Every address is an *entrance* point: the door, not the building centroid, which is exactly
// what a walking router wants to snap to. Each one xlinks a ThoroughfareName feature carried at
// the end of the same file, so street names resolve in a second pass over a small table.
//
// Catastro writes names uppercased, unaccented, abbreviated and with the article postposed
// ("CL ARGENTERS DELS"), so they are good for *matching* and poor for *display* — build.mjs
// joins each street to its OpenStreetMap counterpart for a name worth showing.
import fs from "node:fs";
import readline from "node:readline";
import { toWgs84 } from "./lib/geo.mjs";

// The file declares ISO-8859-1. The names carry no accents today, but decoding correctly costs
// nothing and stops a future accented name arriving as mojibake.
const ENCODING = "latin1";

const TN_REF = /#ES\.SDGC\.TN\.46\.900\.(\d+)/;
const TN_ID = /<AD:ThoroughfareName gml:id="ES\.SDGC\.TN\.46\.900\.(\d+)"/;
const POS = /<gml:pos>([-\d.]+)\s+([-\d.]+)<\/gml:pos>/;
const DESIGNATOR = /<AD:designator>([^<]*)<\/AD:designator>/;
const GN_TEXT = /<GN:text>([^<]*)<\/GN:text>/;

export async function parseAddresses(gmlPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(gmlPath, { encoding: ENCODING, highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });

  const addrs = [];
  const names = new Map(); // tn id -> raw Catastro name

  // One address feature at a time: position and designator arrive before the component xlink
  // that names the street, so hold them until the feature closes.
  let x = null, y = null, num = null, tn = null;
  let inTn = null; // id of the ThoroughfareName feature being read, if any

  let seen = 0, noStreet = 0, noPos = 0;

  for await (const line of rl) {
    if (inTn !== null) {
      const t = GN_TEXT.exec(line);
      if (t) { names.set(inTn, t[1].trim()); inTn = null; }
      continue;
    }

    if (line.includes("<AD:Address ")) { x = y = num = tn = null; seen++; continue; }

    const tnStart = TN_ID.exec(line);
    if (tnStart) { inTn = tnStart[1]; continue; }

    if (line.includes("<gml:pos>")) {
      const p = POS.exec(line);
      // Addresses are published in ETRS89 / UTM 30N, same as the buildings.
      if (p) { x = parseFloat(p[1]); y = parseFloat(p[2]); }
      continue;
    }
    if (line.includes("<AD:designator>")) {
      const d = DESIGNATOR.exec(line);
      if (d) num = d[1].trim();
      continue;
    }
    if (line.includes("<AD:component")) {
      const r = TN_REF.exec(line);
      if (r) tn = r[1];
      continue;
    }
    if (line.includes("</AD:Address>")) {
      if (!tn) { noStreet++; continue; }
      if (x === null || y === null) { noPos++; continue; }
      const [lon, lat] = toWgs84(x, y);
      addrs.push({ tn, n: num || "", lon, lat });
    }
  }

  // Only streets that actually carry an address are worth shipping.
  const used = new Map();
  const streets = [];
  for (const a of addrs) {
    let idx = used.get(a.tn);
    if (idx === undefined) {
      const raw = names.get(a.tn) || "";
      const sp = raw.indexOf(" ");
      used.set(a.tn, idx = streets.length);
      streets.push({
        id: a.tn,
        raw,
        kind: sp > 0 ? raw.slice(0, sp) : "",   // CL, AV, PZ, ...
        core: sp > 0 ? raw.slice(sp + 1) : raw, // "ARGENTERS DELS"
      });
    }
    a.s = idx;
    delete a.tn;
  }

  return { streets, addrs, stats: { seen, noStreet, noPos, named: names.size } };
}
