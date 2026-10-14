import { TESTNET, type Network } from "./networks.js";
import { decisionId, voteCommitment, type Hex } from "./proofs.js";

export interface Stats {
  chain: string;
  token: { symbol: string; decimals: number };
  best: number;
  finalized: number;
  indexed: number;
  /** Average seconds per block over the last 100 blocks. */
  blockTime: number | null;
  transactions: number;
  transfers: number;
  votes: number;
  trusts: number;
  decisions: number;
  snapshots: number;
  accounts: number;
  validators: string[];
  minTrust: number;
  /** Total supply in planck. */
  issuance: string;
  economy: {
    priceUsd: number;
    priceUpdated: number | null;
    targetFeeUsd: number;
    split: { author: number; foundation: number; app: number };
    blockReward: string;
    halvingInterval: number;
    fuel: string;
  };
  labels: Record<string, { name: string; kind: string }>;
}

export interface ChainEvent<D = Record<string, unknown>> {
  /** Block number. */
  n: number;
  /** Event index in the block. */
  i: number;
  /** Extrinsic index in the block, -1 for block initialization events. */
  x: number;
  section: string;
  method: string;
  data: D;
  /** Block timestamp (ms). */
  ts: number;
}

export type VoteKind = "Direct" | "Inferred";

export interface VoteRecordedData {
  decisionId: Hex;
  voter: string;
  commitment: Hex;
  kind: VoteKind;
}

export interface TrustRecordedData {
  truster: string;
  trusted: string;
  category: string;
  action: "Give" | "Revoke";
  nonce: string;
}

export interface DecisionRegisteredData {
  decisionId: Hex;
  contentHash: Hex;
  category: string;
}

export interface SnapshotPublishedData {
  decisionId: Hex;
  seq: string;
  merkleRoot: Hex;
  totalsHash: Hex;
  isFinal: boolean;
}

export interface Decision {
  id: Hex;
  contentHash: Hex;
  category: number;
  /** App (attester) that registered the decision. */
  registeredBy: string;
  registeredAt: number;
  closed: boolean;
  votes: number;
  events: ChainEvent[];
}

export interface Vote {
  decisionId: Hex;
  voter: string;
  commitment: Hex;
  kind: VoteKind;
  recordedAt: number;
  /** Transaction id "block-index", if indexed. */
  tx: string | null;
}

export interface Account {
  address: string;
  free: string;
  reserved: string;
  nonce: number;
  /** Identity attested on chain (proof-of-trust). */
  verified: boolean;
  /** Number of distinct accounts trusting this one. */
  trustReceived: number;
  founder: boolean;
  candidateFor: string | null;
  offline: boolean;
  validator: boolean;
  /** Approved app allowed to publish votes and trusts. */
  attester: boolean;
  produced: number;
  total: number;
  history: unknown[];
}

export interface Block {
  n: number;
  hash: Hex;
  parent: Hex;
  ts: number;
  author: string | null;
  xc: number;
  ec: number;
  reward: string;
  fees: string;
  extrinsics?: unknown[];
  events?: ChainEvent[];
}

export type EventKind =
  | "coaliLedger.VoteRecorded"
  | "coaliLedger.TrustRecorded"
  | "coaliLedger.DecisionRegistered"
  | "coaliLedger.SnapshotPublished"
  | (string & {});

export interface Page {
  /** Only items in blocks strictly before this number. */
  before?: number;
  /** 1 to 100, default 25. */
  limit?: number;
}

export interface VerifyVoteInput {
  /** Decision UUID or on-chain id. */
  decision: string;
  /** Option id chosen. */
  option: string;
  /** Secret (salt) given by the app. */
  salt: string;
  /** One-time voter address shown in the app. */
  voter: string;
}

export interface VerifyVoteResult {
  /** True if the commitment recomputed from the inputs equals the one on chain. */
  match: boolean;
  expected: Hex;
  /** The vote found on chain, or null if this voter has no vote on this decision. */
  onChain: Vote | null;
}

/** Read-only client of the public explorer API. Works in browsers and Node 18+. */
export class ExplorerClient {
  readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { network?: Network; api?: string; fetch?: typeof fetch } = {}) {
    this.base = (opts.api ?? (opts.network ?? TESTNET).api).replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T | null> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const res = await this.fetchFn(`${this.base}/${path}${qs ? `?${qs}` : ""}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`explorer API ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Network figures: blocks, votes, trusts, validators, economy. */
  async stats(): Promise<Stats> {
    return (await this.get<Stats>("stats"))!;
  }

  /** A decision and its recent events, or null. */
  decision(id: string): Promise<Decision | null> {
    return this.get<Decision>(`decision/${decisionId(id)}`);
  }

  /** The vote of one voter address on a decision, or null. */
  vote(decision: string, voter: string): Promise<Vote | null> {
    return this.get<Vote>(`vote/${decisionId(decision)}`, { voter });
  }

  /** Balance, trust and validator status of an address, with its recent history. */
  account(address: string, page: Page = {}): Promise<Account | null> {
    return this.get<Account>(`account/${encodeURIComponent(address)}`, { ...page });
  }

  /** A block by number or hash, with its extrinsics and events. */
  block(id: number | string): Promise<Block | null> {
    return this.get<Block>(`block/${id}`);
  }

  /** Latest blocks. */
  async blocks(page: Page = {}): Promise<Block[]> {
    return (await this.get<Block[]>("blocks", { ...page })) ?? [];
  }

  /** A transaction by id ("block-index") or hash. */
  tx(id: string): Promise<unknown | null> {
    return this.get(`tx/${encodeURIComponent(id)}`);
  }

  /** Latest signed transactions. */
  async txs(page: Page = {}): Promise<unknown[]> {
    return (await this.get<unknown[]>("txs", { ...page })) ?? [];
  }

  /** Latest events of the given kinds, newest first. */
  async events<D = Record<string, unknown>>(kinds: EventKind | EventKind[], page: Page = {}): Promise<ChainEvent<D>[]> {
    const kind = Array.isArray(kinds) ? kinds.join(",") : kinds;
    return (await this.get<ChainEvent<D>[]>("events", { kind, ...page })) ?? [];
  }

  votes(page: Page = {}) {
    return this.events<VoteRecordedData>("coaliLedger.VoteRecorded", page);
  }

  trusts(page: Page = {}) {
    return this.events<TrustRecordedData>("coaliLedger.TrustRecorded", page);
  }

  decisions(page: Page = {}) {
    return this.events<DecisionRegisteredData>("coaliLedger.DecisionRegistered", page);
  }

  snapshots(page: Page = {}) {
    return this.events<SnapshotPublishedData>("coaliLedger.SnapshotPublished", page);
  }

  /** Resolves a block number, transaction id, hash or address. */
  search(q: string): Promise<{ type: "block" | "tx" | "account"; id: string } | null> {
    return this.get("search", { q });
  }

  /**
   * Checks a vote receipt: recomputes the commitment from (decision, option, secret)
   * and compares it with the one recorded on chain for the voter address.
   */
  async verifyVote(input: VerifyVoteInput): Promise<VerifyVoteResult> {
    const expected = voteCommitment(input.decision, input.option, input.salt);
    const onChain = await this.vote(input.decision, input.voter);
    return { match: !!onChain && onChain.commitment.toLowerCase() === expected, expected, onChain };
  }
}
