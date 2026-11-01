// Beat tracking on an onset-strength envelope, given the tempo.
// Method: D. P. W. Ellis, "Beat Tracking by Dynamic Programming", JNMR 2007.

function prepare(ose) {
  // Remove the slowly varying level (centred moving average), keep only rises, unit variance.
  const n = ose.length, w = 16;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + ose[i];
  const out = new Float64Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    out[i] = Math.max(0, ose[i] - mean);
    ss += out[i] * out[i];
  }
  const sd = Math.sqrt(ss / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

// Beat positions (frame indices) in the envelope, given the beat period in frames.
export function trackBeats(ose, period, tightness = 100) {
  const n = ose.length;
  if (n < 2 * period) return [];
  // Smooth the envelope with a Gaussian of width period/32 (Ellis).
  const sigma = Math.max(1, period / 32);
  const half = Math.ceil(3 * sigma);
  const local = new Float64Array(n);
  const x = prepare(ose);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -half; d <= half; d++) {
      const j = i + d;
      if (j >= 0 && j < n) s += x[j] * Math.exp(-0.5 * (d / sigma) ** 2);
    }
    local[i] = s;
  }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(2 * period), hi = Math.round(period / 2);
  for (let t = 0; t < n; t++) {
    let bestScore = -Infinity, bestPrev = -1;
    for (let p = t - lo; p <= t - hi; p++) {
      if (p < 0) continue;
      const tx = -tightness * Math.pow(Math.log((t - p) / period), 2);
      const s = cum[p] + tx;
      if (s > bestScore) { bestScore = s; bestPrev = p; }
    }
    if (bestPrev >= 0 && bestScore > 0) {
      cum[t] = local[t] + bestScore;
      back[t] = bestPrev;
    } else {
      cum[t] = local[t];
    }
  }
  // Start the backtrace at the best-scoring frame within the last beat period.
  let end = n - 1, endScore = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (cum[t] > endScore) { endScore = cum[t]; end = t; }
  }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  return beats.reverse();
}
