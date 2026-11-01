// Chords per beat, bar lines, tonal centre and sections, from beat-synchronous features.
// A beat is { chroma: number[12], bass: number[12], energy: number, low: number }
// (pitch class 0 = C). Everything here is recomputed from scratch on each update,
// which is what lets earlier bars of the sketch correct themselves.

import { CHORD_TYPES, MODES, chordName, chordTones, cosine, normalizeMax, parentMajor, prefersFlats, scaleOf, noteName } from './theory.js';

const CHANGE_PENALTY = 0.16;  // how much evidence a chord change must earn (score units)
const N_SCORE = 0.6;          // "no chord" baseline: beats with no clear harmony fall back to it
const BASS_WEIGHT = 0.35;
const POWER_PENALTY = 0.05;   // prefer a full triad when the third is audible

export const STATES = (() => {
  const s = [{ root: -1, type: -1 }];
  for (let r = 0; r < 12; r++) for (let t = 0; t < CHORD_TYPES.length; t++) s.push({ root: r, type: t });
  return s;
})();

const TEMPLATES = STATES.map(({ root, type }) => {
  if (root < 0) return null;
  const v = new Array(12).fill(0);
  for (const pc of chordTones(root, type)) v[pc] = 1;
  return v;
});

export function emissionScores(beat, silenceLevel = 0) {
  const c = normalizeMax(beat.chroma);
  const b = normalizeMax(beat.bass);
  const out = new Float64Array(STATES.length);
  out[0] = beat.energy <= silenceLevel ? 2 : N_SCORE;
  for (let i = 1; i < STATES.length; i++) {
    const { root, type } = STATES[i];
    let s = cosine(c, TEMPLATES[i]) + BASS_WEIGHT * b[root];
    if (CHORD_TYPES[type].suffix === '5') s -= POWER_PENALTY;
    out[i] = s;
  }
  return out;
}

// Viterbi over beats with a constant change penalty. Returns state index per beat
// and a confidence per beat (margin of the chosen state over the best other root).
export function decodeChords(beats, silenceLevel = 0) {
  const n = beats.length, S = STATES.length;
  if (!n) return { states: [], confidence: [] };
  const em = beats.map(b => emissionScores(b, silenceLevel));
  const score = new Float64Array(S);
  const back = [];
  for (let s = 0; s < S; s++) score[s] = em[0][s];
  for (let i = 1; i < n; i++) {
    let bestPrev = 0;
    for (let s = 1; s < S; s++) if (score[s] > score[bestPrev]) bestPrev = s;
    const ptr = new Int16Array(S);
    const next = new Float64Array(S);
    for (let s = 0; s < S; s++) {
      const stay = score[s];
      const move = score[bestPrev] - CHANGE_PENALTY;
      if (stay >= move) { next[s] = stay + em[i][s]; ptr[s] = s; }
      else { next[s] = move + em[i][s]; ptr[s] = bestPrev; }
    }
    back.push(ptr);
    score.set(next);
  }
  let last = 0;
  for (let s = 1; s < S; s++) if (score[s] > score[last]) last = s;
  const states = new Array(n);
  states[n - 1] = last;
  for (let i = n - 1; i > 0; i--) states[i - 1] = back[i - 1][states[i]];
  const confidence = states.map((s, i) => {
    if (s === 0) return 0;
    let other = -Infinity;
    for (let k = 1; k < S; k++) if (STATES[k].root !== STATES[s].root && em[i][k] > other) other = em[i][k];
    return Math.max(0, Math.min(1, (em[i][s] - other) * 5));
  });
  return { states, confidence };
}

// Which of the four beats starts the bar (4/4 assumed): chords change, harmony moves and
// the bass/kick hits hardest on the downbeat. Returns { phase, scores }.
export function downbeatPhase(beats, states) {
  const scores = [0, 0, 0, 0];
  let lowMax = 0;
  for (const b of beats) lowMax = Math.max(lowMax, b.low || 0);
  for (let i = 1; i < beats.length; i++) {
    const change = states[i] !== states[i - 1] ? 1 : 0;
    const novelty = 1 - cosine(beats[i].chroma, beats[i - 1].chroma);
    const low = lowMax > 0 ? (beats[i].low || 0) / lowMax : 0;
    scores[i % 4] += change + 0.5 * novelty + 0.5 * low;
  }
  let phase = 0;
  for (let p = 1; p < 4; p++) if (scores[p] > scores[phase]) phase = p;
  return { phase, scores };
}

// Group beats into bars starting at `phase`. Each bar holds one or two chords.
export function assembleBars(states, confidence, phase, preferFlats = false) {
  const bars = [];
  if (phase > 0) bars.push(barFrom(0, phase, states, confidence, preferFlats, true));
  for (let start = phase; start < states.length; start += 4) {
    bars.push(barFrom(start, Math.min(states.length, start + 4), states, confidence, preferFlats, false));
  }
  return bars;
}

function barFrom(a, b, states, confidence, preferFlats, pickup) {
  const s = states.slice(a, b);
  const name = k => (STATES[k].root < 0 ? 'N' : chordName(STATES[k].root, STATES[k].type, preferFlats));
  let chords;
  const counts = new Map();
  s.forEach(k => counts.set(k, (counts.get(k) || 0) + 1));
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  if (s.length === 4 && s[0] === s[1] && s[2] === s[3] && s[0] !== s[2]) chords = [name(s[0]), name(s[2])];
  else if (top.length > 1 && top[1][1] >= 2) chords = [top[0][0], top[1][0]].sort((x, y) => s.indexOf(x) - s.indexOf(y)).map(name);
  else chords = [name(top[0][0])];
  const conf = confidence.slice(a, b);
  return {
    firstBeat: a,
    beats: b - a,
    pickup,
    chords,
    confidence: conf.length ? conf.reduce((x, y) => x + y, 0) / conf.length : 0,
  };
}

// Weighted pitch-class profiles over a set of beats (all beats, or recent ones decaying).
export function profiles(beats, states, { halfLifeBeats = 0 } = {}) {
  const chroma = new Array(12).fill(0), bass = new Array(12).fill(0), roots = new Array(12).fill(0);
  const n = beats.length;
  for (let i = 0; i < n; i++) {
    const w = halfLifeBeats > 0 ? Math.pow(0.5, (n - 1 - i) / halfLifeBeats) : 1;
    const e = Math.sqrt(beats[i].energy || 0) * w;
    const c = normalizeMax(beats[i].chroma), b = normalizeMax(beats[i].bass);
    for (let k = 0; k < 12; k++) { chroma[k] += e * c[k]; bass[k] += e * b[k]; }
    const st = STATES[states[i]];
    if (st && st.root >= 0) roots[st.root] += e;
  }
  return { chroma, bass, roots };
}

// Given the pitch collection (as a major-scale tonic), pick which of its seven notes the music
// treats as home, from where the bass sits and which chords are played. Returns ranked modes.
const MODE_PRIOR = [1.0, 0.9, 0.7, 0.7, 0.9, 1.0, 0.3];

export function tonalCentre(collectionPc, prof) {
  const bass = normalizeMax(prof.bass), roots = normalizeMax(prof.roots);
  const phrase = prof.phrase ? normalizeMax(prof.phrase) : null;
  const ranked = MODES.map((m, mode) => {
    const tonic = (collectionPc + m.degree) % 12;
    const evidence = phrase
      ? 0.35 * bass[tonic] + 0.25 * roots[tonic] + 0.4 * phrase[tonic]
      : 0.6 * bass[tonic] + 0.4 * roots[tonic];
    return { tonic, mode, score: evidence * MODE_PRIOR[mode] };
  }).sort((a, b) => b.score - a.score);
  return ranked;
}

// Where phrases start and end is the strongest cue for "home": the chord a 4-bar phrase
// opens on, and (weighted less) the chord it lands on. In loop-based rock and pop the
// loop's first chord is usually home, while its last chord often just leads back round.
export function phraseRoots(bars, sections, barWeights = null) {
  const out = new Array(12).fill(0);
  const rootOf = name => {
    const m = /^([A-G][#b]?)/.exec(name || '');
    if (!m) return -1;
    const idx = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
    return idx[m[1]] ?? -1;
  };
  for (const s of sections) {
    if (!s.label) continue;
    for (let k = s.startBar; k + 3 <= s.endBar; k += 4) {
      const w = barWeights ? barWeights[k] : 1;
      const first = rootOf(bars[k].chords[0]);
      const lastChords = bars[k + 3].chords;
      const last = rootOf(lastChords[lastChords.length - 1]);
      if (first >= 0) out[first] += w;
      if (last >= 0) out[last] += 0.3 * w;
    }
  }
  return out;
}

// Pitch classes that are clearly used but fall outside the collection (blue notes, borrowed chords).
export function outsideNotes(collectionPc, chroma, preferFlats) {
  const inScale = new Set(scaleOf(collectionPc, 0));
  const c = normalizeMax(chroma);
  return c.map((v, pc) => ({ pc, v })).filter(x => !inScale.has(x.pc) && x.v > 0.45).map(x => noteName(x.pc, preferFlats));
}

// keepTonic: a home note to stay with unless another note clearly wins: by keepMargin
// (0.85 = another must score 18% higher). Stops flips between two readings of the same notes.
export function describeTonality(collectionPc, prof, keepTonic = null, keepMargin = 0.85) {
  const flats = prefersFlats(collectionPc);
  const ranked = tonalCentre(collectionPc, prof);
  if (keepTonic !== null) {
    const i = ranked.findIndex(r => r.tonic === keepTonic);
    if (i > 0 && ranked[i].score >= keepMargin * ranked[0].score) ranked.unshift(ranked.splice(i, 1)[0]);
  }
  const best = ranked[0], alt = ranked[1];
  const name = r => `${noteName(r.tonic, flats)} ${MODES[r.mode].short}`;
  const margin = best.score > 0 ? (best.score - alt.score) / best.score : 0;
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: name(best),
    modeName: MODES[best.mode].name,
    scale: scaleOf(best.tonic, best.mode).map(pc => noteName(pc, flats)),
    scalePcs: scaleOf(best.tonic, best.mode),
    alternative: name(alt),
    sameNotesAs: best.mode === 0 ? null : `${noteName(collectionPc, flats)} major`,
    certainty: margin > 0.25 ? 'clear' : margin > 0.1 ? 'likely' : 'ambiguous',
    outside: outsideNotes(collectionPc, prof.chroma, flats),
    preferFlats: flats,
  };
}

// Sections from repetition: 4-bar blocks compared by harmony; repeats share a letter.
// Phrases don't necessarily start at the first bar we heard, so every block alignment is
// tried and the one where blocks repeat most clearly wins.
function blockSimilarity(bars, barFeatures, blk, prev) {
  let sim = 0, agree = 0;
  for (let k = 0; k < blk.length; k++) {
    sim += cosine(barFeatures[blk[k]], barFeatures[prev[k]]);
    if (bars[blk[k]].chords.join(' ') === bars[prev[k]].chords.join(' ')) agree++;
  }
  return 0.5 * (sim / blk.length) + 0.5 * (agree / blk.length);
}

export function findSections(bars, barFeatures, barEnergy, { blockBars = 4, threshold = 0.8 } = {}) {
  const full = bars.map((b, i) => ({ b, i })).filter(x => !x.b.pickup).map(x => x.i);
  let best = null;
  for (let offset = 0; offset < blockBars; offset++) {
    const blocks = [];
    for (let k = offset; k + blockBars <= full.length; k += blockBars) blocks.push(full.slice(k, k + blockBars));
    if (blocks.length < 2) continue;
    let total = 0;
    const bestMatch = blocks.map((blk, bi) => {
      let m = -1, mj = -1;
      for (let pj = 0; pj < bi; pj++) {
        const sim = blockSimilarity(bars, barFeatures, blk, blocks[pj]);
        if (sim > m) { m = sim; mj = pj; }
      }
      if (bi > 0) total += m;
      return { sim: m, j: mj };
    });
    const quality = total / (blocks.length - 1);
    if (!best || quality > best.quality) best = { offset, blocks, bestMatch, quality };
  }
  if (!best) return [];
  const { blocks, bestMatch, offset } = best;
  const letters = 'ABCDEFGHIJKLMNOP';
  let nextLetter = 0;
  const labels = [];
  blocks.forEach((blk, bi) => {
    const m = bestMatch[bi];
    labels.push(bi > 0 && m.sim >= threshold ? labels[m.j] : letters[Math.min(nextLetter++, letters.length - 1)]);
  });
  const sections = [];
  if (offset > 0) sections.push({ label: '', startBar: full[0], endBar: full[offset - 1], bars: offset, guess: 'intro' });
  blocks.forEach((blk, i) => {
    const last = sections[sections.length - 1];
    if (last && last.label === labels[i]) { last.bars += blockBars; last.endBar = blk[blockBars - 1]; }
    else sections.push({ label: labels[i], startBar: blk[0], endBar: blk[blockBars - 1], bars: blockBars });
  });
  // Name guesses, only for letters heard at least twice.
  const runs = {}, energy = {};
  sections.forEach(s => {
    if (!s.label) return;
    runs[s.label] = (runs[s.label] || 0) + 1;
    let e = 0;
    for (let k = s.startBar; k <= s.endBar; k++) e += barEnergy[k] || 0;
    energy[s.label] = Math.max(energy[s.label] || 0, e / s.bars);
  });
  const repeated = Object.keys(runs).filter(l => runs[l] >= 2);
  if (repeated.length >= 2) {
    const chorus = repeated.slice().sort((a, b) => (energy[b] || 0) - (energy[a] || 0))[0];
    const verse = repeated.filter(l => l !== chorus)
      .sort((a, b) => sections.findIndex(s => s.label === a) - sections.findIndex(s => s.label === b))[0];
    sections.forEach(s => {
      if (s.label === chorus) s.guess = 'chorus?';
      else if (s.label === verse) s.guess = 'verse?';
    });
  }
  return sections;
}
