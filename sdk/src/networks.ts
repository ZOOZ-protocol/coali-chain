export interface Network {
  name: string;
  /** WebSocket RPC endpoint of a public node. */
  rpc: string;
  /** Explorer website. */
  explorer: string;
  /** Explorer JSON API. */
  api: string;
  /** SS58 address prefix. */
  ss58: number;
  /** ZOOZ decimals: 1 ZOOZ = 10^decimals planck. */
  decimals: number;
}

export const TESTNET: Network = {
  name: "Coali Testnet",
  rpc: "wss://rpc.testnet.coali.app",
  explorer: "https://explorer.testnet.coali.app",
  api: "https://explorer.testnet.coali.app/api",
  ss58: 42,
  decimals: 9,
};
