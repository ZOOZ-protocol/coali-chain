// Browser wallet connection (SubWallet, Talisman, Polkadot.js extension), no extra dependency:
// these extensions all expose the standard `window.injectedWeb3` interface.
import type { ApiPromise } from "@polkadot/api";
import type { Signer } from "@polkadot/types/types";
import { TESTNET } from "./networks.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WalletInfo {
  /** Key in `window.injectedWeb3`. */
  id: string;
  name: string;
  /** Where to get it if it is not installed. */
  install: string;
}

export const WALLETS: WalletInfo[] = [
  { id: "subwallet-js", name: "SubWallet", install: "https://www.subwallet.app/download.html" },
  { id: "talisman", name: "Talisman", install: "https://talisman.xyz/download" },
  { id: "polkadot-js", name: "Polkadot.js", install: "https://polkadot.js.org/extension/" },
];

export interface WalletAccount {
  /** Coalichain address (SS58 prefix 42). */
  address: string;
  name?: string;
  /** Wallet id it comes from. */
  source: string;
  /** Pass the account itself as `sender` to the token functions. */
  signer: Signer;
}

export interface WalletConnection {
  wallet: WalletInfo;
  accounts: WalletAccount[];
  /** Stops listening to account changes. */
  disconnect: () => void;
}

function u8aToBase64(u8a: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8a.length; i += 0x8000) s += String.fromCharCode(...u8a.subarray(i, i + 0x8000));
  return btoa(s);
}

const injected = () => ((globalThis as any).window?.injectedWeb3 ?? {}) as Record<string, any>;

/** Wallets installed in this browser. Extensions load a moment after the page, so this waits up to `waitMs`. */
export async function installedWallets(waitMs = 1000): Promise<WalletInfo[]> {
  const end = Date.now() + waitMs;
  for (;;) {
    const found = Object.keys(injected());
    if (found.length || Date.now() >= end) {
      return found.map((id) => WALLETS.find((w) => w.id === id) ?? { id, name: id, install: "" });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function reencode(address: string): Promise<string> {
  const { decodeAddress, encodeAddress } = await import("@polkadot/util-crypto");
  return encodeAddress(decodeAddress(address), TESTNET.ss58);
}

/**
 * Asks the user to connect a wallet (opens the extension's approval popup) and returns its accounts.
 * Uses the first installed wallet among SubWallet, Talisman, Polkadot.js unless `walletId` is given.
 * Pass `api` to also send the chain description to the wallet, so it shows readable transactions.
 *
 *   const { accounts } = await connectWallet("My app", { api });
 *   await createToken(api, accounts[0], { name: "Club", symbol: "CLB", supply: 100 });
 */
export async function connectWallet(
  appName: string,
  opts: { walletId?: string; api?: ApiPromise; onAccountsChange?: (accounts: WalletAccount[]) => void } = {},
): Promise<WalletConnection> {
  const installed = await installedWallets();
  const preferred = opts.walletId ?? WALLETS.map((w) => w.id).find((id) => installed.some((w) => w.id === id)) ?? installed[0]?.id;
  if (!preferred || !injected()[preferred]) {
    throw Object.assign(new Error("No wallet found. Install SubWallet, Talisman or Polkadot.js."), { code: "wallet.NotInstalled", wallets: WALLETS });
  }
  const wallet = installed.find((w) => w.id === preferred) ?? { id: preferred, name: preferred, install: "" };
  const ext = await injected()[preferred].enable(appName);
  const toAccounts = async (list: any[]): Promise<WalletAccount[]> =>
    Promise.all(
      list
        .filter((a) => !a.type || a.type === "sr25519" || a.type === "ed25519" || a.type === "ecdsa")
        .map(async (a) => ({ address: await reencode(a.address), name: a.name, source: preferred, signer: ext.signer })),
    );
  const accounts = await toAccounts(await ext.accounts.get());
  if (opts.api) await provideMetadata(opts.api, ext).catch(() => undefined);
  const unsub = opts.onAccountsChange ? ext.accounts.subscribe?.(async (l: any[]) => opts.onAccountsChange!(await toAccounts(l))) : undefined;
  return { wallet, accounts, disconnect: () => (typeof unsub === "function" ? unsub() : undefined) };
}

/** Sends the chain description (name, token, metadata) to the wallet if it does not know this version yet. */
export async function provideMetadata(api: ApiPromise, ext: any): Promise<boolean> {
  if (!ext?.metadata?.provide) return false;
  const genesisHash = api.genesisHash.toHex();
  const specVersion = api.runtimeVersion.specVersion.toNumber();
  const known = (await ext.metadata.get?.()) ?? [];
  if (known.some((m: any) => m.genesisHash === genesisHash && m.specVersion === specVersion)) return false;
  return ext.metadata.provide({
    chain: (await api.rpc.system.chain()).toString(),
    chainType: "substrate",
    genesisHash,
    icon: "substrate",
    ss58Format: TESTNET.ss58,
    specVersion,
    tokenDecimals: TESTNET.decimals,
    tokenSymbol: "ZOOZ",
    types: {},
    rawMetadata: api.runtimeMetadata.toHex(),
    metaCalls: u8aToBase64(api.runtimeMetadata.asCallsOnly.toU8a()),
  });
}
