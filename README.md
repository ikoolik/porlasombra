# por la sombra

Find the **shadiest walking route** across Valencia — including **which side of the street** to walk on.

In a Valencian July the sunny pavement and the shaded one are different weather. This works out which is which, for any date and time, and routes you along the shade.

**→ [porlasombra.pages.dev](https://porlasombra.pages.dev)**

![Building shadows over central Valencia at 17:00, with the shadiest route in green and its sun-exposed segments in yellow](docs/screenshot.webp)

## How it works

Building shadows are computed from real footprints and heights, and the router searches a graph where every street has a **left and a right pavement** as separate places you can be. Crossing the road costs you, so it only happens when the shade is worth it.

Edge cost is:

```
(length + crossing_penalty) × (1 + α × sun_exposure)
```

where **α** is the shade-preference slider. At α = 0 you get the plain shortest path; at α = 1 a sunny metre costs the same as two shaded ones. It runs A\* twice — once at α = 0, once at your α — so you can see the trade-off.

Because every edge costs at least its own length, straight-line distance to the target never overestimates the remaining cost, so A\* returns the exact optimum, not an approximation.

## Architecture

Nothing is computed on a server. There is no server.

```
Build (occasional)                          Browser (every query)
──────────────────                          ─────────────────────
Catastro buildingpart.gml ─┐
                           ├─→ 5.5 MB  ──→  load once, decode
OSM extract ─ osmium ──────┘   artifact      ↓
                                            shadows for the corridor
                                             ↓
                                            A* ×2, lazy sun sampling
                                             ↓
                                            draw (WebGL, per pixel)
```

The whole city — 277,651 sidewalk nodes, 436,804 edges and 196,676 building parts — is baked offline into one 5.5 MB gzipped file. The browser fetches it once and does everything else locally: no API keys, no routing service, no per-request cost. Hosting is a static file on a CDN.

### Why the build step exists

An earlier version fetched OpenStreetMap live via Overpass on every query and built the graph in the browser. It was slow and it failed outright much of the time. Moving that offline fixed three things at once:

| | Live Overpass | Precomputed |
|---|---|---|
| Graph connectivity | 1,303 components, largest **43%** | largest **93.4%** |
| Building heights | 56% a hardcoded 8 m guess | **99.8%** real floor counts |
| Network calls per query | 1 (often failing) | **0** |

The connectivity number is the interesting one. A sidewalk graph shatters because left/right pavement chains get offset away from the centreline they share a junction with — so the router would snap your start point onto an isolated two-node stub and correctly report "no route". Offline there's time to detect that and weld components within 12 m of each other.

### How the shade is drawn

Shade is a property of a *place*, not of a building, so it is computed per pixel rather than per footprint:

1. Every footprint near the view is rasterised into an off-screen height field, blended with `MAX` so overlapping parts of the same building resolve to the tallest.
2. One fullscreen shader marches a ray from each pixel back along the sun's azimuth. The ray climbs `tan(altitude)` metres for every metre it travels; the pixel is in shade the moment it passes under something taller.

Nothing is precomputed or shipped — the height field is rasterised on demand from the rings already in the artifact, at display resolution, so the shade is exactly as sharp as the screen at any zoom.

The point is the cost model. The old renderer built a convex hull per building and filled a path per shadow, which cost tens of milliseconds for a dense viewport and forced a 120 ms debounce on the time slider and 200 ms on pan. Marching pixels costs the same whether the view holds 200 buildings or 20,000, so the debounces are gone: the shade tracks the map and the time slider at 60 fps.

WebGL is not a hard requirement — without it the app falls back to the old 2D renderer, which costs nothing to keep because the router builds those hulls for its own use anyway.

## Building the data

```bash
brew install osmium-tool
cd build && npm install && make
```

Downloads ~170 MB of source data and produces `data/valencia.json.gz`. A couple of minutes; rerun quarterly.

> On macOS the Makefile points `curl` at Homebrew's CA bundle — the system one lacks the Spanish FNMT root that the Cadastre's certificate chains to.

## Running it

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` — the app expects `data/valencia.json.gz` to exist.

## Data sources

| | Source | Licence |
|---|---|---|
| Building footprints **and heights** | [Spanish Cadastre](https://www.catastro.hacienda.gob.es/webinspire/index_eng.html) (INSPIRE `buildingpart`) | Free reuse, attribution to Dirección General del Catastro |
| Walkable street network | OpenStreetMap via [Geofabrik](https://download.geofabrik.de/) | ODbL |
| Sun position | [SunCalc](https://github.com/mourner/suncalc) 1.9.0 | BSD-2-Clause |
| Map tiles | OpenStreetMap | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/) |

**Use `buildingpart`, not `building`** — in the `building` layer `numberOfFloorsAboveGround` is nil, and the spec is explicit that the figure only exists on `BuildingPart`. Parts are what you want anyway: a tower on a retail podium is two prisms with different heights, which a single footprint cannot express.

Why the Cadastre rather than OSM heights? Measured across central Valencia, 8 of 5,978 OSM buildings carried an explicit `height` tag and 44% had `building:levels` — leaving **56% of the city casting a shadow computed from a guess**. The Cadastre has floor counts for 99.8% of 214,368 parts.

## Known limitations

- Buildings are flat-topped prisms, not a 3D model: no roof shapes, no terrain, no reflected light.
- The drawn shade is a GPU ray march per pixel; the **routing** shade is still a point-in-polygon test against convex hulls of the projected footprints, which slightly over-covers concave buildings. The two agree on ~99.8% of pixels away from shadow edges.
- Height is floors × 3 m. The Cadastre publishes no true above-ground height in metres, so this is better *coverage*, not better precision.
- No **tree canopy** — a significant shade source in Valencia.
- One sun position for the whole view (fine at city scale).
- Pavement offsets are synthesised from road width, not surveyed sidewalk geometry.
- **Valencia only.** Anywhere outside the precomputed bounding box has no data.

## Licence

Code is [MIT](LICENSE). The data it builds from is not mine to relicense — see the table above.
