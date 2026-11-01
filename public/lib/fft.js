// Small radix-2 FFT for the onset detector (Essentia does the tonal analysis).

export function makeFFT(n) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of two');
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
    rev[i] = r;
  }
  const re = new Float64Array(n), im = new Float64Array(n);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  // Magnitude spectrum (n/2 + 1 bins) of a Hann-windowed frame.
  return function magnitude(frame, out) {
    for (let i = 0; i < n; i++) { re[rev[i]] = frame[i] * window[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += step) {
          const tre = re[j + halfSize] * cos[k] + im[j + halfSize] * sin[k];
          const tim = -re[j + halfSize] * sin[k] + im[j + halfSize] * cos[k];
          re[j + halfSize] = re[j] - tre; im[j + halfSize] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  };
}
