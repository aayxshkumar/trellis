// Fractional indexing: order keys as base-62 strings, so a node can be placed
// between two siblings without renumbering anything. Keys compare with plain
// string comparison and never end in the smallest digit, which guarantees
// there is always room for another key below any key.

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const idx = (c) => DIGITS.indexOf(c);

// A key strictly between a and b (a < b). null or "" for a means "before
// everything", null for b means "after everything".
export function between(a, b) {
  a = a || "";
  if (b !== null && b !== undefined && !(a < b)) throw new Error(`between: ${JSON.stringify(a)} !< ${JSON.stringify(b)}`);
  let out = "";
  let upper = b ?? null;
  for (let i = 0; ; i++) {
    const da = i < a.length ? idx(a[i]) : 0;
    const db = upper !== null && i < upper.length ? idx(upper[i]) : BASE;
    if (da === db) {
      out += DIGITS[da];
      continue;
    }
    const mid = Math.floor((da + db) / 2);
    if (mid > da) return out + DIGITS[mid];
    // Adjacent digits: keep a's digit and look for room after it, with no upper bound.
    out += DIGITS[da];
    upper = null;
  }
}

// n keys in increasing order, all strictly between a and b.
export function spread(a, b, n) {
  const keys = [];
  let lo = a;
  for (let k = 0; k < n; k++) {
    lo = between(lo, b);
    keys.push(lo);
  }
  return keys;
}
