#!/usr/bin/env bash
# Generates every testnet secret once, on an offline-safe machine:
#   - per validator: a 24-word phrase (sr25519 = Aura, ed25519 = GRANDPA) and a libp2p node key;
#   - the sudo account, the attester account (used by the relayer), the faucet account and the
#     voter master seed.
# Secrets go to deploy/secrets/<network>/ (git-ignored, mode 600). Public keys go to
# deploy/<network>/authorities.json, which gen-testnet-spec.sh reads.
#
# Usage: deploy/gen-testnet-keys.sh [validators=4] [network=testnet]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${COALI_NODE:-$ROOT/target/release/coali-node}"
COUNT="${1:-4}"
NET="${2:-testnet}"
SECRETS="$ROOT/deploy/secrets/$NET"
PUBLIC="$ROOT/deploy/$NET"

if [ -e "$SECRETS" ]; then
  echo "$SECRETS already exists; refusing to overwrite secrets." >&2
  exit 1
fi
umask 077
mkdir -p "$SECRETS" "$PUBLIC"

account() { "$NODE" key generate --scheme sr25519 --words 24 --output-type json; }
field() { python3 -c "import sys,json; print(json.load(sys.stdin)['$1'])"; }

validators="[]"
for i in $(seq 1 "$COUNT"); do
  dir="$SECRETS/validator-$i"
  mkdir -p "$dir"
  account >"$dir/sr25519.json"
  phrase="$(field secretPhrase <"$dir/sr25519.json")"
  printf '%s' "$phrase" >"$dir/phrase"
  aura="$(field ss58Address <"$dir/sr25519.json")"
  grandpa="$("$NODE" key inspect --scheme ed25519 --output-type json "$phrase" | field ss58Address)"
  peer="$("$NODE" key generate-node-key --file "$dir/node-key" 2>&1 >/dev/null | tail -1)"
  validators="$(python3 -c "
import json,sys
v=json.loads(sys.argv[1]); v.append({'name':'validator-$i','aura':'$aura','grandpa':'$grandpa','peer_id':'$peer'})
print(json.dumps(v))" "$validators")"
  echo "validator-$i: aura $aura, peer $peer"
done

account >"$SECRETS/sudo.json"
account >"$SECRETS/attester.json"
account >"$SECRETS/faucet.json"
"$NODE" key generate --scheme sr25519 --words 24 --output-type json | field secretPhrase >"$SECRETS/voter-master-seed"

python3 - "$validators" "$SECRETS" "$PUBLIC/authorities.json" <<'EOF'
import json, sys
validators, secrets, out = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
addr = lambda f: json.load(open(f"{secrets}/{f}"))["ss58Address"]
json.dump({"validators": validators, "sudo": addr("sudo.json"), "attesters": [addr("attester.json")],
           "faucet": addr("faucet.json")},
          open(out, "w"), indent=2)
EOF
chmod 644 "$PUBLIC/authorities.json"

echo
echo "Secrets: $SECRETS  (back them up offline, never commit them)"
echo "Public:  $PUBLIC/authorities.json"
