#!/usr/bin/env bash
# Three local validators (Alice, Bob, Charlie) on the `local` preset.
# RPC: Alice ws://127.0.0.1:9944, Bob :9945, Charlie :9946. Ctrl-C stops all.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$ROOT/target/release/coali-node"
BASE="${COALI_NET_DIR:-/tmp/coali-net}"
# Peer id of the fixed node key 0x…01 used by Alice.
ALICE_PEER="12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp"

rm -rf "$BASE" && mkdir -p "$BASE"
trap 'kill 0' EXIT INT TERM

start() {
  local name=$1 p2p=$2 rpc=$3; shift 3
  "$NODE" --chain local --base-path "$BASE/$name" --"$name" --validator \
    --port "$p2p" --rpc-port "$rpc" --rpc-cors all --name "coali-$name" \
    --unsafe-force-node-key-generation "$@" >"$BASE/$name.log" 2>&1 &
  echo "$name: rpc ws://127.0.0.1:$rpc, log $BASE/$name.log"
}

start alice 30333 9944 --node-key 0000000000000000000000000000000000000000000000000000000000000001
start bob 30334 9945 --bootnodes "/ip4/127.0.0.1/tcp/30333/p2p/$ALICE_PEER"
start charlie 30335 9946 --bootnodes "/ip4/127.0.0.1/tcp/30333/p2p/$ALICE_PEER"

wait
