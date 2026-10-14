// Direct chain access through @polkadot/api (install it next to the SDK).
import { ApiPromise, WsProvider } from "@polkadot/api";
import { TESTNET, type Network } from "./networks.js";
import { decisionId, merkleRoot, toHex, voteLeaf, type Hex } from "./proofs.js";

export type { ApiPromise };

/** Connects to a Coalichain node. Call `api.disconnect()` when done. */
export function connect(network: Network | string = TESTNET): Promise<ApiPromise> {
  const url = typeof network === "string" ? network : network.rpc;
  return ApiPromise.create({ provider: new WsProvider(url), noInitWarn: true });
}

// Storage values are returned by @polkadot/api as codecs; the helpers below expose plain objects.
/* eslint-disable @typescript-eslint/no-explicit-any */
const q = (api: ApiPromise) => api.query.coaliLedger as any;

export interface ChainDecision {
  id: Hex;
  contentHash: Hex;
  category: number;
  registeredBy: string;
  registeredAt: number;
  closed: boolean;
  votes: number;
}

export async function getDecision(api: ApiPromise, id: string): Promise<ChainDecision | null> {
  const key = decisionId(id);
  const [info, count] = await Promise.all([q(api).decisions(key), q(api).voteCount(key)]);
  if (info.isNone) return null;
  const d = info.unwrap();
  return {
    id: key,
    contentHash: d.contentHash.toHex(),
    category: d.category.toNumber(),
    registeredBy: d.registeredBy.toString(),
    registeredAt: d.registeredAt.toNumber(),
    closed: d.closed.isTrue,
    votes: count.toNumber(),
  };
}

export interface ChainVote {
  voter: string;
  voterPublicKey: Hex;
  commitment: Hex;
  kind: "Direct" | "Inferred";
  recordedAt: number;
}

function toVote(api: ApiPromise, voter: any, r: any): ChainVote {
  const account = api.createType("AccountId", voter);
  return {
    voter: account.toString(),
    voterPublicKey: toHex(account.toU8a()),
    commitment: r.commitment.toHex(),
    kind: r.kind.toString(),
    recordedAt: r.recordedAt.toNumber(),
  };
}

/** The vote of one voter address on a decision, or null. */
export async function getVote(api: ApiPromise, decision: string, voter: string): Promise<ChainVote | null> {
  const v = await q(api).votes(decisionId(decision), voter);
  return v.isNone ? null : toVote(api, voter, v.unwrap());
}

/** All votes recorded on a decision. */
export async function getVotes(api: ApiPromise, decision: string): Promise<ChainVote[]> {
  const entries = await q(api).votes.entries(decisionId(decision));
  return entries.map(([k, v]: [any, any]) => toVote(api, k.args[1], v.unwrap()));
}

/** Block at which `truster` trusted `trusted` in `category`, or null if no such trust. */
export async function getTrust(api: ApiPromise, truster: string, trusted: string, category: number): Promise<number | null> {
  const v = await q(api).trustEdges(truster, trusted, category);
  return v.isNone ? null : v.unwrap().toNumber();
}

/** Number of distinct accounts trusting `address`, in any category. */
export async function trustReceived(api: ApiPromise, address: string): Promise<number> {
  return (await q(api).trustReceived(address)).toNumber();
}

export interface Snapshot {
  seq: number;
  merkleRoot: Hex;
  totalsHash: Hex;
  isFinal: boolean;
  publishedAt: number;
}

/** A result snapshot of a decision; the latest one if `seq` is omitted. */
export async function getSnapshot(api: ApiPromise, decision: string, seq?: number): Promise<Snapshot | null> {
  const key = decisionId(decision);
  if (seq === undefined) {
    const latest = await q(api).latestSnapshot(key);
    if (latest.isNone) return null;
    seq = latest.unwrap().toNumber() as number;
  }
  const s = await q(api).snapshots(key, seq);
  if (s.isNone) return null;
  const v = s.unwrap();
  return {
    seq,
    merkleRoot: v.merkleRoot.toHex(),
    totalsHash: v.totalsHash.toHex(),
    isFinal: v.isFinal.isTrue,
    publishedAt: v.publishedAt.toNumber(),
  };
}

export interface SnapshotCheck {
  /** True if the Merkle root rebuilt from on-chain votes equals the published one. */
  match: boolean;
  snapshot: Snapshot;
  computedRoot: Hex;
  /** Votes recorded before the snapshot, which it should cover. */
  votes: ChainVote[];
  /** Whether `voter` (if given) is among those votes. */
  included?: boolean;
}

/**
 * Audits a result snapshot: rebuilds its Merkle root from the votes recorded on chain
 * before it was published. Pass `voter` to also check that this vote is covered.
 */
export async function verifySnapshot(
  api: ApiPromise,
  decision: string,
  opts: { seq?: number; voter?: string } = {},
): Promise<SnapshotCheck | null> {
  const snapshot = await getSnapshot(api, decision, opts.seq);
  if (!snapshot) return null;
  const votes = (await getVotes(api, decision)).filter((v) => v.recordedAt < snapshot.publishedAt);
  const computedRoot = merkleRoot(votes.map((v) => voteLeaf(v.voterPublicKey, v.commitment)));
  const out: SnapshotCheck = { match: computedRoot === snapshot.merkleRoot, snapshot, computedRoot, votes };
  if (opts.voter) {
    const pk = toHex(api.createType("AccountId", opts.voter).toU8a());
    out.included = votes.some((v) => v.voterPublicKey === pk);
  }
  return out;
}

export interface LedgerEvent {
  block: number;
  method: "VoteRecorded" | "TrustRecorded" | "DecisionRegistered" | "SnapshotPublished" | string;
  data: Record<string, unknown>;
}

/** Calls `cb` for every coaliLedger event in each newly finalized block. Returns an unsubscribe function. */
export async function watchLedger(api: ApiPromise, cb: (e: LedgerEvent) => void): Promise<() => void> {
  return api.rpc.chain.subscribeFinalizedHeads(async (header) => {
    const at = await api.at(header.hash);
    const events = (await at.query.system.events()) as any;
    for (const { event } of events) {
      if (event.section !== "coaliLedger") continue;
      const names: string[] = event.meta.fields.map((f: any) =>
        f.name.unwrapOr(null)?.toString().replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase()),
      );
      const data: Record<string, unknown> = {};
      event.data.forEach((d: any, i: number) => (data[names[i] ?? String(i)] = d.toJSON()));
      cb({ block: header.number.toNumber(), method: event.method, data });
    }
  }) as unknown as () => void;
}
