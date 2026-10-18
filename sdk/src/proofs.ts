import { blake2b } from "@noble/hashes/blake2b";

/** Hex string with 0x prefix. */
export type Hex = `0x${string}`;

const enc = new TextEncoder();

export const blake2_256 = (data: Uint8Array): Uint8Array => blake2b(data, { dkLen: 32 });

export function toHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * On-chain decision id (16 bytes) of an app decision.
 * Accepts the app UUID ("3f2a9c1e-...") or an already encoded id ("0x3f2a9c1e...").
 */
export function decisionId(id: string): Hex {
  const s = id.trim().toLowerCase();
  if (/^0x[0-9a-f]{32}$/.test(s)) return s as Hex;
  if (!UUID.test(s)) throw new Error(`invalid decision id: ${id}`);
  return `0x${s.replace(/-/g, "")}`;
}

/** App UUID of an on-chain decision id. */
export function decisionUuid(id: string): string {
  const h = decisionId(id).slice(2);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Vote commitment published on chain:
 * blake2_256("coali/commit/v1|<decision uuid>|<option id>|<salt>").
 * The voter receives the salt ("secret") in the app; with it, anyone can check the vote.
 */
export function voteCommitment(decision: string, optionId: string, salt: string): Hex {
  const uuid = decisionUuid(decision);
  return toHex(blake2_256(enc.encode(`coali/commit/v1|${uuid}|${optionId}|${salt}`)));
}

/** JSON with keys sorted at every level, as hashed by the protocol. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Content hash of a decision (question and options), as registered on chain. */
export const contentHash = (content: unknown): Hex => toHex(blake2_256(enc.encode(canonicalJson(content))));

/** Hash of a result snapshot's totals ({ optionId: count }). */
export const totalsHash = (totals: Record<string, number>): Hex => contentHash(totals);

/**
 * Merkle scheme of result snapshots. Version 2 (runtime 204 and later) separates leaves from
 * inner nodes: leaf = blake2_256(0x00 ‖ voter public key ‖ commitment), node =
 * blake2_256(0x01 ‖ left ‖ right). Version 1 (earlier snapshots) had no prefixes.
 */
export const MERKLE_VERSION = 2;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Merkle leaf of one vote (see `MERKLE_VERSION`). */
export function voteLeaf(voterPublicKey: Uint8Array | string, commitment: Uint8Array | string, version = MERKLE_VERSION): Uint8Array {
  const pk = typeof voterPublicKey === "string" ? fromHex(voterPublicKey) : voterPublicKey;
  const c = typeof commitment === "string" ? fromHex(commitment) : commitment;
  return blake2_256(version >= 2 ? concat(new Uint8Array([0]), pk, c) : concat(pk, c));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Merkle root of a result snapshot: leaves sorted bytewise, pairs hashed with blake2_256
 * (prefixed with 0x01 from version 2), an odd last node is carried up unchanged. No leaves gives
 * 32 zero bytes.
 */
export function merkleRoot(leaves: Uint8Array[], version = MERKLE_VERSION): Hex {
  if (leaves.length === 0) return toHex(new Uint8Array(32));
  let level = [...leaves].sort(compareBytes);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(blake2_256(version >= 2 ? concat(new Uint8Array([1]), level[i], level[i + 1]) : concat(level[i], level[i + 1])));
      } else next.push(level[i]);
    }
    level = next;
  }
  return toHex(level[0]);
}
