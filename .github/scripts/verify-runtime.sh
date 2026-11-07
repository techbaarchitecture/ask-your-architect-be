#!/usr/bin/env sh
# Compare actual compiled runtime bytes, not transient BuildKit manifest IDs.
# Docker may retain an old manifest reference after a cache-identical rebuild
# while removing that reference from image inspect; the code can still match.
set -eu
ENV=${1:?environment required}
case "$ENV" in prod|dev) ;; *) echo 'Invalid AYA environment' >&2; exit 1;; esac
CONTAINER="aya-$ENV-api-1"
IMAGE="aya-$ENV-api:latest"
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true
HASH_JS='const fs=require("node:fs"),crypto=require("node:crypto");function walk(p){return fs.readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>e.isDirectory()?walk(p+"/"+e.name):[p+"/"+e.name])}const files=["package.json","package-lock.json",...walk("dist")];for(const p of files)console.log(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+" "+p);'
RUNNING_HASHES=$(docker exec "$CONTAINER" node -e "$HASH_JS")
BUILT_HASHES=$(docker run --rm --network none --entrypoint node "$IMAGE" -e "$HASH_JS")
if [ -z "$BUILT_HASHES" ] || [ "$RUNNING_HASHES" != "$BUILT_HASHES" ]; then
  echo 'Running compiled artifacts do not match the newly built image' >&2
  exit 1
fi
docker exec "$CONTAINER" test -f /app/dist/server.js
echo 'RUNTIME_OK: compiled artifacts and package manifests match the built image'
