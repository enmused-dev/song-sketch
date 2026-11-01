// Synthetic test songs with known answers: drums, bass and chords, rendered at any sample rate.
// Not realistic mixes, but they exercise every part of the pipeline with exact ground truth.

const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

export function parseChord(name) {
  const m = /^([A-G][#b]?)(m7|maj7|m|7|5)?$/.exec(name);
  if (!m) throw new Error('bad chord ' + name);
  const root = PC[m[1]];
  const q = m[2] || '';
  const tones = { '': [0, 4, 7], m: [0, 3, 7], '5': [0, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11] }[q];
  return { root, quality: q, tones };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Each bar: chord name. Sections: [{ label, bars: [...] }].
export function renderSong({ bpm, sections, sr = 22050, centsOffset = 0, seed = 1, drums = true, chordsPerBeat = false }) {
  const rand = rng(seed);
  const beat = 60 / bpm;
  const bars = sections.flatMap(s => s.bars);
  const total = bars.length * 4 * beat + 2;
  const x = new Float32Array(Math.ceil(total * sr));
  const tune = Math.pow(2, centsOffset / 1200);
  const hz = midi => 440 * Math.pow(2, (midi - 69) / 12) * tune;

  const tone = (start, dur, f, amp, harmonics, decay) => {
    const i0 = Math.floor(start * sr), n = Math.floor(dur * sr);
    const ph = rand() * 6.28;
    for (let i = 0; i < n && i0 + i < x.length; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * decay) * Math.min(1, (dur - t) / 0.02);
      let s = 0;
      for (let h = 1; h <= harmonics; h++) s += Math.sin(2 * Math.PI * f * h * t + ph * h) / Math.pow(h, 1.2);
      x[i0 + i] += amp * env * s;
    }
  };
  const noise = (start, dur, amp, decay, hp) => {
    const i0 = Math.floor(start * sr), n = Math.floor(dur * sr);
    let prev = 0;
    for (let i = 0; i < n && i0 + i < x.length; i++) {
      const w = rand() * 2 - 1;
      const v = hp ? w - prev : w;
      prev = w;
      x[i0 + i] += amp * Math.exp(-(i / sr) * decay) * v;
    }
  };
  const kick = start => {
    const i0 = Math.floor(start * sr);
    let ph = 0;
    for (let i = 0; i < 0.25 * sr && i0 + i < x.length; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * (50 + 90 * Math.exp(-t * 30))) / sr;
      x[i0 + i] += 0.7 * Math.exp(-t * 14) * Math.sin(ph);
    }
  };

  const truth = { beats: [], downbeats: [], chordAt: [], bars: [] };
  const t0 = 0.5;
  bars.forEach((name, b) => {
    const ch = parseChord(name);
    const barStart = t0 + b * 4 * beat;
    truth.bars.push({ time: barStart, chord: name });
    truth.downbeats.push(barStart);
    for (let k = 0; k < 4; k++) {
      const bt = barStart + k * beat;
      truth.beats.push(bt);
      truth.chordAt.push({ time: bt, chord: name });
      if (drums) {
        if (k === 0 || k === 2) kick(bt);
        if (k === 1 || k === 3) noise(bt, 0.18, 0.35, 25, false);
        noise(bt, 0.05, 0.08, 60, true);
        noise(bt + beat / 2, 0.05, 0.06, 60, true);
      }
      // Bass: root on every eighth, octave 2.
      const bassMidi = 36 + ((ch.root - 0 + 12) % 12);
      tone(bt, beat / 2 * 0.9, hz(bassMidi < 40 ? bassMidi + 12 : bassMidi), 0.35, 4, 3);
      tone(bt + beat / 2, beat / 2 * 0.9, hz(bassMidi < 40 ? bassMidi + 12 : bassMidi), 0.3, 4, 3);
      // Chords: close voicing around middle C, strummed on beats 1 and 3 (or every beat).
      if (chordsPerBeat || k === 0 || k === 2) {
        const len = chordsPerBeat ? beat * 0.95 : 2 * beat * 0.95;
        ch.tones.forEach((iv, j) => {
          const midi = 55 + ((ch.root + iv - 7 + 12) % 12);
          tone(bt + 0.008 * j, len, hz(midi), 0.12, 8, 1.2);
          tone(bt + 0.008 * j, len, hz(midi + 12), 0.06, 6, 1.5);
        });
      }
    }
  });
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < x.length; i++) x[i] = (0.8 * x[i]) / peak;
  return { audio: x, sr, truth, bpm };
}

export const SONGS = {
  pop: {
    bpm: 100, expectKey: ['C major', 'A minor'], expectCollection: 0, // vi-IV-I-V: genuinely either
    sections: [
      { label: 'A', bars: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'] },
      { label: 'B', bars: ['F', 'G', 'C', 'Am', 'F', 'G', 'C', 'C'] },
      { label: 'A', bars: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'] },
      { label: 'B', bars: ['F', 'G', 'C', 'Am', 'F', 'G', 'C', 'C'] },
    ],
  },
  dorian: {
    bpm: 92, expectKey: ['E Dorian'], expectCollection: 2,
    sections: [
      { label: 'A', bars: ['Em', 'Em', 'A', 'A', 'Em', 'Em', 'A', 'A'] },
      { label: 'B', bars: ['G', 'D', 'A', 'A', 'G', 'D', 'Em', 'Em'] },
      { label: 'A', bars: ['Em', 'Em', 'A', 'A', 'Em', 'Em', 'A', 'A'] },
    ],
  },
  mixolydian: {
    bpm: 120, expectKey: ['A Mixolydian'], expectCollection: 2,
    sections: [
      { label: 'A', bars: ['A', 'G', 'D', 'A', 'A', 'G', 'D', 'A'] },
      { label: 'B', bars: ['D', 'D', 'A', 'A', 'D', 'D', 'E', 'E'] },
      { label: 'A', bars: ['A', 'G', 'D', 'A', 'A', 'G', 'D', 'A'] },
      { label: 'B', bars: ['D', 'D', 'A', 'A', 'D', 'D', 'E', 'E'] },
    ],
  },
  fastFlat: {
    bpm: 138, expectKey: ['Bb major'], expectCollection: 10, chordsPerBeat: true,
    sections: [
      { label: 'A', bars: ['Bb', 'Eb', 'F', 'Bb', 'Gm', 'Eb', 'F', 'F'] },
      { label: 'A', bars: ['Bb', 'Eb', 'F', 'Bb', 'Gm', 'Eb', 'F', 'F'] },
      { label: 'B', bars: ['Cm', 'F', 'Bb', 'Gm', 'Cm', 'F', 'Bb', 'Bb'] },
    ],
  },
};
