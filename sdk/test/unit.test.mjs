// Offline tests: the SDK encodings must match the relayer's (@polkadot/util-crypto based).
import { test } from "node:test";
import assert from "node:assert/strict";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import {
  canonicalJson,
  contentHash,
  decisionId,
  decisionUuid,
  formatZooz,
  merkleRoot,
  parseZooz,
  totalsHash,
  voteCommitment,
  voteLeaf,
} from "../dist/index.js";

const UUID = "3f2a9c1e-7b4d-4e8a-9c01-5d6e7f8a9b0c";

test("decision id <-> uuid", () => {
  assert.equal(decisionId(UUID), "0x3f2a9c1e7b4d4e8a9c015d6e7f8a9b0c");
  assert.equal(decisionId("0x3F2A9C1E7B4D4E8A9C015D6E7F8A9B0C"), "0x3f2a9c1e7b4d4e8a9c015d6e7f8a9b0c");
  assert.equal(decisionUuid("0x3f2a9c1e7b4d4e8a9c015d6e7f8a9b0c"), UUID);
  assert.throws(() => decisionId("not-a-uuid"));
});

test("vote commitment matches the relayer", () => {
  const salt = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const expected = u8aToHex(blake2AsU8a(stringToU8a(`coali/commit/v1|${UUID}|option-1|${salt}`)));
  assert.equal(voteCommitment(UUID, "option-1", salt), expected);
  assert.equal(voteCommitment(decisionId(UUID), "option-1", salt), expected);
  assert.notEqual(voteCommitment(UUID, "option-2", salt), expected);
});

test("canonical JSON and content hash", () => {
  const content = { title: "Q?", options: [{ id: "b", label: "B" }, { label: "A", id: "a" }] };
  assert.equal(canonicalJson(content), '{"options":[{"id":"b","label":"B"},{"id":"a","label":"A"}],"title":"Q?"}');
  assert.equal(contentHash(content), u8aToHex(blake2AsU8a(stringToU8a(canonicalJson(content)))));
  assert.equal(totalsHash({ b: 2, a: 1 }), u8aToHex(blake2AsU8a(stringToU8a('{"a":1,"b":2}'))));
});

// Relayer implementation, copied from relayer/index.mjs.
function relayerRoot(leaves) {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = [...leaves].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? blake2AsU8a(u8aConcat(level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  return level[0];
}

test("merkle root matches the relayer", () => {
  for (const n of [0, 1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, (_, i) => {
      const pk = blake2AsU8a(stringToU8a(`pk${i}`));
      const c = blake2AsU8a(stringToU8a(`c${i}`));
      const leaf = voteLeaf(pk, c);
      assert.equal(u8aToHex(leaf), u8aToHex(blake2AsU8a(u8aConcat(pk, c))));
      return leaf;
    });
    assert.equal(merkleRoot(leaves), u8aToHex(relayerRoot(leaves)), `n=${n}`);
  }
});

test("ZOOZ amounts", () => {
  assert.equal(formatZooz("2500000000"), "2.5");
  assert.equal(formatZooz("759643640000000000"), "759643640");
  assert.equal(formatZooz(1n), "0.000000001");
  assert.equal(parseZooz("2.5"), 2500000000n);
  assert.equal(parseZooz("759643640"), 759643640000000000n);
  assert.throws(() => parseZooz("1.0000000001"));
});
