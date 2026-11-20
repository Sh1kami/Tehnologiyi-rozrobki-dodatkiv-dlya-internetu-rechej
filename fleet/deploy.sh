#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

image_prefix=ghcr.io/sh1kami/tehnologiyi-rozrobki-dodatkiv-dlya-internetu-rechej
if [[ $# != 1 || ! $1 =~ ^(sha-[0-9a-f]{7,40}|[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  printf 'Usage: %s sha-COMMIT or VERSION\n' "$0" >&2
  exit 2
fi
next_image="$image_prefix:$1"
state_file=.deployed-image
previous_image=
if [[ -f $state_file ]]; then read -r previous_image < "$state_file"; fi
compose=(docker compose -f compose.yml -f docker-compose.prod.yml)
run() {
  FLEET_IMAGE="$1" "${compose[@]}" "${@:2}"
}

run "$next_image" pull
if run "$next_image" up -d --no-build --wait --wait-timeout 90 &&
   run "$next_image" exec -T backend node src/smoke.js; then
  printf '%s\n' "$next_image" > "$state_file.tmp"
  mv -- "$state_file.tmp" "$state_file"
  exit 0
fi
printf 'Deployment failed: %s\n' "$next_image" >&2
if [[ -n $previous_image ]]; then
  printf 'Restoring: %s\n' "$previous_image" >&2
  run "$previous_image" up -d --no-build --wait --wait-timeout 90
  run "$previous_image" exec -T backend node src/smoke.js
fi
exit 1
