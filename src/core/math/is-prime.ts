/**
 * Reports whether a finite integer is prime.
 *
 * Number inputs must be safe integers. Values outside that range, decimals,
 * NaN, Infinity, and values below 2 are not prime. BigInt inputs are checked
 * with Miller-Rabin: the fixed bases are deterministic below 2^64 and give a
 * very low false-positive rate above that threshold.
 */
export function isPrime(value: number | bigint): boolean {
  const candidate =
    typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : 0n;

  if (candidate < 2n) {
    return false;
  }

  const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];

  if (bases.some((base) => candidate === base)) {
    return true;
  }

  if (bases.some((base) => candidate % base === 0n)) {
    return false;
  }

  let exponent = candidate - 1n;
  let twos = 0;

  while (exponent % 2n === 0n) {
    exponent /= 2n;
    twos += 1;
  }

  const modPow = (base: bigint, power: bigint, modulus: bigint): bigint => {
    let result = 1n;
    let current = base % modulus;
    let remaining = power;

    while (remaining > 0n) {
      if (remaining % 2n === 1n) {
        result = (result * current) % modulus;
      }

      current = (current * current) % modulus;
      remaining /= 2n;
    }

    return result;
  };

  return bases.every((base) => {
    let witness = modPow(base, exponent, candidate);

    if (witness === 1n || witness === candidate - 1n) {
      return true;
    }

    for (let round = 1; round < twos; round += 1) {
      witness = (witness * witness) % candidate;

      if (witness === candidate - 1n) {
        return true;
      }
    }

    return false;
  });
}
