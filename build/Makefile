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
OPL     := $(DATA)/walkable.opl
BLD     := $(DATA)/buildings.json
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

# --- buildings: Spanish Cadastre (INSPIRE) ---
$(CATZIP): | $(DATA)
	curl -sSL --cacert $(CA) -o $@ \
	  https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/46/46900-VALENCIA/A.ES.SDGC.BU.46900.zip

$(GML): $(CATZIP)
	unzip -o -q $< -d $(DATA)
	touch $@

$(BLD): $(GML) parse-catastro.mjs lib/geo.mjs
	node parse-catastro.mjs $(GML) $@

# --- artifact ---
$(OUT): $(OPL) $(BLD) build.mjs build-graph.mjs parse-osm.mjs lib/geo.mjs
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
	@echo "dist ready: $$(du -sh $(DIST) | cut -f1)"

deploy: dist
	npx wrangler pages deploy $(DIST) --project-name=$(PROJECT) --commit-dirty=true

clean:
	rm -rf $(DIST)
	rm -f $(DATA)/city.osm.pbf $(DATA)/walkable.osm.pbf $(OPL) $(BLD) \
	      $(DATA)/valencia.json $(DATA)/valencia.json.gz

distclean: clean
	rm -rf $(DATA)

.PHONY: all dist deploy clean distclean
