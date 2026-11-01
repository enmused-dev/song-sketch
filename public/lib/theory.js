// Music theory helpers: note names, chord templates, scales and modes.
// Pitch classes are 0 = C ... 11 = B throughout.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Keys whose signatures use flats (major tonic pitch classes): F Bb Eb Ab Db Gb.
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1, 6]);

export const MODES = [
  // name, steps from the tonic, offset of the mode's tonic within the parent major scale
  { name: 'Ionian (major)', short: 'major', steps: [0, 2, 4, 5, 7, 9, 11], degree: 0 },
  { name: 'Dorian', short: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10], degree: 2 },
  { name: 'Phrygian', short: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10], degree: 4 },
  { name: 'Lydian', short: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11], degree: 5 },
  { name: 'Mixolydian', short: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10], degree: 7 },
  { name: 'Aeolian (natural minor)', short: 'minor', steps: [0, 2, 3, 5, 7, 8, 10], degree: 9 },
  { name: 'Locrian', short: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10], degree: 11 },
];

// Chord vocabulary for detection. Kept small on purpose: every extra type adds confusions.
export const CHORD_TYPES = [
  { suffix: '', label: 'major', tones: [0, 4, 7] },
  { suffix: 'm', label: 'minor', tones: [0, 3, 7] },
  { suffix: '5', label: 'power chord', tones: [0, 7] },
];

export function noteName(pc, preferFlats = false) {
  pc = ((pc % 12) + 12) % 12;
  return (preferFlats ? FLAT_NAMES : SHARP_NAMES)[pc];
}

// Whether a pitch collection (given by its parent major tonic) is normally spelled with flats.
export function prefersFlats(parentMajorPc) {
  return FLAT_MAJOR_TONICS.has(((parentMajorPc % 12) + 12) % 12);
}

export function chordName(root, type, preferFlats = false) {
  if (root < 0) return 'N';
  return noteName(root, preferFlats) + CHORD_TYPES[type].suffix;
}

export function chordTones(root, type) {
  return CHORD_TYPES[type].tones.map(t => (root + t) % 12);
}

export function scaleOf(tonic, mode) {
  return MODES[mode].steps.map(s => (tonic + s) % 12);
}

// Parent major tonic for a tonic + mode (E Dorian -> D).
export function parentMajor(tonic, mode) {
  return (((tonic - MODES[mode].degree) % 12) + 12) % 12;
}

// Standard tuning, low to high, as pitch classes and MIDI numbers.
export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64];

export function cosine(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

export function rotate(v, n) {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) out[(i + n) % 12] = v[i];
  return out;
}

export function normalizeMax(v) {
  let m = 0;
  for (const x of v) if (x > m) m = x;
  return m > 0 ? v.map(x => x / m) : v.slice();
}
