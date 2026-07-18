# Precompute the Valencia shade-routing artifact.
#   make          - full pipeline (downloads if needed)
#   make clean    - drop derived files, keep downloads
#   make distclean- drop everything
#
# macOS note: system curl lacks the Spanish FNMT root that catastro.hacienda.gob.es chains to,
# so we point it at Homebrew's CA bundle.
DATA    := ../data
CA      := /opt/homebrew/etc/ca-certificates/cert.pem
BBOX    := -0.42,39.42,-0.32,39.51
PBF     := $(DATA)/valencia-latest.osm.pbf
CATZIP  := $(DATA)/catastro-46900.zip
GML     := $(DATA)/A.ES.SDGC.BU.46900.buildingpart.gml
ADZIP   := $(DATA)/catastro-ad-46900.zip
ADGML   := $(DATA)/A.ES.SDGC.AD.46900.gml
OPL     := $(DATA)/walkable.opl
POIS    := $(DATA)/pois.geojsonseq
BLD     := $(DATA)/buildings.json
TREES   := $(DATA)/trees.json
OUT     := $(DATA)/valencia.json.gz

WALKABLE := footway,path,steps,pedestrian,cycleway,track,living_street,corridor,\
residential,unclassified,tertiary,tertiary_link,secondary,secondary_link,\
primary,primary_link,service,road

all: $(OUT)

$(DATA):
	mkdir -p $(DATA)

# --- streets: OpenStreetMap via Geofabrik ---
$(PBF): | $(DATA)
	curl -sSL -o $@ https://download.geofabrik.de/europe/spain/valencia-latest.osm.pbf

$(OPL): $(PBF)
	osmium extract -b $(BBOX) $< -o $(DATA)/city.osm.pbf --overwrite
	osmium tags-filter $(DATA)/city.osm.pbf w/highway=$(WALKABLE) -o $(DATA)/walkable.osm.pbf --overwrite
	osmium cat $(DATA)/walkable.osm.pbf -o $@ --overwrite

# --- landmarks: named places from the same OSM extract ---
# Filtered broadly by key here and curated by category in parse-pois.mjs, where the choice of what
# counts as a landmark is readable. `export` is what resolves ways and multipolygon relations into
# geometries, so a park or a market hall arrives as an area rather than a bag of node refs.
POI_KEYS := nwr/amenity nwr/tourism nwr/leisure nwr/historic nwr/natural=beach \
nwr/public_transport nwr/railway nwr/place nwr/office nwr/aeroway nwr/shop=mall,department_store

$(POIS): $(OPL)
	osmium tags-filter $(DATA)/city.osm.pbf $(POI_KEYS) -o $(DATA)/pois.osm.pbf --overwrite
	osmium export $(DATA)/pois.osm.pbf -f geojsonseq --geometry-types=point,polygon \
	  -o $@ --overwrite

# --- buildings: Spanish Cadastre (INSPIRE) ---
$(CATZIP): | $(DATA)
	curl -sSL --cacert $(CA) -o $@ \
	  https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/46/46900-VALENCIA/A.ES.SDGC.BU.46900.zip

$(GML): $(CATZIP)
	unzip -o -q $< -d $(DATA)
	touch $@

$(BLD): $(GML) parse-catastro.mjs lib/geo.mjs
	node parse-catastro.mjs $(GML) $@

# --- addresses: Spanish Cadastre (INSPIRE), a separate dataset from the buildings ---
# Entrance points with a street name and house number — what the search box resolves against.
$(ADZIP): | $(DATA)
	curl -sSL --cacert $(CA) -o $@ \
	  https://www.catastro.hacienda.gob.es/INSPIRE/addresses/46/46900-VALENCIA/A.ES.SDGC.AD.46900.zip

$(ADGML): $(ADZIP)
	unzip -o -q $< -d $(DATA)
	touch $@

# --- trees: Valencia municipal inventory (ArcGIS REST, CC BY 4.0) ---
# 80 pages of 2,000 over one endpoint, ~2 min. Refreshed annually upstream, so this is the
# slowest-moving of the three sources; delete the file to force a re-pull.
$(TREES): fetch-trees.mjs | $(DATA)
	node fetch-trees.mjs $@

# --- artifact ---
$(OUT): $(OPL) $(BLD) $(TREES) $(ADGML) $(POIS) build.mjs build-graph.mjs parse-osm.mjs parse-trees.mjs \
        parse-addresses.mjs join-streets.mjs parse-pois.mjs lib/geo.mjs lib/species.mjs
	node --max-old-space-size=8192 build.mjs

# --- publish ---
# Cloudflare Pages, deployed as a plain directory: the page, the header rules, and the artifact.
# Needs `npx wrangler login` once (opens a browser; the token is stored by wrangler, not here).
PROJECT := porlasombra
DIST    := ../dist

dist: $(OUT)
	rm -rf $(DIST) && mkdir -p $(DIST)/data
	cp ../index.html ../_headers $(DIST)/
	cp $(OUT) $(DIST)/data/
	@# Stamp the artifact URL with a content hash. _headers caches /data/* for a day, which is
	@# right for a 6 MB file that changes quarterly — but the filename never changed, so a
	@# returning visitor kept yesterday's city. That failed silently the first time it mattered:
	@# the rebuild that added the search index shipped, and anyone with a warm cache got a working
	@# map whose search answered "no results" to everything. The page itself is only cached for
	@# five minutes, so moving the URL here reaches those clients on their next visit.
	@v=$$(shasum -a 256 $(OUT) | cut -c1-12); \
	  sed -i '' "s|data/valencia.json.gz|data/valencia.json.gz?v=$$v|" $(DIST)/index.html; \
	  echo "artifact version: $$v"
	@echo "dist ready: $$(du -sh $(DIST) | cut -f1)"

deploy: dist
	npx wrangler pages deploy $(DIST) --project-name=$(PROJECT) --commit-dirty=true

clean:
	rm -rf $(DIST)
	rm -f $(DATA)/city.osm.pbf $(DATA)/walkable.osm.pbf $(OPL) $(BLD) \
	      $(DATA)/valencia.json $(DATA)/valencia.json.gz $(POIS) $(DATA)/pois.osm.pbf

distclean: clean
	rm -rf $(DATA)

.PHONY: all dist deploy clean distclean
