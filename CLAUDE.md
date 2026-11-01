# Song Sketch: notes for Claude

A static web page (no server, no build step) that listens to a browser tab and sketches the song playing. Served from
`public/` by Cloudflare Pages at https://sketch.tinline.dev; every push to `main` deploys. Separate from the owner's
AM4 Tutor project (`enmused-dev/am4-tutor`), which listens to *their* guitar; this one listens to *recordings*.

## What the owner wants (keep to this)

- **Chord names and chord movement come first.** "Simply naming the chord movements is more important than trying to
  come up with a key that the artist may not even have considered." Key/mode is secondary: shown only as "notes that
  fit" with a likely home note, never as a headline mode name. Do not spend effort on modal theory.
- Purpose: pick a song on YouTube Music (e.g. Red Hot Chili Peppers) and play along on guitar.
- Lightweight, runs in Chrome on any computer. Personal use only (essentia.js is AGPL; fine as long as it is not shared).
- They want a co-ideation partner with devil's-advocate input at decision points, advice based on documented evidence,
  and plain-language explanations. They do not read code. Label anything untested as untested.

## Rules learned while building

- **Free every Essentia vector** (`.delete()`), or the WASM heap grows ~1 MB/s (375 MB vs 17 MB over 5 minutes).
- Essentia `Key`: use the plain `diatonic` profile with polyphony/three-chord options off. The options pulled the
  answer a fifth away on test material. We only need the seven notes; the home note is decided separately.
- Tempo: Percival estimator was right where our autocorrelation tempo was not (60 vs 120, 92 vs 138). Readings fold
  into 72–175 BPM; the user can correct with ½× / 2×.
- Beats are re-tracked over the whole song every update, so early mistakes heal; committed beats lag 2 s.
- Home-note stability: when the current notes equal the song's, keep the song's home note unless local evidence wins by
  a wide margin; phrase *starts* weigh more than phrase *ends* (loop-based rock and pop).
- Chrome only allows tab capture from a secure page: https (or localhost for tests).

## Testing

`npm test` (engine, synthetic songs), `node test/evaluate.mjs -v`, `node test/browser.mjs` (headless Chromium via
Playwright: fast file mode `?src=…&fast=1` and the live path with Chrome's fake microphone). Every accuracy change
should keep `npm test` green; add a test song for each new failure mode.

## Next steps

1. **Real recordings.** Everything so far is measured on synthetic songs. Ask the owner which songs sketch badly and why
   (wrong chord, late change, wrong bar line), and reproduce with a short clip they choose.
2. Funk/riff-heavy music (RHCP) is the expected weak spot: muted scratching and single-note riffs are not held chords.
   Consider showing the bass note when no chord is clear.
3. Possibly: 7th chords (only if the owner wants them), 3/4 detection, a per-song saved sketch.
