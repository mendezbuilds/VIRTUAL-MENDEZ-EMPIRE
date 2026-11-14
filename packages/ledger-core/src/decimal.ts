/**
 * High-precision fixed decimal arithmetic for financial ledgers (supports up to 8 decimal places).
 * Avoids IEEE 754 floating point imprecision.
 */
const SCALE = 8;
const FACTOR = 100_000_000n;

export function parseToMicroUnits(val: string): bigint {
  const [whole = '0', fraction = ''] = val.trim().split('.');
  const paddedFraction = (fraction + '00000000').slice(0, SCALE);
  const isNegative = whole.startsWith('-');
  const cleanWhole = isNegative ? whole.slice(1) : whole;
  const bigVal = BigInt(cleanWhole) * FACTOR + BigInt(paddedFraction);
  return isNegative ? -bigVal : bigVal;
}

export function formatFromMicroUnits(units: bigint): string {
  const isNegative = units < 0n;
  const absUnits = isNegative ? -units : units;
  const whole = absUnits / FACTOR;
  const frac = (absUnits % FACTOR).toString().padStart(SCALE, '0');
  // Trim trailing zeros down to 2 decimals minimum
  const trimmed = frac.replace(/0+$/, '');
  const finalFrac = trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed;
  return `${isNegative ? '-' : ''}${whole.toString()}.${finalFrac}`;
}
