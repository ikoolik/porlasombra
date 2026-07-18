// Geometry shared by the build steps. Mirrors the maths in index.html so the precomputed
// graph is identical to what the browser used to build at query time.
import proj4 from "proj4";

// Catastro publishes in ETRS89 / UTM zone 30N. ETRS89 and WGS84 differ by a few centimetres,
// which is far below the 0.1 m accuracy the cadastre itself claims, so we treat them as equal.
proj4.defs("EPSG:25830", "+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
const utm30nToWgs84 = proj4("EPSG:25830", "EPSG:4326");
export const toWgs84 = (x, y) => utm30nToWgs84.forward([x, y]);

const R = 6371000, toRad = Math.PI / 180;

export function metres(a, b) {
  const dx = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * toRad) * 111320;
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

export function bearingOf(a, b) {
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x = Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
            Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function offsetCoord(c, d, brg) {
  const dx = d * Math.sin(brg * toRad), dy = d * Math.cos(brg * toRad);
  return [c[0] + (dx / R) * (180 / Math.PI) / Math.cos(c[1] * toRad),
          c[1] + (dy / R) * (180 / Math.PI)];
}

// Circular mean, so a vertex between two segments offsets along the corner bisector.
export function meanBearing(bs) {
  let x = 0, y = 0;
  for (const b of bs) { x += Math.cos(b * toRad); y += Math.sin(b * toRad); }
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export const FOOT_WAYS = new Set(
  ["footway", "path", "steps", "pedestrian", "cycleway", "track", "living_street", "corridor"]);
export const ROAD_RE =
  /^(residential|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|service|road)$/;

export function isWalkable(tags) {
  if (tags.foot === "no" || tags.access === "private" || tags.access === "no") return false;
  const hw = tags.highway;
  return FOOT_WAYS.has(hw) || ROAD_RE.test(hw);
}

// Which sides of a way a pedestrian can actually be on.
export function sidesFor(tags) {
  if (FOOT_WAYS.has(tags.highway)) return ["C"];
  const sw = (tags.sidewalk || tags["sidewalk:both"] || "").toLowerCase();
  if (sw === "no" || sw === "none") return ["C"];
  if (sw === "left") return ["L"];
  if (sw === "right") return ["R"];
  return ["L", "R"];
}

// Distance from the centreline out to where a pedestrian walks.
export function sideOffsetM(tags) {
  if (FOOT_WAYS.has(tags.highway)) return 0;
  let w = parseFloat(tags.width);
  if (isNaN(w)) {
    const lanes = parseFloat(tags.lanes);
    w = !isNaN(lanes) ? lanes * 3.2 : 7;
  }
  return Math.min(Math.max(w / 2 + 1.5, 3), 15);
}
