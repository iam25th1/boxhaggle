// USDC amounts are integers in atomic units (6 decimals). 1 USDC = 1_000_000.
// Prices in this game stay far below Number.MAX_SAFE_INTEGER, so plain numbers are exact.

export const USDC_DECIMALS = 6;
export const ATOMIC_PER_USDC = 1_000_000;
export const ATOMIC_PER_CENT = 10_000;

/** Parse a decimal USD string such as "1.25" into atomic USDC without floating point. */
export function usdToAtomic(usd: string): number {
  if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,6})?$/.test(usd)) {
    throw new Error("amount must be a decimal USD string with at most 6 decimals");
  }
  const [whole = "0", fraction = ""] = usd.split(".");
  return Number(whole) * ATOMIC_PER_USDC + Number(fraction.padEnd(USDC_DECIMALS, "0"));
}

/** Format atomic USDC as a fixed two-decimal dollar string, rounding half up to the cent. */
export function formatUsd(atomic: number): string {
  const cents = Math.round(atomic / ATOMIC_PER_CENT);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Format atomic USDC with sub-cent precision, for fees such as $0.005. */
export function formatUsdPrecise(atomic: number): string {
  const sign = atomic < 0 ? "-" : "";
  const abs = Math.abs(atomic);
  const whole = Math.floor(abs / ATOMIC_PER_USDC);
  const fraction = String(abs % ATOMIC_PER_USDC).padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const shown = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${sign}$${whole}.${shown}`;
}

/** Round up to the next whole cent. */
export function ceilToCent(atomic: number): number {
  return Math.ceil(atomic / ATOMIC_PER_CENT) * ATOMIC_PER_CENT;
}

/** Round down to a whole cent. */
export function floorToCent(atomic: number): number {
  return Math.floor(atomic / ATOMIC_PER_CENT) * ATOMIC_PER_CENT;
}
