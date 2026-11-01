// End-to-end check in real (headless) Chromium.
//   node test/browser.mjs            fast file mode + live microphone path (fake mic plays a test song)
// Needs Playwright with Chromium installed (PLAYWRIGHT=path to the playwright package if not global).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { renderSong, SONGS } from './songs.mjs';
import { writeWav } from './wav.mjs';

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = require(pwPath);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const tmp = mkdtempSync(join(tmpdir(), 'sketch-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wav': 'audio/wav', '.txt': 'text/plain', '.svg': 'image/svg+xml' };

function serve(port) {
  return new Promise(resolve => {
    const srv = createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = url.startsWith('/test-audio/') ? join(tmp, url.slice(12)) : join(root, url === '/' ? 'index.html' : url);
      if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    srv.listen(port, () => resolve(srv));
  });
}

function summary(sk) {
  if (!sk) return 'no sketch';
  return `t=${sk.time.toFixed(0)}s status=${sk.status} bpm=${sk.tempo && sk.tempo.bpm} now="${sk.now && sk.now.name}" song="${sk.song && sk.song.name}" ` +
    `chordNow=${sk.chordNow && sk.chordNow.name} bars=${sk.bars.length} sections=[${sk.sections.map(s => s.label).join(' ')}] tuning=${sk.tuning && sk.tuning.cents}`;
}

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); console.log((cond ? '  ok   ' : '  FAIL ') + msg); }

const srv = await serve(8899);
const song = SONGS.dorian;
const { audio, sr } = renderSong({ ...song, sr: 44100 });
writeWav(join(tmp, 'song.wav'), audio, sr);
writeFileSync(join(tmp, 'player.html'), '<title>Test Music</title><audio id="a" src="song.wav" autoplay></audio>');
const duration = audio.length / sr;

// 1. Fast file mode: the whole pipeline (worker, Essentia WASM, rendering) on a file.
{
  console.log('Fast file mode');
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto('http://localhost:8899/?src=/test-audio/song.wav&fast=1');
  await page.waitForFunction(d => window.__sketch && window.__sketch.time > d - 1, duration, { timeout: 120000 });
  const sk = await page.evaluate(() => window.__sketch);
  console.log('  ' + summary(sk) + ` (${((Date.now() - t0) / 1000).toFixed(1)} s for ${duration.toFixed(0)} s of audio)`);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  check(sk.tempo && Math.abs(sk.tempo.bpm - song.bpm) < 2, `tempo ${song.bpm}`);
  check(sk.song && song.expectKey.includes(sk.song.name), `key ${song.expectKey.join('/')}`);
  check(await page.locator('#chart .bar').count() > 10, 'chart drawn');
  const movement = await page.$$eval('#movement > span', els => els.map(e => e.firstChild.textContent.trim()).filter(t => t !== '→'));
  check(movement.includes('Em') && movement.includes('A'), 'chord movement shows Em and A: ' + movement.join(' → '));
  await page.screenshot({ path: join(tmp, 'fast.png'), fullPage: true });
  await browser.close();
}

// 2. Live path: AudioWorklet capture from a (fake) microphone playing the song in real time.
{
  const seconds = Number(process.env.LIVE_SECONDS || 45);
  console.log(`Live microphone path (${seconds} s real time)`);
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(tmp, 'song.wav')}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:8899/');
  await page.click('#btnMic');
  await page.waitForTimeout(seconds * 1000);
  const sk = await page.evaluate(() => window.__sketch);
  const pulseSeen = await page.evaluate(async () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const on = [...document.querySelectorAll('#pulse .dot')].findIndex(d => d.classList.contains('on'));
      if (on >= 0) seen.add(on);
      await new Promise(r => setTimeout(r, 50));
    }
    return [...seen];
  });
  console.log('  ' + summary(sk) + ` pulse dots lit: ${pulseSeen.join(',')}`);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  check(sk && sk.tempo && Math.abs(sk.tempo.bpm - song.bpm) < 2, `live tempo ${song.bpm}`);
  const live = (sk && sk.changes || []).map(c => c.chord);
  check(live.includes('Em') && live.includes('A'), 'live chord movement has Em and A: ' + live.join(' → '));
  check(await page.locator('#scaleChips .chip').count() === 7, 'notes that fit are shown');
  check(sk && sk.chordNow, 'a current chord is shown');
  check(pulseSeen.length >= 2, 'beat pulse animates');
  await page.screenshot({ path: join(tmp, 'live.png'), fullPage: true });
  await browser.close();
}

// 3. Tab listening, the real use: one tab plays the song, the sketch tab captures it with
//    getDisplayMedia. Headless Chrome cannot share tabs, so this needs a display:
//    xvfb-run -a node test/browser.mjs
if (process.env.DISPLAY) {
  console.log('Tab listening (full Chrome on a display)');
  const browser = await chromium.launch({ headless: false, args: ['--auto-select-tab-capture-source-by-title=Test Music', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  const player = await context.newPage();
  await player.goto('http://localhost:8899/test-audio/player.html');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8899/');
  await page.click('#btnTab');
  await page.waitForTimeout(35000);
  const sk = await page.evaluate(() => window.__sketch);
  const chords = (sk && sk.changes || []).map(c => c.chord);
  console.log('  ' + summary(sk));
  check(errors.length === 0 && await page.evaluate(() => document.getElementById('error').hidden), 'tab shared without errors');
  check(sk && sk.tempo && Math.abs(sk.tempo.bpm - song.bpm) < 2, `tab tempo ${song.bpm}`);
  check(chords.includes('Em') && chords.includes('A'), 'tab chord movement has Em and A: ' + chords.join(' → '));
  await browser.close();
} else {
  console.log('Tab listening: skipped (no display; run under xvfb-run to include it)');
}

srv.close();
console.log(`\nScreenshots in ${tmp}`);
console.log(failures.length ? `${failures.length} check(s) failed` : 'All browser checks passed');
process.exit(failures.length ? 1 : 0);
