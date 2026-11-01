// The analysis engine: feed it mono audio, ask it for the current sketch of the song.
// Runs in the browser's analysis worker and in Node tests; Essentia is passed in.

import { makeFFT } from './fft.js';
import { trackBeats } from './beats.js';
import {
  STATES, assembleBars, decodeChords, describeTonality, downbeatPhase, emissionScores, findSections, phraseRoots, profiles,
} from './harmony.js';
import { chordName, chordTones, noteName } from './theory.js';

const HOP = 512;            // onset hop
const ONSET_FFT = 1024;
const TONAL_FRAME = 4096;   // tonal analysis every 2 hops (~46 ms at 22 kHz)
const TEMPO_WINDOW_S = 16;   // audio used for each tempo estimate
const TEMPO_EVERY_S = 2;
const PREFERRED_BPM = [72, 175]; // fold double/half-time readings into this range
const FINALIZE_LAG_S = 2.0; // beats are committed once they are this far in the past
const SILENCE_DB = -55;
const NOTE_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

function fold36(h36) {
  // Essentia's HPCP bin 0 is A. Fold 3 bins per semitone into 12 pitch classes, 0 = C.
  const out = new Array(12).fill(0);
  for (let j = 0; j < 12; j++) {
    const v = h36[(3 * j + 35) % 36] + h36[3 * j] + h36[3 * j + 1];
    out[(9 + j) % 12] = v;
  }
  return out;
}

// The chord movement: consecutive beats with the same chord merged, most recent last.
function chordChanges(states, flats, beatTimes) {
  const runs = [];
  states.forEach((k, i) => {
    const last = runs[runs.length - 1];
    if (last && last.state === k) last.beats++;
    else runs.push({ state: k, beats: 1, time: beatTimes[i] });
  });
  return runs.slice(-16).map(r => ({
    chord: STATES[r.state].root < 0 ? 'N' : chordName(STATES[r.state].root, STATES[r.state].type, flats),
    beats: r.beats,
    time: r.time,
  }));
}

export class SketchEngine {
  constructor(essentia, sampleRate) {
    this.e = essentia;
    this.sr = sampleRate;
    this.fps = sampleRate / HOP;
    this.mag = makeFFT(ONSET_FFT);
    this.spec = new Float64Array(ONSET_FFT / 2 + 1);
    this.prevLog = new Float64Array(ONSET_FFT / 2 + 1);
    this.buf = new Float32Array(TONAL_FRAME);
    this.pending = [];         // samples not yet consumed by a hop
    this.pendingLen = 0;
    this.hops = 0;
    this.ose = [];             // onset strength per hop
    this.oseLow = [];          // low-band (kick/bass) onset strength per hop
    this.frames = [];          // tonal frames: { t, chroma, bass, rms }
    this.tuningCents = [];
    this.refHz = 440;
    this.pcpSong = new Float64Array(36);
    this.pcpNow = new Float64Array(36);
    this.beats = [];           // committed beat times (s)
    this.beatFeats = [];       // features per committed beat interval
    this.tempo = null;
    this.phase = 0;
    this.phaseScores = null;
    this.keyHistory = [];
    this.nowCollection = null;
    this.lastRms = 0;
    this.quietSince = null;
    this.ring = new Float32Array(Math.round(TEMPO_WINDOW_S * sampleRate));
    this.ringPos = 0;
    this.ringFilled = 0;
    this.tempoReadings = [];
    this.lastTempoAt = -Infinity;
    this.tempoScale = 1;     // user override: 0.5 or 2 when the detected level is wrong
  }

  setTempoScale(scale) {
    this.tempoScale = scale;
  }

  get time() { return (this.hops * HOP) / this.sr; }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringPos] = samples[i];
      this.ringPos = (this.ringPos + 1) % this.ring.length;
    }
    this.ringFilled = Math.min(this.ring.length, this.ringFilled + samples.length);
    this.pending.push(samples);
    this.pendingLen += samples.length;
    while (this.pendingLen >= HOP) {
      const hop = new Float32Array(HOP);
      let filled = 0;
      while (filled < HOP) {
        const head = this.pending[0];
        const take = Math.min(HOP - filled, head.length);
        hop.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) this.pending.shift();
        else this.pending[0] = head.subarray(take);
      }
      this.pendingLen -= HOP;
      this.processHop(hop);
    }
  }

  processHop(hop) {
    this.buf.copyWithin(0, HOP);
    this.buf.set(hop, TONAL_FRAME - HOP);
    this.hops++;

    // Onset strength: positive change in log magnitude, full band and low band.
    this.mag(this.buf.subarray(TONAL_FRAME - ONSET_FFT), this.spec);
    let flux = 0, low = 0;
    const lowBins = Math.round((200 * ONSET_FFT) / this.sr);
    const topBin = Math.min(this.spec.length - 1, Math.round((8000 * ONSET_FFT) / this.sr));
    for (let k = 1; k <= topBin; k++) {
      const l = Math.log1p(100 * this.spec[k]);
      const d = l - this.prevLog[k];
      if (d > 0) { flux += d; if (k <= lowBins) low += d; }
      this.prevLog[k] = l;
    }
    this.ose.push(flux);
    this.oseLow.push(low);

    if (this.hops % 2 === 0) this.processTonalFrame();
  }

  processTonalFrame() {
    const e = this.e;
    const t = this.time - TONAL_FRAME / 2 / this.sr; // centre of the frame
    let ss = 0;
    for (let i = 0; i < TONAL_FRAME; i++) ss += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(ss / TONAL_FRAME);
    this.lastRms = rms;
    const db = 20 * Math.log10(rms + 1e-12);
    if (db < SILENCE_DB) {
      this.frames.push({ t, chroma: new Array(12).fill(0), bass: new Array(12).fill(0), rms });
      if (this.quietSince === null) this.quietSince = t;
      return;
    }
    this.quietSince = null;
    // Every Essentia vector is freed explicitly: without it the WASM heap grows ~1 MB/s.
    const v = e.arrayToVector(this.buf);
    const w = e.Windowing(v, true, TONAL_FRAME, 'blackmanharris62');
    const s = e.Spectrum(w.frame, TONAL_FRAME);
    const p = e.SpectralPeaks(s.spectrum, 0, 5000, 100, 40, 'magnitude', this.sr);
    const h = e.HPCP(p.frequencies, p.magnitudes, true, 500, 8, 5000, false, 100, false, 'unitMax', this.refHz, this.sr, 36, 'squaredCosine', 1);
    const hb = e.HPCP(p.frequencies, p.magnitudes, false, 500, 0, 250, false, 40, false, 'unitMax', this.refHz, this.sr, 36, 'squaredCosine', 1);
    let tuning = null;
    if (this.tuningCents.length < 400) tuning = e.TuningFrequency(p.frequencies, p.magnitudes, 1);
    const h36 = e.vectorToArray(h.hpcp), hb36 = e.vectorToArray(hb.hpcp);
    for (const o of [v, w.frame, s.spectrum, p.frequencies, p.magnitudes, h.hpcp, hb.hpcp]) o.delete();

    if (tuning && Number.isFinite(tuning.tuningCents)) {
      this.tuningCents.push(tuning.tuningCents);
      // Once enough evidence is in, analyse relative to the recording's own tuning.
      if (this.tuningCents.length === 200) this.refHz = 440 * Math.pow(2, this.medianCents() / 1200);
    }
    const weight = Math.sqrt(rms);
    const a = Math.exp(-1 / (20 * this.fps / 2)); // ~20 s memory for "current" tonality
    for (let k = 0; k < 36; k++) {
      this.pcpSong[k] += weight * h36[k];
      this.pcpNow[k] = a * this.pcpNow[k] + (1 - a) * weight * h36[k];
    }
    this.frames.push({ t, chroma: fold36(h36), bass: fold36(hb36), rms });
  }

  medianCents() {
    if (!this.tuningCents.length) return 0;
    const s = this.tuningCents.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  // ---------------------------------------------------------------- beats

  // Tempo from Essentia's PercivalBpmEstimator (Percival & Tzanetakis 2014) on the last
  // 16 s, folded into a preferred range, then the median of recent readings.
  updateTempo() {
    if (this.ringFilled < this.ring.length * 0.5 || this.time - this.lastTempoAt < TEMPO_EVERY_S) return;
    this.lastTempoAt = this.time;
    const recent = this.frames.slice(-Math.round((4 * this.fps) / 2));
    const loud = recent.filter(f => f.rms > 0 && 20 * Math.log10(f.rms) > SILENCE_DB).length;
    if (!recent.length || loud < recent.length / 2) return; // a tempo estimator finds "beats" in noise
    const n = this.ringFilled;
    const seg = new Float32Array(n);
    const start = (this.ringPos - n + this.ring.length) % this.ring.length;
    for (let i = 0; i < n; i++) seg[i] = this.ring[(start + i) % this.ring.length];
    const v = this.e.arrayToVector(seg);
    const r = this.e.PercivalBpmEstimator(v, 1024, 2048, 128, 128, 210, 50, this.sr);
    v.delete();
    let bpm = r.bpm;
    if (!(bpm > 0)) return;
    while (bpm < PREFERRED_BPM[0]) bpm *= 2;
    while (bpm >= PREFERRED_BPM[1]) bpm /= 2;
    this.tempoReadings.push(bpm);
    if (this.tempoReadings.length > 7) this.tempoReadings.shift();
    const sorted = this.tempoReadings.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const agree = this.tempoReadings.filter(b => Math.abs(b - median) / median < 0.03).length / this.tempoReadings.length;
    // Hysteresis: keep the current tempo unless the median has clearly moved.
    if (!this.baseBpm || Math.abs(median - this.baseBpm) / this.baseBpm > 0.02) this.baseBpm = median;
    this.tempoAgreement = agree;
  }

  updateBeats() {
    this.updateTempo();
    if (!this.baseBpm) return;
    const bpm = this.baseBpm * this.tempoScale;
    const period = (60 * this.fps) / bpm;
    this.tempo = { bpm, period, confidence: this.tempoAgreement || 0 };
    // Track over the whole song each time: one consistent beat grid, and early mistakes heal.
    const beatFrames = trackBeats(this.ose, period);
    const cut = this.time - FINALIZE_LAG_S;
    this.beats = beatFrames.map(f => f / this.fps).filter(t => t <= cut);
    this.beatFeats = [];
    this.frameCursor = 0;
    this.updateBeatFeatures();
  }

  updateBeatFeatures() {
    // Features for each completed beat interval [b_i, b_i+1). Frames are in time order,
    // so a cursor remembers where the previous beat's frames ended.
    if (this.frameCursor === undefined) this.frameCursor = 0;
    for (let i = this.beatFeats.length; i + 1 < this.beats.length; i++) {
      const a = this.beats[i], b = this.beats[i + 1];
      const chroma = new Array(12).fill(0), bass = new Array(12).fill(0);
      let energy = 0, count = 0;
      let k = this.frameCursor;
      while (k > 0 && this.frames[k - 1].t >= a) k--;
      while (k < this.frames.length && this.frames[k].t < a) k++;
      for (; k < this.frames.length && this.frames[k].t < b; k++) {
        const f = this.frames[k];
        for (let j = 0; j < 12; j++) { chroma[j] += f.chroma[j]; bass[j] += f.bass[j]; }
        energy += f.rms * f.rms;
        count++;
      }
      this.frameCursor = k;
      const hop0 = Math.round(a * this.fps);
      let low = 0;
      for (let h = Math.max(0, hop0 - 2); h <= Math.min(this.oseLow.length - 1, hop0 + 2); h++) low = Math.max(low, this.oseLow[h]);
      this.beatFeats.push({ chroma, bass, energy: count ? energy / count : 0, low, t: a });
    }
  }

  // ---------------------------------------------------------------- key

  keyFromPcp(pcp36) {
    let sum = 0;
    for (const x of pcp36) sum += x;
    if (sum <= 0) return null;
    const v = this.e.arrayToVector(Float32Array.from(pcp36));
    // Plain diatonic profile: we want the pitch collection (which seven notes); the tonal
    // centre within it is decided separately from bass and chord roots. The polyphony and
    // three-chord options pulled the answer a fifth away on test material.
    const k = this.e.Key(v, 4, 36, 'diatonic', 0.6, false, false, false);
    v.delete();
    const tonic = NOTE_INDEX[k.key];
    if (tonic === undefined) return null;
    const collection = k.scale === 'minor' ? (tonic + 3) % 12 : tonic;
    return { collection, strength: k.strength, label: `${k.key} ${k.scale}` };
  }

  // ---------------------------------------------------------------- sketch

  sketch() {
    this.updateBeats();
    const beats = this.beatFeats;
    const silence = this.silenceLevel();
    const { states, confidence } = decodeChords(beats, silence);

    // Downbeat with hysteresis: switch only if clearly better, so bar lines don't jump around.
    const db = downbeatPhase(beats, states);
    if (db.scores[db.phase] > 1.15 * (db.scores[this.phase] || 0) || beats.length < 16) this.phase = db.phase;
    this.phaseScores = db.scores;

    const songKey = this.keyFromPcp(this.pcpSong);
    const nowKey = this.keyFromPcp(this.pcpNow);
    // Spelling (sharps or flats) follows the song's key signature.
    const flats = songKey ? [5, 10, 3, 8, 1, 6].includes(songKey.collection) : false;
    const bars = assembleBars(states, confidence, this.phase, flats);
    bars.forEach(b => { b.time = this.beats[b.firstBeat]; });

    // Bar features for section finding.
    const barFeatures = [], barEnergy = [];
    for (const b of bars) {
      const f = new Array(24).fill(0);
      let en = 0;
      for (let i = b.firstBeat; i < b.firstBeat + b.beats; i++) {
        const c = beats[i];
        let mc = 0, mb = 0;
        for (let j = 0; j < 12; j++) { mc = Math.max(mc, c.chroma[j]); mb = Math.max(mb, c.bass[j]); }
        for (let j = 0; j < 12; j++) { f[j] += mc ? c.chroma[j] / mc : 0; f[12 + j] += mb ? 0.7 * c.bass[j] / mb : 0; }
        en += c.energy;
      }
      barFeatures.push(f);
      barEnergy.push(en / Math.max(1, b.beats));
    }
    const sections = bars.length >= 8 ? findSections(bars, barFeatures, barEnergy) : [];

    const songProf = profiles(beats, states);
    songProf.phrase = phraseRoots(bars, sections);
    const song = songKey ? describeTonality(songKey.collection, songProf) : null;

    // Current tonality: recent profile, and only switch after it holds for 3 updates.
    let now = null;
    if (nowKey) {
      this.keyHistory.push(nowKey.collection);
      if (this.keyHistory.length > 3) this.keyHistory.shift();
      if (this.nowCollection === null || this.keyHistory.every(c => c === nowKey.collection)) this.nowCollection = nowKey.collection;
      const nowProf = profiles(beats, states, { halfLifeBeats: 32 });
      // Phrase evidence from the last ~16 bars only, weighted towards the most recent.
      const recentFrom = Math.max(0, bars.length - 16);
      const weights = bars.map((_, i) => (i >= recentFrom ? Math.pow(0.5, (bars.length - 1 - i) / 8) : 0));
      nowProf.phrase = phraseRoots(bars, sections, weights);
      // Same seven notes as the song overall: stay with the song's home note unless the
      // recent music overwhelmingly says otherwise. A real key change alters the notes
      // themselves, and then the recent evidence decides on its own.
      const sameAsSong = song && this.nowCollection === songKey.collection;
      now = sameAsSong
        ? describeTonality(this.nowCollection, nowProf, song.tonic, 0.6)
        : describeTonality(this.nowCollection, nowProf, this.nowTonic ?? null);
      this.nowTonic = now.tonic;
    }

    return {
      time: this.time,
      status: this.status(),
      tempo: this.tempo ? { bpm: Math.round(this.tempo.bpm * 10) / 10, confidence: this.tempo.confidence } : null,
      beat: this.beats.length ? {
        last: this.beats[this.beats.length - 1],
        period: this.tempo ? this.tempo.period / this.fps : null,
        // position of the last committed beat within its bar (0 = downbeat)
        index: ((this.beats.length - 1 - this.phase) % 4 + 4) % 4,
        count: this.beats.length,
      } : null,
      tuning: this.tuningCents.length >= 50 ? { cents: Math.round(this.medianCents()), hz: Math.round(440 * Math.pow(2, this.medianCents() / 1200) * 10) / 10 } : null,
      chordNow: this.chordNow(flats),
      now,
      song,
      songKeyLabel: songKey ? songKey.label : null,
      bars,
      sections,
      meter: '4/4 (assumed)',
      changes: chordChanges(states, flats, this.beats),
      beatTimes: this.beats.slice(0, states.length),
      beatChords: states.map(k => (STATES[k].root < 0 ? 'N' : chordName(STATES[k].root, STATES[k].type, flats))),
    };
  }

  silenceLevel() {
    if (!this.beatFeats.length) return 0;
    const e = this.beatFeats.map(b => b.energy).sort((a, b) => a - b);
    return e[Math.floor(e.length / 2)] * 0.02;
  }

  // Chord over roughly the last beat, without smoothing: what is sounding right now.
  chordNow(flats) {
    const span = this.tempo ? Math.max(0.3, this.tempo.period / this.fps) : 0.5;
    const from = this.time - span - TONAL_FRAME / this.sr;
    const recent = this.frames.filter(f => f.t >= from);
    if (!recent.length || this.quietSince !== null) return null;
    const chroma = new Array(12).fill(0), bass = new Array(12).fill(0);
    let energy = 0;
    for (const f of recent) for (let j = 0; j < 12; j++) { chroma[j] += f.chroma[j]; bass[j] += f.bass[j]; energy += f.rms; }
    const sc = emissionScores({ chroma, bass, energy }, 0);
    let best = 1, second = -Infinity;
    for (let s = 2; s < STATES.length; s++) if (sc[s] > sc[best]) best = s;
    for (let s = 1; s < STATES.length; s++) if (s !== best && STATES[s].root !== STATES[best].root) second = Math.max(second, sc[s]);
    const st = STATES[best];
    if (sc[best] < sc[0]) return null;
    return {
      name: chordName(st.root, st.type, flats),
      tones: chordTones(st.root, st.type),
      toneNames: chordTones(st.root, st.type).map(pc => noteName(pc, flats)),
      confidence: Math.max(0, Math.min(1, (sc[best] - second) * 5)),
    };
  }

  status() {
    if (this.quietSince !== null && this.time - this.quietSince > 3) return 'quiet';
    if (!this.tempo) return 'warming up';
    return 'listening';
  }
}
