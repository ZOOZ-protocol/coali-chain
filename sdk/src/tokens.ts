// Tokens and NFTs on Coalichain (runtime 203+), through @polkadot/api.
//
// Every write takes a `sender`: a keyring pair (scripts, servers) or a browser wallet account
// from `connectWallet` (SubWallet, Talisman, Polkadot.js). Fees and deposits are paid in ZOOZ.
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { Signer } from "@polkadot/types/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Who signs and pays: a keyring pair, or a wallet account `{ address, signer }`. */
export type Sender = KeyringPair | { address: string; signer: Signer };

/** Amount in whole units ("1.5", 1.5) converted with the token's decimals, or a raw bigint. */
export type Amount = string | number | bigint;

export interface TxResult {
  block: number;
  blockHash: string;
  txHash: string;
  /** "block-index", the explorer transaction id. */
  id: string;
  events: { section: string; method: string; data: unknown }[];
}

export class ChainError extends Error {
  constructor(
    /** "pallet.Error", e.g. "assets.BadAssetId", or "system.CallFiltered". */
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

const FRIENDLY: Record<string, string> = {
  "system.CallFiltered": "Not allowed: the receiver is not on this token's allowlist, or its supply is locked.",
  "assets.BadAssetId": "Someone created a token at the same moment. Please try again.",
  "assets.BalanceLow": "Not enough tokens.",
  "assets.NoPermission": "Only the token's creator can do this.",
  "assets.Unknown": "This token does not exist.",
  "assets.BadMetadata": "Name or symbol too long (50 characters max).",
  "token.CannotCreate": "The receiver needs a little ZOOZ first (0.001 ZOOZ).",
  "tokenAllowlist.NotManager": "Only the token's creator can do this.",
  "nfts.NoPermission": "Only the collection's creator can do this.",
  "nfts.AlreadyExists": "This NFT number already exists.",
  "balances.InsufficientBalance": "Not enough ZOOZ.",
};

function errorOf(api: ApiPromise, err: any): ChainError {
  let code = err?.toString?.() ?? String(err);
  if (err?.isModule) {
    const m = api.registry.findMetaError(err.asModule);
    code = `${m.section}.${m.name}`;
  } else if (err?.isToken) {
    code = `token.${err.asToken.type}`;
  }
  return new ChainError(code, FRIENDLY[code] ?? code);
}

const isPair = (s: Sender): s is KeyringPair => typeof (s as KeyringPair).sign === "function";

/** Signs, sends and waits for inclusion in a block. Rejects with a `ChainError` if the chain refuses it. */
export function submit(api: ApiPromise, sender: Sender, tx: SubmittableExtrinsic<"promise">): Promise<TxResult> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const cb = (r: any) => {
      const { status, dispatchError, events = [] } = r;
      if (dispatchError) {
        unsub?.();
        return reject(errorOf(api, dispatchError));
      }
      // Errors inside a batch are reported by the batch event.
      const interrupted = events.find((e: any) => e.event.section === "utility" && e.event.method === "BatchInterrupted");
      if (interrupted) {
        unsub?.();
        return reject(errorOf(api, interrupted.event.data[1]));
      }
      if (status.isInBlock) {
        unsub?.();
        api.rpc.chain
          .getHeader(status.asInBlock)
          .then((h) => {
            const block = h.number.toNumber();
            resolve({
              block,
              blockHash: status.asInBlock.toHex(),
              txHash: tx.hash.toHex(),
              id: `${block}-${r.txIndex ?? 0}`,
              events: events.map((e: any) => ({ section: e.event.section, method: e.event.method, data: e.event.data.toJSON() })),
            });
          })
          .catch(reject);
      }
    };
    const sent = isPair(sender)
      ? tx.signAndSend(sender, cb)
      : tx.signAndSend(sender.address, { signer: sender.signer }, cb);
    sent.then((u: any) => (unsub = u)).catch((e: any) => {
      const msg = String(e?.message ?? e);
      if (/Inability to pay some fees|balance too low/i.test(msg)) reject(new ChainError("balances.InsufficientBalance", FRIENDLY["balances.InsufficientBalance"]));
      else if (/Cancelled|Rejected by user/i.test(msg)) reject(new ChainError("wallet.Cancelled", "Signature cancelled in the wallet."));
      else reject(e);
    });
  });
}

const batch = (api: ApiPromise, calls: SubmittableExtrinsic<"promise">[]) =>
  calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls);

// ---------- amounts ----------

/** "1.5" with 2 decimals -> 150n. */
export function toUnits(amount: Amount, decimals: number): bigint {
  if (typeof amount === "bigint") return amount;
  const s = typeof amount === "number" ? amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`invalid amount: ${amount}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`too many decimals: ${amount} (max ${decimals})`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 150n with 2 decimals -> "1.5". */
export function fromUnits(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = decimals ? (v % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${v / base}${frac ? `.${frac}` : ""}`;
}

// ---------- reading ----------

export interface TokenInfo {
  id: number;
  name: string;
  symbol: string;
  decimals: number;
  /** Total supply, raw units. */
  supply: bigint;
  holders: number;
  owner: string;
  admin: string;
  issuer: string;
  minBalance: bigint;
  status: string;
  /** Only allowlisted accounts can receive it. */
  restricted: boolean;
  /** Supply locked forever. */
  fixedSupply: boolean;
}

const utf8 = (b: any) => {
  try {
    return b.toUtf8();
  } catch {
    return "";
  }
};

function toInfo(id: number, d: any, m: any, restricted: boolean, fixed: boolean): TokenInfo {
  return {
    id,
    name: utf8(m.name),
    symbol: utf8(m.symbol),
    decimals: m.decimals.toNumber(),
    supply: d.supply.toBigInt(),
    holders: d.accounts.toNumber(),
    owner: d.owner.toString(),
    admin: d.admin.toString(),
    issuer: d.issuer.toString(),
    minBalance: d.minBalance.toBigInt(),
    status: d.status.toString(),
    restricted,
    fixedSupply: fixed,
  };
}

/** One token, or null if it does not exist. */
export async function tokenInfo(api: ApiPromise, id: number): Promise<TokenInfo | null> {
  const [d, m, r, f] = await Promise.all([
    api.query.assets.asset(id) as any,
    api.query.assets.metadata(id) as any,
    api.query.tokenAllowlist.restricted(id) as any,
    (api.query.tokenAllowlist.fixedSupply?.(id) as any) ?? null,
  ]);
  return d.isNone ? null : toInfo(id, d.unwrap(), m, r.isSome, !!f?.isSome);
}

/** All tokens, newest first. */
export async function listTokens(api: ApiPromise): Promise<TokenInfo[]> {
  const [assets, metas, restricted, fixed] = await Promise.all([
    api.query.assets.asset.entries() as any,
    api.query.assets.metadata.entries() as any,
    api.query.tokenAllowlist.restricted.keys() as any,
    (api.query.tokenAllowlist.fixedSupply?.keys() as any) ?? [],
  ]);
  const meta = new Map(metas.map(([k, m]: any) => [k.args[0].toNumber(), m]));
  const r = new Set(restricted.map((k: any) => k.args[0].toNumber()));
  const f = new Set(fixed.map((k: any) => k.args[0].toNumber()));
  return assets
    .map(([k, v]: any) => {
      const id = k.args[0].toNumber();
      return toInfo(id, v.unwrap(), meta.get(id), r.has(id), f.has(id));
    })
    .sort((a: TokenInfo, b: TokenInfo) => b.id - a.id);
}

/** Token balance of `address`, raw units. */
export async function tokenBalance(api: ApiPromise, id: number, address: string): Promise<bigint> {
  const a = (await api.query.assets.account(id, address)) as any;
  return a.isSome ? a.unwrap().balance.toBigInt() : 0n;
}

export interface Balances {
  /** ZOOZ, raw units (9 decimals). */
  zooz: { free: bigint; reserved: bigint };
  tokens: { id: number; name: string; symbol: string; decimals: number; balance: bigint; creator: boolean }[];
  nfts: { collection: number; item: number }[];
}

/** Everything `address` holds: ZOOZ, tokens (non-zero or created by it) and NFTs. */
export async function balances(api: ApiPromise, address: string): Promise<Balances> {
  const [acct, list, nftKeys] = await Promise.all([
    api.query.system.account(address) as any,
    listTokens(api),
    api.query.nfts.account.keys(address) as any,
  ]);
  const bals: any[] = list.length ? ((await api.query.assets.account.multi(list.map((t) => [t.id, address]))) as any) : [];
  const owner = api.createType("AccountId", address).toString();
  return {
    zooz: { free: acct.data.free.toBigInt(), reserved: acct.data.reserved.toBigInt() },
    tokens: list
      .map((t, i) => ({ id: t.id, name: t.name, symbol: t.symbol, decimals: t.decimals, balance: bals[i].isSome ? bals[i].unwrap().balance.toBigInt() : 0n, creator: t.owner === owner }))
      .filter((t) => t.balance > 0n || t.creator),
    nfts: nftKeys.map((k: any) => ({ collection: k.args[1].toNumber(), item: k.args[2].toNumber() })),
  };
}

/** Accounts allowed to receive a restricted token. */
export async function allowedAccounts(api: ApiPromise, id: number): Promise<string[]> {
  const keys = (await api.query.tokenAllowlist.allowed.keys(id)) as any;
  return keys.map((k: any) => k.args[1].toString());
}

// ---------- tokens ----------

export interface CreateTokenOptions {
  /** Up to 50 characters. */
  name: string;
  /** Up to 50 characters, usually 3-6 capitals. */
  symbol: string;
  /** Decimal places (0 for indivisible tokens such as shares). Default 0. */
  decimals?: number;
  /** Initial supply in whole units, minted to the sender. */
  supply: Amount;
  /** Lock the supply forever after the initial mint. Default false (more can be minted later). */
  fixedSupply?: boolean;
  /**
   * Restrict who can receive the token. `true`: only the creator for now (add accounts later with
   * `allowList`). An array: the creator plus these accounts.
   */
  allowlist?: boolean | string[];
}

const encLen = (s: string) => new TextEncoder().encode(s).length;

function checkName(name: string, symbol: string) {
  if (!name.trim() || !symbol.trim()) throw new Error("name and symbol are required");
  if (encLen(name) > 50 || encLen(symbol) > 50) throw new Error("name and symbol: 50 characters max");
}

async function tokenCalls(api: ApiPromise, owner: string, opts: CreateTokenOptions, id: number) {
  checkName(opts.name, opts.symbol);
  const decimals = opts.decimals ?? 0;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("decimals: 0 to 18");
  const supply = toUnits(opts.supply, decimals);
  const A = api.tx.assets;
  const W = api.tx.tokenAllowlist;
  const calls = [A.create(id, owner, 1), A.setMetadata(id, opts.name.trim(), opts.symbol.trim(), decimals)];
  if (supply > 0n) calls.push(A.mint(id, owner, supply));
  if (opts.allowlist) {
    const extra = Array.isArray(opts.allowlist) ? opts.allowlist : [];
    calls.push(W.allow(id, [owner, ...extra]), W.setRestricted(id, true));
  }
  if (opts.fixedSupply) calls.push(W.fixSupply(id));
  return calls;
}

const nextTokenId = async (api: ApiPromise) => ((await api.query.assets.nextAssetId()) as any).unwrap().toNumber() as number;

/** Creates a token in one signature. The sender becomes its owner and receives the supply. */
export async function createToken(api: ApiPromise, sender: Sender, opts: CreateTokenOptions): Promise<TxResult & { tokenId: number }> {
  const id = await nextTokenId(api);
  const res = await submit(api, sender, batch(api, await tokenCalls(api, sender.address, opts, id)));
  return { ...res, tokenId: id };
}

export interface CostEstimate {
  /** Locked while the token / collection exists, returned if it is destroyed. Raw ZOOZ. */
  deposit: bigint;
  /** Transaction fee, raw ZOOZ. */
  fee: bigint;
  total: bigint;
}

/** ZOOZ needed to create this token (deposit + fee), before signing. */
export async function estimateCreateToken(api: ApiPromise, from: string, opts: CreateTokenOptions): Promise<CostEstimate> {
  const c = api.consts.assets as any;
  const bytes = BigInt(encLen(opts.name.trim()) + encLen(opts.symbol.trim()));
  const deposit = c.assetDeposit.toBigInt() + c.metadataDepositBase.toBigInt() + c.metadataDepositPerByte.toBigInt() * bytes;
  const tx = batch(api, await tokenCalls(api, from, opts, await nextTokenId(api)));
  const fee = (await tx.paymentInfo(from)).partialFee.toBigInt();
  return { deposit, fee, total: deposit + fee };
}

async function decimalsOf(api: ApiPromise, id: number, amount: Amount) {
  if (typeof amount === "bigint") return amount;
  const m = (await api.query.assets.metadata(id)) as any;
  return toUnits(amount, m.decimals.toNumber());
}

/** Mints more of a token (owner / issuer only, unless the supply is locked). */
export async function mint(api: ApiPromise, sender: Sender, id: number, to: string, amount: Amount): Promise<TxResult> {
  return submit(api, sender, api.tx.assets.mint(id, to, await decimalsOf(api, id, amount)));
}

/** Sends tokens. The receiver needs a little ZOOZ, and must be allowlisted if the token is restricted. */
export async function transfer(api: ApiPromise, sender: Sender, id: number, to: string, amount: Amount): Promise<TxResult> {
  return submit(api, sender, api.tx.assets.transferKeepAlive(id, to, await decimalsOf(api, id, amount)));
}

/** Destroys tokens held by the sender. */
export async function burn(api: ApiPromise, sender: Sender, id: number, amount: Amount): Promise<TxResult> {
  return submit(api, sender, api.tx.assets.burn(id, sender.address, await decimalsOf(api, id, amount)));
}

/** Manages a token's allowlist (creator only): add / remove accounts, turn the restriction on or off. */
export async function allowList(
  api: ApiPromise,
  sender: Sender,
  id: number,
  change: { add?: string[]; remove?: string[]; restricted?: boolean },
): Promise<TxResult> {
  const W = api.tx.tokenAllowlist;
  const calls: SubmittableExtrinsic<"promise">[] = [];
  if (change.add?.length) calls.push(W.allow(id, change.add));
  if (change.remove?.length) calls.push(W.remove(id, change.remove));
  if (change.restricted !== undefined) calls.push(W.setRestricted(id, change.restricted));
  if (!calls.length) throw new Error("nothing to change");
  return submit(api, sender, batch(api, calls));
}

/** Locks a token's supply forever (creator only). Cannot be undone. */
export async function fixSupply(api: ApiPromise, sender: Sender, id: number): Promise<TxResult> {
  return submit(api, sender, api.tx.tokenAllowlist.fixSupply(id));
}

// ---------- NFTs ----------

export interface NftDetails {
  name: string;
  description?: string;
  /** https:// or ipfs:// link to the image. */
  image?: string;
}

const nftJson = (d: NftDetails) => {
  const s = JSON.stringify({ name: d.name, ...(d.description ? { description: d.description } : {}), ...(d.image ? { image: d.image } : {}) });
  if (encLen(s) > 256) throw new Error("name + description + image link: 256 bytes max");
  return s;
};

const nextCollectionId = async (api: ApiPromise) => {
  const n = (await api.query.nfts.nextCollectionId()) as any;
  return n.isSome ? (n.unwrap().toNumber() as number) : 0;
};

const collectionCalls = (api: ApiPromise, owner: string, d: NftDetails, id: number) => [
  api.tx.nfts.create(owner, {}),
  api.tx.nfts.setCollectionMetadata(id, nftJson(d)),
];

/** Creates an NFT collection; the sender owns it and can mint into it. */
export async function createCollection(api: ApiPromise, sender: Sender, details: NftDetails): Promise<TxResult & { collectionId: number }> {
  const id = await nextCollectionId(api);
  const res = await submit(api, sender, batch(api, collectionCalls(api, sender.address, details, id)));
  const created = res.events.find((e) => e.section === "nfts" && e.method === "Created");
  return { ...res, collectionId: created ? Number((created.data as any[])[0]) : id };
}

/** ZOOZ needed to create this collection. */
export async function estimateCreateCollection(api: ApiPromise, from: string, details: NftDetails): Promise<CostEstimate> {
  const c = api.consts.nfts as any;
  const deposit = c.collectionDeposit.toBigInt() + c.metadataDepositBase.toBigInt() + c.depositPerByte.toBigInt() * BigInt(encLen(nftJson(details)));
  const fee = (await batch(api, collectionCalls(api, from, details, await nextCollectionId(api))).paymentInfo(from)).partialFee.toBigInt();
  return { deposit, fee, total: deposit + fee };
}

/** Mints an NFT into a collection (to the sender unless `to` is given). Item numbers follow 1, 2, 3… */
export async function mintNft(
  api: ApiPromise,
  sender: Sender,
  collection: number,
  details: NftDetails & { to?: string; item?: number },
): Promise<TxResult & { item: number }> {
  let item = details.item;
  if (item === undefined) {
    const keys = (await api.query.nfts.item.keys(collection)) as any;
    item = keys.reduce((m: number, k: any) => Math.max(m, k.args[1].toNumber()), 0) + 1;
  }
  const res = await submit(
    api,
    sender,
    batch(api, [api.tx.nfts.mint(collection, item, details.to ?? sender.address, null), api.tx.nfts.setMetadata(collection, item, nftJson(details))]),
  );
  return { ...res, item: item! };
}

/** Sends an NFT. */
export async function transferNft(api: ApiPromise, sender: Sender, collection: number, item: number, to: string): Promise<TxResult> {
  return submit(api, sender, api.tx.nfts.transfer(collection, item, to));
}

export interface CollectionInfo {
  id: number;
  owner: string;
  items: number;
  details: NftDetails | null;
}

const parseDetails = (opt: any): NftDetails | null => {
  if (!opt?.isSome) return null;
  const s = utf8(opt.unwrap().data);
  try {
    return JSON.parse(s);
  } catch {
    return { name: s };
  }
};

/** One NFT collection, or null. */
export async function collectionInfo(api: ApiPromise, id: number): Promise<CollectionInfo | null> {
  const [c, m] = await Promise.all([api.query.nfts.collection(id) as any, api.query.nfts.collectionMetadataOf(id) as any]);
  if (c.isNone) return null;
  const v = c.unwrap();
  return { id, owner: v.owner.toString(), items: v.items.toNumber(), details: parseDetails(m) };
}

/** NFTs of a collection with their owner and details. */
export async function listNfts(api: ApiPromise, collection: number): Promise<{ item: number; owner: string; details: NftDetails | null }[]> {
  const [items, metas] = await Promise.all([api.query.nfts.item.entries(collection) as any, api.query.nfts.itemMetadataOf.entries(collection) as any]);
  const meta = new Map(metas.map(([k, v]: any) => [k.args[1].toNumber(), v]));
  return items
    .map(([k, v]: any) => ({ item: k.args[1].toNumber(), owner: v.unwrap().owner.toString(), details: parseDetails(meta.get(k.args[1].toNumber())) }))
    .sort((a: any, b: any) => a.item - b.item);
}
