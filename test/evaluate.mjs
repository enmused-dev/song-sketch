// Run the synthetic songs through the engine as the browser would (1-second updates)
// and score tempo, beats, bar lines, chords, key and sections against the known answers.
//   node test/evaluate.mjs            all songs, summary
//   node test/evaluate.mjs pop -v     one song, with the chord chart

import { createRequire } from 'node:module';
import { SketchEngine } from '../public/lib/sketch.js';
import { SONGS, renderSong, parseChord } from './songs.mjs';

const require = createRequire(import.meta.url);
const EssentiaWASM = require('essentia.js/dist/essentia-wasm.umd.js');
const Essentia = require('essentia.js/dist/essentia.js-core.umd.js');
export const essentia = new Essentia(EssentiaWASM);

export function runSong(song, { sr = 22050, centsOffset = 0, onUpdate } = {}) {
  const { audio, truth } = renderSong({ ...song, sr, centsOffset });
  const engine = new SketchEngine(essentia, sr);
  const chunk = 2048;
  let nextUpdate = 1, sk = null;
  const t0 = performance.now();
  for (let i = 0; i < audio.length; i += chunk) {
    engine.push(audio.subarray(i, i + chunk));
    if (engine.time >= nextUpdate) {
      sk = engine.sketch();
      if (onUpdate) onUpdate(sk);
      nextUpdate += 1;
    }
  }
  sk = engine.sketch();
  const ms = performance.now() - t0;
  return { sketch: sk, truth, ms, audioS: audio.length / sr };
}

function nearestIdx(arr, t) {
  let best = -1, d = Infinity;
  arr.forEach((v, i) => { const dd = Math.abs(v - t); if (dd < d) { d = dd; best = i; } });
  return { i: best, d };
}

export function score(result, song) {
  const { sketch: sk, truth } = result;
  const out = {};
  out.bpm = sk.tempo ? sk.tempo.bpm : null;
  out.tempoOk = !!sk.tempo && Math.abs(sk.tempo.bpm - song.bpm) / song.bpm < 0.03;

  // Beats: F-measure with a 70 ms window (MIREX convention).
  const est = sk.beatTimes;
  const tol = 0.07;
  const lastEst = est.length ? est[est.length - 1] : 0;
  const ref = truth.beats.filter(b => b <= lastEst + tol && b >= 5);
  const estIn = est.filter(b => b >= 5);
  let hits = 0;
  const used = new Set();
  for (const b of estIn) {
    const { i, d } = nearestIdx(ref, b);
    if (d <= tol && !used.has(i)) { hits++; used.add(i); }
  }
  const p = estIn.length ? hits / estIn.length : 0, r = ref.length ? hits / ref.length : 0;
  out.beatF = p + r ? Math.round((200 * p * r) / (p + r)) : 0;

  // Downbeats: share of detected bar starts (after warm-up) that land on a true bar start.
  const barTimes = sk.bars.filter(b => !b.pickup && b.time >= 5).map(b => b.time);
  out.downbeatPct = barTimes.length
    ? Math.round((100 * barTimes.filter(t => nearestIdx(truth.downbeats, t).d <= tol).length) / barTimes.length) : 0;

  // Chords per beat: exact (root + major/minor) and lenient (power chord counts as right root).
  let exact = 0, lenient = 0, n = 0;
  est.forEach((t, i) => {
    if (t < 5 || i >= sk.beatChords.length) return;
    const truthChord = truth.chordAt.filter(c => c.time <= t + 0.05).pop();
    if (!truthChord) return;
    const want = parseChord(truthChord.chord), got = sk.beatChords[i];
    n++;
    if (got === 'N') return;
    const g = parseChord(got);
    const wantQ = want.quality.startsWith('m') && want.quality !== 'maj7' ? 'm' : '';
    if (g.root === want.root && (g.quality === wantQ)) exact++;
    if (g.root === want.root) lenient++;
  });
  out.chordPct = n ? Math.round((100 * exact) / n) : 0;
  out.rootPct = n ? Math.round((100 * lenient) / n) : 0;

  out.song = sk.song ? sk.song.name : null;
  out.now = sk.now ? sk.now.name : null;
  out.keyOk = song.expectKey.includes(out.song);
  out.sections = sk.sections.map(s => s.label + (s.guess ? `(${s.guess})` : '')).join(' ');
  // Truth at the same 4-bar resolution: blocks with identical chords share a letter, runs merge.
  const allBars = song.sections.flatMap(s => s.bars);
  const blockKeys = [];
  for (let k = 0; k + 4 <= allBars.length; k += 4) blockKeys.push(allBars.slice(k, k + 4).join(' '));
  // Blocks that differ in at most one bar count as the same section (a varied ending).
  const reps = [];
  const truthLetters = blockKeys.map(key => {
    const bars4 = key.split(' ');
    const hit = reps.find(r => r.bars.filter((b, i) => b === bars4[i]).length >= 3);
    if (hit) return hit.letter;
    const letter = 'ABCDEFGH'[reps.length];
    reps.push({ bars: bars4, letter });
    return letter;
  })
    .filter((l, i, arr) => i === 0 || arr[i - 1] !== l);
  out.expectedSections = truthLetters.join(' ');
  // Compare structure, not letter names: relabel the detected sequence in order of appearance.
  const det = sk.sections.filter(s => s.label).map(s => s.label);
  const relabel = new Map();
  const canon = det.map(l => { if (!relabel.has(l)) relabel.set(l, 'ABCDEFGH'[relabel.size]); return relabel.get(l); });
  out.sectionsOk = canon.join(' ') === truthLetters.slice(truthLetters.length - canon.length).join(' ') && canon.length >= truthLetters.length - 1;
  out.tuning = sk.tuning;
  out.speed = Math.round(result.audioS / (result.ms / 1000));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const verbose = process.argv.includes('-v');
  const cents = process.argv.includes('--detune') ? 35 : 0;
  for (const [name, song] of Object.entries(SONGS)) {
    if (which.length && !which.includes(name)) continue;
    const res = runSong(song, { centsOffset: cents });
    const s = score(res, song);
    console.log(`${name.padEnd(11)} bpm ${String(s.bpm).padEnd(6)} (want ${song.bpm}) beatF ${s.beatF}%  downbeats ${s.downbeatPct}%  chords ${s.chordPct}% (roots ${s.rootPct}%)  key "${s.song}"${s.keyOk ? ' OK' : ' (want ' + song.expectKey.join(' or ') + ')'}  now "${s.now}"  sections [${s.sections}]${s.sectionsOk ? ' OK' : ' want [' + s.expectedSections + ']'}  tuning ${s.tuning ? s.tuning.cents + 'c' : '-'}  ${s.speed}x realtime`);
    if (verbose) {
      const rows = [];
      res.sketch.bars.forEach((b, i) => rows.push(`${b.pickup ? '(pickup) ' : ''}${b.chords.join(' ')}`));
      console.log('  bars: ' + rows.join(' | '));
      console.log('  truth: ' + res.truth.bars.map(b => b.chord).join(' | '));
    }
  }
}
