// npm test: the analysis engine on synthetic songs with known answers (about a minute).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSong, score } from './evaluate.mjs';
import { SONGS } from './songs.mjs';

for (const [name, song] of Object.entries(SONGS)) {
  test(`${name}: tempo, beats, bars, chords, sections`, () => {
    const s = score(runSong(song), song);
    assert.ok(s.tempoOk, `tempo ${s.bpm}, want ${song.bpm}`);
    assert.ok(s.beatF >= 95, `beat F-measure ${s.beatF}%`);
    assert.ok(s.downbeatPct >= 90, `downbeats ${s.downbeatPct}%`);
    assert.ok(s.chordPct >= 90, `chords ${s.chordPct}%`);
    assert.ok(s.sectionsOk, `sections ${s.sections}, want ${s.expectedSections}`);
    assert.ok(s.keyOk, `key ${s.song}, want ${song.expectKey}`);
  });
}

test('detuned recording: tuning offset measured, chords still right', () => {
  const song = SONGS.pop;
  const s = score(runSong(song, { centsOffset: 35 }), song);
  assert.ok(Math.abs(s.tuning.cents - 35) <= 6, `tuning ${s.tuning.cents} cents`);
  assert.ok(s.chordPct >= 90, `chords ${s.chordPct}%`);
});

test('silence gives no tempo, chords or bars', async () => {
  const { SketchEngine } = await import('../public/lib/sketch.js');
  const { essentia } = await import('./evaluate.mjs');
  const e = new SketchEngine(essentia, 22050);
  for (let i = 0; i < 20; i++) e.push(new Float32Array(22050));
  const sk = e.sketch();
  assert.equal(sk.tempo, null);
  assert.equal(sk.bars.length, 0);
  assert.equal(sk.chordNow, null);
  assert.equal(sk.status, 'quiet');
});
