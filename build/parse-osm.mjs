// osmium OPL -> { nodes: Map(id -> [lon,lat]), ways: [{id, tags, refs}] }
//
// OPL rather than GeoJSON because we need the node *ids*: two ways are connected only when
// they share one, and that is what the junction/crossing edges are built from. `osmium export`
// resolves geometry and throws the ids away.
import fs from "node:fs";
import readline from "node:readline";
import { isWalkable } from "./lib/geo.mjs";

// OPL escapes non-trivial characters as %<hex>% .
const unesc = (s) => s.includes("%") ? s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16))) : s;

function parseTags(field) {
  const tags = {};
  if (!field) return tags;
  for (const kv of field.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) tags[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1));
  }
  return tags;
}

export async function parseOpl(oplPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(oplPath, { encoding: "utf8", highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });

  const nodes = new Map();
  const ways = [];
  let wayTotal = 0;

  for await (const line of rl) {
    const type = line[0];
    if (type !== "n" && type !== "w") continue;

    // Fields are space separated and prefixed by a letter; tags (T) may contain spaces only
    // when escaped, so a plain split is safe.
    const parts = line.split(" ");
    if (type === "n") {
      let lon, lat;
      for (const p of parts) {
        if (p[0] === "x") lon = parseFloat(p.slice(1));
        else if (p[0] === "y") lat = parseFloat(p.slice(1));
      }
      if (Number.isFinite(lon) && Number.isFinite(lat)) nodes.set(parts[0].slice(1), [lon, lat]);
    } else {
      wayTotal++;
      let tags = null, refs = null;
      for (const p of parts) {
        if (p[0] === "T") tags = parseTags(p.slice(1));
        else if (p[0] === "N") refs = p.slice(1).split(",").map((r) => r.slice(1));
      }
      if (!tags || !refs || refs.length < 2) continue;
      if (!isWalkable(tags)) continue;
      ways.push({ id: parts[0].slice(1), tags, refs });
    }
  }
  return { nodes, ways, wayTotal };
}
