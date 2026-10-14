#!/usr/bin/env bash
# Builds the public testnet chain spec from deploy/<network>/authorities.json.
# Bootnodes: one DNS name per validator, in the same order as authorities.json.
#
# Usage: deploy/gen-testnet-spec.sh <network> <validator-1-host> <validator-2-host> ...
# Output: deploy/<network>/coali-<network>.json (readable) and coali-<network>-raw.json (to run nodes).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${COALI_NODE:-$ROOT/target/release/coali-node}"
NET="$1"; shift
DIR="$ROOT/deploy/$NET"
PLAIN="$DIR/coali-$NET.json"
RAW="$DIR/coali-$NET-raw.json"

"$NODE" build-spec --chain local --disable-default-bootnode 2>/dev/null >"$PLAIN.tmp"

python3 - "$PLAIN.tmp" "$DIR/authorities.json" "$NET" "$@" >"$PLAIN" <<'EOF'
import json, sys
spec = json.load(open(sys.argv[1]))
auth = json.load(open(sys.argv[2]))
net, hosts = sys.argv[3], sys.argv[4:]
vals = auth["validators"]
if len(hosts) != len(vals):
    sys.exit(f"{len(vals)} validators but {len(hosts)} hosts")

spec["name"] = f"Coali {net.capitalize()}"
spec["id"] = f"coali_{net}"
spec["chainType"] = "Live"
spec["protocolId"] = f"coali-{net}"
spec["properties"] = {"tokenSymbol": "ZOOZ", "tokenDecimals": 9, "ss58Format": 42}
spec["bootNodes"] = [f"/dns/{h}/tcp/30333/p2p/{v['peer_id']}" for h, v in zip(hosts, vals)]

patch = spec["genesis"]["runtimeGenesis"]["patch"]
patch.pop("aura", None)
patch.pop("grandpa", None)
# Founders validate through their session keys; the account is the Aura (sr25519) address.
patch["session"] = {"keys": [[v["aura"], v["aura"], {"aura": v["aura"], "grandpa": v["grandpa"]}] for v in vals]}
patch["proofOfTrust"] = {"founders": [v["aura"] for v in vals], "minTrust": 1}
patch["sudo"] = {"key": auth["sudo"]}
patch["coaliLedger"] = {"attesters": auth["attesters"]}
# 770M cap minus the 10,356,360 ZOOZ burned on BSC, split as in the white paper.
UNIT = 10**9
TOTAL = 759_643_640 * UNIT
funded = {}
for a, amount in [(auth["sudo"], 1_000_000), *[(a, 1_000_000) for a in auth["attesters"]],
                  (auth["faucet"], 5_000_000), *[(v["aura"], 10_000) for v in vals]]:
    funded.setdefault(a, amount * UNIT)
patch["balances"] = {"balances": [[a, b] for a, b in funded.items()]}
patch["zoozEconomy"] = {
    "priceMicroUsd": 246_900, "targetFeeMicroUsd": 50_000,
    "authorPercent": 60, "foundationPercent": 20,
    "blockReward": 5 * UNIT // 2, "halvingInterval": 21_000_000,
    "foundation": auth["sudo"], "oracle": None,
    "fuel": TOTAL * 65 // 100,
    # Test endowments are carved out of Development.
    "development": TOTAL * 10 // 100 - sum(funded.values()),
    "investors": TOTAL * 3 // 100, "team": TOTAL * 12 // 100, "charity": TOTAL * 10 // 100,
}
print(json.dumps(spec, indent=2))
EOF
rm "$PLAIN.tmp"

"$NODE" build-spec --chain "$PLAIN" --raw --disable-default-bootnode 2>/dev/null >"$RAW"
echo "Chain spec: $PLAIN"
echo "Raw spec:   $RAW"
