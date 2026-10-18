// Offline tests: the SDK encodings must match the relayer's (@polkadot/util-crypto based).
import { test } from "node:test";
import assert from "node:assert/strict";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { isReservedName } from "../dist/tokens.js";

// Same cases as runtime/tests/token_attacks.rs (t01): the SDK must refuse exactly what the chain refuses.
const REFUSED_NAMES = [
  ["reserved name", "ZOOZ", "ZOOZ"],
  ["stablecoin", "Tether USD", "USDT"],
  ["zeros for O", "My coin", "z00z"],
  ["punctuation inside", "Official Co-ali reward", "RWD"],
  ["Greek omicrons", "ZΟΟZ", "CLB"],
  ["Cyrillic O in symbol", "Club", "ZООZ"],
  ["Cyrillic T in symbol", "Tether", "USDТ"],
  ["full width", "ＺＯＯＺ", "CLB"],
  ["zero-width space", "ZO\u200BOZ", "CLB"],
  ["right-to-left override", "Club\u202E", "CLB"],
  ["mathematical bold", "𝐙𝐎𝐎𝐙 fan", "CLB"],
  ["accented Latin", "Zööz", "CLB"],
  ["small capitals", "ᴢᴏᴏᴢ", "ZZ1"],
  ["circled letters", "ⓏⓄⓄⓏ", "ZZ2"],
  ["double-struck", "ℤ𝕆𝕆ℤ", "ZZ3"],
  ["Z with stroke", "ƵOOƵ", "ZZ4"],
  ["Cherokee Z", "ᏃOOᏃ", "ZZ5"],
  ["modifier letters", "ᶻᵒᵒᶻ", "ZZ6"],
  ["ordinal indicators", "Zºº Z", "ZZ7"],
  ["Greek name", "Ζωή", "ZOE"],
  ["variation selector outside an emoji", "Z\uFE0FOOZ", "ZZ8"],
  ["name USDT, other symbol", "USDT", "USDTT"],
  ["name Wrapped BTC", "Wrapped BTC", "WBTCX"],
  ["name ETH, symbol ETH2", "ETH", "ETH2"],
  ["SOL as a word", "Sol club", "SOLC"],
  ["S0L as a word", "Club S0L", "CLB"],
  ["Hebrew point splitting USDT", "US\u05B0DT", "AC1"],
  ["Hebrew point splitting ETH", "ET\u05B0H", "AC2"],
  ["Tether sign", "USD₮", "AC3"],
  ["Bitcoin sign", "₿ Wrapped", "AC4"],
  ["Arabic-Indic five for O", "Z\u0665\u0665Z", "AC5"],
  ["dotted letters", "U.S.D.T", "AC6"],
  ["spaced single letters", "U S D T coin", "AC7"],
  ["Hebrew point without a letter", "\u05B0Club", "AC8"],
  ["Arabic vowel sign after Latin", "Club\u064E", "AC9"],
  ["space in symbol", "Club", "CL B"],
  ["accent in symbol", "Club", "CLÉ"],
  ["empty symbol", "Club", ""],
];
const ALLOWED_NAMES = [
  ["plain", "Maison Tel Aviv", "MTA"],
  ["French accents", "Club des élèves", "ELV"],
  ["Hebrew", "מועדון תל אביב", "TLV"],
  ["Hebrew and emoji", "זוז שלום 🎉", "SHALOM"],
  ["Arabic", "نادي يافا", "JAFFA"],
  ["emoji", "Club 🎉", "PARTY"],
  ["emoji with variation selector", "Amour ❤\uFE0F", "LOVE"],
  ["emoji sequence with joiners", "Famille 👨\u200D👩\u200D👧", "FAM"],
  ["punctuation and currency", "Café « Le Soleil » – 10 ₪", "CAFE"],
  ["coin symbols inside longer words", "Solar Dots", "SOLAR"],
  ["vowelled Hebrew", "שָׁלוֹם", "SHALOM"],
  ["vowelled Arabic", "مَرْحَبًا", "MARHABA"],
  ["Arabic-Indic year", "Club ٢٠٢٦", "Y2026"],
  ["two single letters", "A B Club", "ABC"],
];
for (const [label, name, symbol] of REFUSED_NAMES)
  test(`token name refused: ${label} (${name} / ${symbol})`, () => assert.equal(isReservedName(name, symbol), true));
for (const [label, name, symbol] of ALLOWED_NAMES)
  test(`token name allowed: ${label} (${name} / ${symbol})`, () => assert.equal(isReservedName(name, symbol), false));
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

// Relayer implementation (v2, runtime 204+), copied from relayer/index.mjs.
const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);
function relayerRoot(leaves) {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = [...leaves].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? blake2AsU8a(u8aConcat(NODE, level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  return level[0];
}

test("merkle root matches the relayer (v2)", () => {
  for (const n of [0, 1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, (_, i) => {
      const pk = blake2AsU8a(stringToU8a(`pk${i}`));
      const c = blake2AsU8a(stringToU8a(`c${i}`));
      const leaf = voteLeaf(pk, c);
      assert.equal(u8aToHex(leaf), u8aToHex(blake2AsU8a(u8aConcat(LEAF, pk, c))));
      return leaf;
    });
    assert.equal(merkleRoot(leaves), u8aToHex(relayerRoot(leaves)), `n=${n}`);
  }
});

test("v1 snapshots (before runtime 204) still verify", () => {
  const pk = blake2AsU8a(stringToU8a("pk"));
  const c = blake2AsU8a(stringToU8a("c"));
  const a = voteLeaf(pk, c, 1);
  const b = voteLeaf(c, pk, 1);
  assert.equal(u8aToHex(a), u8aToHex(blake2AsU8a(u8aConcat(pk, c))));
  const [x, y] = [a, b].sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)));
  assert.equal(merkleRoot([a, b], 1), u8aToHex(blake2AsU8a(u8aConcat(x, y))));
});

test("v2: an inner node cannot pass as a vote leaf", () => {
  const leaves = [0, 1, 2, 3].map((i) => voteLeaf(blake2AsU8a(stringToU8a(`v${i}`)), new Uint8Array(32)));
  leaves.sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)));
  const node = blake2AsU8a(u8aConcat(NODE, leaves[0], leaves[1]));
  assert.notEqual(u8aToHex(voteLeaf(leaves[0], leaves[1])), u8aToHex(node));
});

test("ZOOZ amounts", () => {
  assert.equal(formatZooz("2500000000"), "2.5");
  assert.equal(formatZooz("759643640000000000"), "759643640");
  assert.equal(formatZooz(1n), "0.000000001");
  assert.equal(parseZooz("2.5"), 2500000000n);
  assert.equal(parseZooz("759643640"), 759643640000000000n);
  assert.throws(() => parseZooz("1.0000000001"));
});

test("token amounts", async () => {
  const { toUnits, fromUnits } = await import("../dist/tokens.js");
  assert.equal(toUnits("1000.5", 2), 100050n);
  assert.equal(toUnits(3, 0), 3n);
  assert.equal(toUnits(0.25, 2), 25n);
  assert.equal(toUnits(7n, 2), 7n);
  assert.throws(() => toUnits("1.234", 2));
  assert.throws(() => toUnits("-1", 2));
  assert.equal(fromUnits(100050n, 2), "1000.5");
  assert.equal(fromUnits("5", 0), "5");
});
