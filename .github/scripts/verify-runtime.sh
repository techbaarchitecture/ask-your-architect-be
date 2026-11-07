#!/usr/bin/env sh
# Normalize container/image references to config IDs (BuildKit manifest-list
# digests can change while the built runtime configuration remains identical).
set -eu
ENV=${1:?environment required}
case "$ENV" in prod|dev) ;; *) echo 'Invalid AYA environment' >&2; exit 1;; esac
CONTAINER="aya-$ENV-api-1"
IMAGE="aya-$ENV-api:latest"
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true
RUNNING_REF=$(docker inspect -f '{{.Image}}' "$CONTAINER")
RUNNING_ID=$(docker image inspect -f '{{.Id}}' "$RUNNING_REF")
BUILT_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE")
printf 'Running image config: %s\nBuilt image config: %s\n' "$RUNNING_ID" "$BUILT_ID"
if [ "$RUNNING_ID" != "$BUILT_ID" ]; then
  echo 'Running container does not match the built image' >&2
  exit 1
fi
docker exec "$CONTAINER" test -f /app/dist/server.js
echo 'RUNTIME_OK: matching image configuration and compiled entry point'
