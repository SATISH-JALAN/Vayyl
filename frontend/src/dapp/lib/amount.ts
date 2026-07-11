export const STROOPS_PER_XLM = 10_000_000n;

export function xlmToStroops(value: string): bigint {
  const input = value.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(input)) {
    throw new Error('Enter a positive XLM amount with at most 7 decimal places.');
  }

  const [whole, fraction = ''] = input.split('.');
  const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, '0'));
  if (stroops <= 0n) throw new Error('Amount must be greater than 0 XLM.');
  return stroops;
}
