import { TESTNET } from "./networks.js";

/** Planck amount (string or bigint) to a ZOOZ decimal string, e.g. "2500000000" -> "2.5". */
export function formatZooz(planck: string | bigint, decimals = TESTNET.decimals): string {
  const v = BigInt(planck);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** ZOOZ decimal string to planck, e.g. "2.5" -> 2500000000n. */
export function parseZooz(zooz: string, decimals = TESTNET.decimals): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(zooz.trim());
  if (!m) throw new Error(`invalid amount: ${zooz}`);
  const frac = (m[3] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new Error(`too many decimals: ${zooz}`);
  const v = BigInt(m[2]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return m[1] ? -v : v;
}
