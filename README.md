# Song Sketch

A web page that listens to whatever is playing in another browser tab (YouTube Music, Spotify web, …) and sketches the
song as it plays: **the chord now, the chord movement, a chord chart by bar, tempo and beat, sections once parts repeat,
and the notes that fit for soloing**. Live at **https://sketch.tinline.dev** (Cloudflare Pages, deployed from `main`).

## Use it

1. Start the song in a Chrome tab.
2. Open the sketch page, click **Listen to a tab**, pick the music tab and switch on **Also share tab audio**.
3. Play along. The first chords and tempo appear after about 10–15 seconds; the chart fills in and corrects itself as
   the song goes on. **½× / 2×** fixes a tempo read at double or half speed. **New song** starts a fresh sketch (it also
   happens by itself after a few seconds of silence).

Also: **Microphone** (any source in the room, noisier) and **Audio file…** (plays a file and sketches it).
Nothing is recorded or uploaded; all analysis runs in the browser.

## How it works

| Step | How | Code |
|---|---|---|
| Capture | `getDisplayMedia` tab audio → AudioWorklet: mono, anti-alias filter, ~22 kHz | `public/app.js`, `public/capture-worklet.js` |
| Tonal features | Essentia HPCP chroma (treble and bass) every ~46 ms, tuning estimate | `public/lib/sketch.js` |
| Tempo | Essentia `PercivalBpmEstimator` on the last 16 s, folded to 72–175 BPM, median of recent readings | `sketch.js` |
| Beats | Dynamic-programming beat tracker (Ellis 2007), re-run over the whole song each second | `public/lib/beats.js` |
| Chords | Beat-synchronous chroma + bass vs. major / minor / power-chord templates, Viterbi smoothing | `public/lib/harmony.js` |
| Bars | 4/4 assumed; downbeat = where chords change, harmony moves and the kick hits | `harmony.js` |
| Sections | 4-bar blocks compared by harmony; repeats share a letter | `harmony.js` |
| Notes that fit | Essentia `Key` (diatonic profile) for the seven notes; home note from bass, chord roots, phrase starts | `harmony.js` |

Analysis runs in a Web Worker (`public/analyzer.worker.js`). [essentia.js](https://mtg.github.io/essentia.js/) 0.1.3 is
vendored unmodified in `public/vendor/essentia/` (AGPL-3.0, Music Technology Group, UPF).

## Test

```bash
npm install
npm test                    # engine on synthetic songs with known answers
node test/evaluate.mjs -v   # per-song scores and chord charts
node test/browser.mjs       # real Chromium via Playwright: file mode + live AudioWorklet path
xvfb-run -a node test/browser.mjs   # ...plus real tab sharing (needs a display)
```

Measured so far on **synthetic** songs only (drums, bass, chords): tempo, beats and bar lines 100%, chords 95–100% per
beat, sections and tuning offsets right. **Not yet measured on real recordings.**
