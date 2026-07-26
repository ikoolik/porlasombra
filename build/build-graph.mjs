// Sidewalk graph: every road becomes a left and a right pavement chain, joined at shared OSM
// nodes by penalised crossing edges. Same construction the browser used to do per query — moved
// here because offline we can afford to check the result, which is how the fragmentation that
// made routing fail half the time gets found and repaired.
import { metres, bearingOf, offsetCoord, meanBearing, sidesFor, sideOffsetM } from "./lib/geo.mjs";

export const CROSS_PENALTY_M = 18; // crossing a road / cutting a corner at a junction
export const JUNCTION_LINK_M = 45; // max distance to link two side-nodes sharing an OSM node
export const STITCH_M = 12;        // max gap to weld two otherwise-disconnected components
export const LOCAL_WELD_M = 4;     // max gap to weld two pavement chains that (nearly) touch,
                                   // regardless of component — see weldLocal. Kept below the 6 m
                                   // minimum gap between a street's two sidewalks (2 × the 3 m
                                   // minimum offset), so it never bridges opposite pavements.

export function buildGraph(ways, nodeCoords) {
  const nodes = [];              // { coord, osmId }
  const adj = [];
  const byOsmNode = new Map();

  const addNode = (coord, osmId) => {
    const i = nodes.length;
    nodes.push({ coord, osmId });
    adj.push([]);
    let g = byOsmNode.get(osmId); if (!g) byOsmNode.set(osmId, g = []);
    g.push(i);
    return i;
  };
  const addEdge = (a, b, pen) => {
    const len = metres(nodes[a].coord, nodes[b].coord);
    if (len === 0) return;
    adj[a].push({ to: b, len, pen });
    adj[b].push({ to: a, len, pen });
  };

  for (const way of ways) {
    const coords = [], ids = [];
    for (const ref of way.refs) {
      const c = nodeCoords.get(ref);
      if (c) { coords.push(c); ids.push(ref); }
    }
    if (coords.length < 2) continue;

    const sides = sidesFor(way.tags);
    const off = sideOffsetM(way.tags);
    const vertBearing = coords.map((c, i) => {
      const bs = [];
      if (i > 0) bs.push(bearingOf(coords[i - 1], c));
      if (i < coords.length - 1) bs.push(bearingOf(c, coords[i + 1]));
      return meanBearing(bs);
    });

    for (const side of sides) {
      const delta = side === "L" ? -90 : side === "R" ? 90 : 0;
      let prev = null;
      for (let i = 0; i < coords.length; i++) {
        const coord = off === 0 ? coords[i] : offsetCoord(coords[i], off, vertBearing[i] + delta);
        const idx = addNode(coord, ids[i]);
        if (prev !== null) addEdge(prev, idx, 0);
        prev = idx;
      }
    }
  }

  for (const group of byOsmNode.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        if (metres(nodes[group[i]].coord, nodes[group[j]].coord) > JUNCTION_LINK_M) continue;
        addEdge(group[i], group[j], CROSS_PENALTY_M);
      }
  }

  return { nodes, adj, addEdge };
}

// Close the grid. Two pavement chains often meet at (nearly) the same point — a shared corner
// split across the L/R chains of crossing streets, a footway touching a kerb — yet were never
// linked because the two OSM ways don't share a node id there, so `byOsmNode` above never saw
// them as one junction. stitch() below would weld them, but only across *components*; once
// junction-linking has already pulled the network into one big component those touch points stay
// open, and the interior then routes like a tree — a 400 m hop can walk 2 km around the block.
// This welds them whatever component they are in. A coincident pair (< 1 m) is literally the same
// place, so the step costs nothing; a short reach across a corner pays the crossing penalty, so
// the router only takes it when it genuinely shortens the walk. Added directly rather than via
// addEdge because addEdge drops zero-length edges — and the coincident pairs are the ones that
// matter most.
export function weldLocal(graph) {
  const CELL = 0.00018; // ~20 m, same grid as stitch
  const grid = new Map();
  graph.nodes.forEach((nd, i) => {
    const k = Math.floor(nd.coord[0] / CELL) + ":" + Math.floor(nd.coord[1] / CELL);
    let c = grid.get(k); if (!c) grid.set(k, c = []);
    c.push(i);
  });

  let welds = 0;
  for (let i = 0; i < graph.nodes.length; i++) {
    const [lon, lat] = graph.nodes[i].coord;
    const gx = Math.floor(lon / CELL), gy = Math.floor(lat / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get((gx + dx) + ":" + (gy + dy));
      if (!cell) continue;
      for (const j of cell) {
        if (j <= i) continue; // each undirected pair once
        const d = metres(graph.nodes[i].coord, graph.nodes[j].coord);
        if (d > LOCAL_WELD_M) continue;
        if (graph.adj[i].some((e) => e.to === j)) continue; // already linked
        const pen = d < 1 ? 0 : CROSS_PENALTY_M;
        graph.adj[i].push({ to: j, len: d, pen });
        graph.adj[j].push({ to: i, len: d, pen });
        welds++;
      }
    }
  }
  return welds;
}

// ---------- connectivity ----------
export function components(graph) {
  const n = graph.nodes.length;
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    const stack = [s]; comp[s] = id;
    while (stack.length) {
      const u = stack.pop(); count++;
      for (const e of graph.adj[u]) if (comp[e.to] < 0) { comp[e.to] = id; stack.push(e.to); }
    }
    sizes.push(count);
  }
  return { comp, sizes };
}

// Weld components that are geometrically adjacent but topologically separate. These are almost
// all artefacts of our own construction (a pavement chain offset away from the centreline it
// shares a junction with) rather than real gaps in the street network.
export function stitch(graph, comp, compCount) {
  const CELL = 0.00018; // ~20 m
  const grid = new Map();
  graph.nodes.forEach((nd, i) => {
    const k = Math.floor(nd.coord[0] / CELL) + ":" + Math.floor(nd.coord[1] / CELL);
    let c = grid.get(k); if (!c) grid.set(k, c = []);
    c.push(i);
  });

  // Union-find over *component ids*, not node ids — so it must be identity-initialised over
  // the component count, not seeded from comp[].
  const parent = new Int32Array(compCount);
  for (let i = 0; i < compCount; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };

  let welds = 0;
  for (let i = 0; i < graph.nodes.length; i++) {
    const [lon, lat] = graph.nodes[i].coord;
    const gx = Math.floor(lon / CELL), gy = Math.floor(lat / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get((gx + dx) + ":" + (gy + dy));
      if (!cell) continue;
      for (const j of cell) {
        if (j <= i) continue;
        if (find(comp[i]) === find(comp[j])) continue;
        if (metres(graph.nodes[i].coord, graph.nodes[j].coord) > STITCH_M) continue;
        graph.addEdge(i, j, CROSS_PENALTY_M);
        parent[find(comp[i])] = find(comp[j]);
        welds++;
      }
    }
  }
  return welds;
}
