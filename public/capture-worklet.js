// Runs on the audio thread: mixes to mono, low-pass filters, decimates to ~22-24 kHz,
// and posts blocks to the page, stamped with the audio clock.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.factor = options.processorOptions.factor;
    this.out = new Float32Array(2048);
    this.n = 0;
    this.phase = 0;
    // Windowed-sinc low-pass at 0.45 of the output Nyquist frequency (anti-aliasing).
    const taps = 63, fc = 0.45 / this.factor, mid = (taps - 1) / 2;
    this.h = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      this.h[i] = sinc * w;
      sum += this.h[i];
    }
    for (let i = 0; i < taps; i++) this.h[i] /= sum;
    this.hist = new Float32Array(taps);
    this.pos = 0;
    this.blockFrame = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const len = input[0].length, ch = input.length, taps = this.h.length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += input[c][i];
      this.hist[this.pos] = s / ch;
      this.pos = (this.pos + 1) % taps;
      if (++this.phase < this.factor) continue;
      this.phase = 0;
      let y = 0;
      for (let k = 0; k < taps; k++) y += this.h[k] * this.hist[(this.pos + k) % taps];
      if (this.n === 0) this.blockFrame = currentFrame + i; // audio-clock frame of this block's first sample
      this.out[this.n++] = y;
      if (this.n === this.out.length) {
        this.port.postMessage({ samples: this.out, frame: this.blockFrame }, [this.out.buffer]);
        this.out = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
