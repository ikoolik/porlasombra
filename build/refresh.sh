#!/bin/sh
# Re-pull every source, rebuild, and deploy only if the rebuilt artifact differs from the last one.
# Built for an unattended cron. Deletes the three downloads (OSM, both Cadastre datasets, the tree
# inventory) so `make all` re-fetches the latest, rebuilds, then compares the new artifact hash to
# the one it replaced. The build and gzip are deterministic, so an unchanged city yields an
# identical hash and no deploy — the only reliable change signal, since OSM's daily extract changes
# every day whether or not Valencia did.
#
#   ./refresh.sh                                       # macOS (Makefile's default CA path)
#   CA=/etc/ssl/certs/ca-certificates.crt ./refresh.sh # Linux server: point curl at the system CA
#
# Deploy needs wrangler auth once (CLOUDFLARE_API_TOKEN in the environment, or `npx wrangler login`).
set -eu
cd "$(dirname "$0")"

DATA=../data
OUT=$DATA/valencia.json.gz

# Pass CA through to make only when set, so the Makefile default stands on macOS.
MAKE_ARGS=""
[ -n "${CA:-}" ] && MAKE_ARGS="CA=$CA"

before=$([ -f "$OUT" ] && shasum -a 256 "$OUT" | cut -d' ' -f1 || echo none)
echo "current artifact: $before"

# Drop the downloads (forces a fresh fetch) and the derived files they feed.
rm -f "$DATA/valencia-latest.osm.pbf" \
      "$DATA/catastro-46900.zip" "$DATA/A.ES.SDGC.BU.46900.buildingpart.gml" \
      "$DATA/catastro-ad-46900.zip" "$DATA/A.ES.SDGC.AD.46900.gml" \
      "$DATA/trees.json" \
      "$DATA/walkable.opl" "$DATA/buildings.json" "$DATA/pois.geojsonseq" \
      "$DATA/valencia.json" "$OUT"

make all $MAKE_ARGS

after=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
if [ "$after" = "$before" ]; then
  echo "no change ($after) — skipping deploy"
else
  echo "changed: $before -> $after — deploying"
  make deploy $MAKE_ARGS
fi
