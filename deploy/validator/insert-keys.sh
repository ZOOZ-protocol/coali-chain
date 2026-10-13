#!/usr/bin/env bash
# Run once on the validator server, in this folder, with the validator secrets copied
# to ./keys/ (phrase, node-key). Inserts the Aura and GRANDPA keys and the node key
# into the data volume, then deletes ./keys.
set -euo pipefail
cd "$(dirname "$0")"
source .env
IMAGE="${IMAGE:-coali-node:testnet}"
VOLUME="$(basename "$PWD")_data"

test -s keys/phrase && test -s keys/node-key
docker volume create "$VOLUME" >/dev/null

run() {
  docker run --rm --user root -v "$VOLUME:/data" -v "$PWD/spec:/spec:ro" -v "$PWD/keys:/keys:ro" \
    --entrypoint sh "$IMAGE" -c "set -e; $1"
}
run 'rm -rf /data/chains/*/keystore'
run 'coali-node key insert --base-path /data --chain /spec/coali-testnet-raw.json --scheme sr25519 --key-type aura --suri "$(cat /keys/phrase)"'
run 'coali-node key insert --base-path /data --chain /spec/coali-testnet-raw.json --scheme ed25519 --key-type gran --suri "$(cat /keys/phrase)"'
run 'cp /keys/node-key /data/node-key && chmod 600 /data/node-key && chown -R coali:coali /data'

shred -u keys/* 2>/dev/null || rm -f keys/*
rmdir keys
echo "Keys inserted into volume $VOLUME. Start with: docker compose up -d"
