// Page logic: capture audio, hand it to the analysis worker, draw the sketch.

import { STANDARD_TUNING, noteName } from './lib/theory.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const AUTO_NEW_SONG_QUIET_S = 5; // silence this long after a song = start a fresh sketch

const state = {
  ctx: null, node: null, sink: null, source: null, stream: null, fileNode: null,
  worker: null, workerReady: null, analysisRate: 22050,
  ctxStart: null, sketch: null, tempoScale: 1, running: false, quietFrom: null,
};
window.__sketchState = state; // for automated tests

// ---------------------------------------------------------------- worker

function startWorker(sampleRate) {
  if (state.worker) state.worker.terminate();
  const w = new Worker('analyzer.worker.js', { type: 'module' });
  state.worker = w;
  state.sketch = null;
  state.quietFrom = null;
  state.tempoScale = 1;
  state.workerReady = new Promise((resolve, reject) => {
    w.onmessage = ev => {
      const m = ev.data;
      if (m.type === 'ready') resolve();
      else if (m.type === 'sketch') onSketch(m.sketch);
      else if (m.type === 'error') showError('Analysis error: ' + m.message);
    };
    w.onerror = ev => { showError('Could not start the analysis: ' + (ev.message || 'unknown error')); reject(ev); };
  });
  w.postMessage({ type: 'start', sampleRate });
  return state.workerReady;
}

function onSketch(sk) {
  state.sketch = sk;
  window.__sketch = sk;
  render(sk);
  // Auto "new song": a stretch of silence after a song has been sketched.
  if (sk.status === 'quiet' && sk.time > 30 && state.running && !state.fileNode) {
    if (state.quietFrom === null) state.quietFrom = sk.time;
    if (sk.time - state.quietFrom >= AUTO_NEW_SONG_QUIET_S) newSong();
  } else state.quietFrom = null;
}

// ---------------------------------------------------------------- capture

// Chrome only lets audio start shortly after a click. Each start button creates its
// AudioContext synchronously in the click handler, before any dialog or file read.
function newContext() {
  return new AudioContext({ latencyHint: 'interactive' });
}

async function setupGraph(ctx) {
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('capture-worklet.js');
  const factor = Math.max(1, Math.round(ctx.sampleRate / 22050));
  state.analysisRate = ctx.sampleRate / factor;
  const node = new AudioWorkletNode(ctx, 'capture-processor', { processorOptions: { factor }, numberOfOutputs: 1 });
  // A silent sink keeps the node running without sending anything to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  node.port.onmessage = ev => {
    const { samples, frame } = ev.data;
    // Audio-clock time of the first sample the current analysis received: lines up the beat pulse.
    if (state.ctxStart === null) state.ctxStart = frame / ctx.sampleRate;
    if (state.worker) state.worker.postMessage({ type: 'audio', samples }, [samples.buffer]);
  };
  Object.assign(state, { ctx, node, sink, ctxStart: null });
  await startWorker(state.analysisRate);
  return ctx;
}

async function startTab() {
  const ctx = newContext();
  await stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Chrome requires video; we drop it straight away
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false,
    });
  } catch (err) {
    showError(err.name === 'NotAllowedError' ? 'Sharing was cancelled.' : 'Could not share a tab: ' + err.message);
    ctx.close();
    return;
  }
  stream.getVideoTracks().forEach(t => t.stop());
  const audio = stream.getAudioTracks();
  if (!audio.length) {
    showError('That share has no sound. Click "Listen to a tab" again, choose the tab playing the music, and switch on "Also share tab audio" at the bottom of the dialog.');
    ctx.close();
    return;
  }
  await begin(ctx, new MediaStream(audio), 'tab');
  audio[0].addEventListener('ended', () => stop());
}

async function startMic() {
  const ctx = newContext();
  await stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (err) {
    showError('Microphone not available: ' + err.message);
    ctx.close();
    return;
  }
  await begin(ctx, stream, 'microphone');
}

async function begin(ctx, stream, label) {
  hideError();
  await setupGraph(ctx);
  state.stream = stream;
  state.source = ctx.createMediaStreamSource(stream);
  state.source.connect(state.node);
  started(label);
}

async function startFile(file) {
  const ctx = newContext();
  await stop();
  hideError();
  const data = await file.arrayBuffer();
  if (params.get('fast') === '1') { ctx.close(); return analyseFast(data); }
  await setupGraph(ctx);
  let buffer;
  try { buffer = await ctx.decodeAudioData(data); } catch (err) { showError('Could not read that audio file.'); return; }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(state.node);
  src.connect(ctx.destination); // you hear the file while it is analysed
  src.onended = () => { if (state.fileNode === src) finishFile(); };
  state.fileNode = src;
  src.start();
  started(file.name);
}

// Test mode (?fast=1): decode straight to the analysis rate and analyse faster than real time.
async function analyseFast(data) {
  const rate = 22050;
  const probe = new AudioContext();
  const decoded = await probe.decodeAudioData(data);
  probe.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  await startWorker(rate);
  started('file (fast)');
  const chunk = 4096;
  for (let i = 0; i < mono.length; i += chunk) {
    const part = mono.slice(i, i + chunk);
    state.worker.postMessage({ type: 'audio', samples: part, last: i + chunk >= mono.length }, [part.buffer]);
  }
}

function finishFile() {
  setStatus('finished', false);
  state.running = false;
  updateButtons();
}

async function stop() {
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  if (state.fileNode) { try { state.fileNode.stop(); } catch (_) { /* already stopped */ } }
  if (state.ctx) await state.ctx.close();
  Object.assign(state, { ctx: null, node: null, sink: null, source: null, stream: null, fileNode: null, running: false });
  setStatus(state.sketch ? 'stopped' : 'idle', false);
  updateButtons();
}

function newSong() {
  if (!state.running) return;
  state.ctxStart = null; // the next block to arrive is the new analysis's time zero
  startWorker(state.analysisRate);
  clearDisplay();
}

function started(label) {
  state.running = true;
  setStatus('listening to ' + label, true);
  clearDisplay();
  updateButtons();
}

// ---------------------------------------------------------------- rendering

function setStatus(text, live) {
  $('status').textContent = text;
  $('status').classList.toggle('live', !!live);
}
function showError(msg) { $('error').textContent = msg; $('error').hidden = false; }
function hideError() { $('error').hidden = true; }
function updateButtons() {
  $('btnStop').disabled = !state.running;
  $('btnNew').disabled = !state.running || !!state.fileNode;
}

function clearDisplay() {
  for (const id of ['bpm', 'chordNow']) $(id).textContent = '—';
  for (const id of ['chordTones', 'tuning', 'tonalityDetail', 'sections']) $(id).textContent = '';
  $('scaleChips').innerHTML = '<span class="empty">Listening for about 15 seconds first.</span>';
  $('movement').innerHTML = '<span class="empty">The chord changes appear here as the song plays.</span>';
  $('chart').innerHTML = '<div class="empty" style="grid-column: 1 / -1">Bars appear here once the beat is found.</div>';
  $('btnCopy').disabled = true;
  drawFretboard(null, null);
}

function render(sk) {
  if (state.running) {
    const label = sk.status === 'quiet' ? 'quiet: waiting for music' : sk.status;
    setStatus(label, sk.status === 'listening');
  }
  renderPulse(sk);
  renderMovement(sk);
  renderChart(sk);
  renderSections(sk);
  renderNotes(sk.now, sk.chordNow);
}

// Chord movement: the last changes, oldest first, with how many beats each lasted.
function renderMovement(sk) {
  const ch = (sk.changes || []).filter(c => c.chord !== 'N').slice(-10);
  if (!ch.length) return;
  const beatsPerBar = 4;
  $('movement').innerHTML = ch.map((c, i) => {
    const len = c.beats % beatsPerBar === 0 ? `${c.beats / beatsPerBar} bar${c.beats === beatsPerBar ? '' : 's'}` : `${c.beats} beat${c.beats === 1 ? '' : 's'}`;
    const cls = i === ch.length - 1 ? 'cur' : '';
    return (i ? '<span class="arrow">→</span>' : '') + `<span class="${cls}">${c.chord}<span class="len">${len}</span></span>`;
  }).join(' ');
}

// Secondary: the notes that fit (for soloing), with the likely home note marked. No mode names.
function renderNotes(now, chord) {
  if (!now) return;
  const chordPcs = new Set(chord ? chord.tones : []);
  const order = now.scalePcs.map((pc, i) => ({ pc, name: now.scale[i] })).sort((a, b) => ((a.pc - now.tonic + 12) % 12) - ((b.pc - now.tonic + 12) % 12));
  $('scaleChips').innerHTML = order.map(n => {
    const cls = ['chip', n.pc === now.tonic ? 'tonic' : '', chordPcs.has(n.pc) ? 'inchord' : ''].join(' ');
    return `<span class="${cls}">${n.name}</span>`;
  }).join('');
  const bits = [`Seems to centre on ${now.scale[0]}`];
  if (now.outside.length) bits.push('also heard: ' + now.outside.join(', '));
  bits.push('ringed = notes of the chord now');
  $('tonalityDetail').textContent = bits.join(' · ');
  drawFretboard(now, chord);
}

function drawFretboard(now, chord) {
  const svg = $('fretboard');
  const frets = 12, x0 = 46, fw = 56, top = 22, gap = 25;
  const fx = f => (f === 0 ? 24 : x0 + (f - 0.5) * fw);
  const parts = [];
  for (let f = 0; f <= frets; f++) {
    const x = x0 + f * fw;
    parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + 5 * gap}" style="stroke:var(--line);stroke-width:${f === 0 ? 4 : 1.5}"/>`);
  }
  for (const f of [3, 5, 7, 9]) parts.push(`<circle cx="${x0 + (f - 0.5) * fw}" cy="${top + 2.5 * gap}" r="4" style="fill:var(--line)"/>`);
  parts.push(`<circle cx="${x0 + 11.5 * fw}" cy="${top + 1.5 * gap}" r="4" style="fill:var(--line)"/><circle cx="${x0 + 11.5 * fw}" cy="${top + 3.5 * gap}" r="4" style="fill:var(--line)"/>`);
  for (let f = 1; f <= frets; f++) if ([3, 5, 7, 9, 12].includes(f)) parts.push(`<text x="${x0 + (f - 0.5) * fw}" y="${top + 5 * gap + 22}" text-anchor="middle" style="fill:var(--muted);font-size:11px">${f}</text>`);
  // Strings: high e at the top, like tab.
  const strings = STANDARD_TUNING.slice().reverse();
  strings.forEach((open, i) => {
    const y = top + i * gap;
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x0 + frets * fw}" y2="${y}" style="stroke:var(--muted);stroke-width:${1 + (5 - i) * 0.25}"/>`);
    if (!now) return;
    const flats = now.preferFlats;
    const scale = new Set(now.scalePcs);
    const tones = new Set(chord ? chord.tones : []);
    for (let f = 0; f <= frets; f++) {
      const pc = (open + f) % 12;
      if (!scale.has(pc)) continue;
      const isTonic = pc === now.tonic;
      const fill = isTonic ? 'var(--tonic)' : 'var(--scale)';
      const ring = tones.has(pc) ? 'stroke:var(--chord);stroke-width:3' : 'stroke:none';
      parts.push(`<circle cx="${fx(f)}" cy="${y}" r="10" style="fill:${fill};${ring}"/>`);
      parts.push(`<text x="${fx(f)}" y="${y + 4}" text-anchor="middle" style="fill:var(--card);font-size:10px;font-weight:700">${noteName(pc, flats)}</text>`);
    }
  });
  svg.innerHTML = parts.join('');
}

function renderPulse(sk) {
  $('bpm').textContent = sk.tempo ? Math.round(sk.tempo.bpm) : '—';
  $('meter').textContent = sk.meter;
  if (sk.chordNow) {
    $('chordNow').textContent = sk.chordNow.name;
    $('chordTones').textContent = sk.chordNow.toneNames.join(' · ') + (sk.chordNow.confidence < 0.3 ? '  (unsure)' : '');
  } else {
    $('chordNow').textContent = '—';
    $('chordTones').textContent = '';
  }
  if (sk.tuning) {
    const c = sk.tuning.cents;
    $('tuning').textContent = Math.abs(c) < 8
      ? `Tuning: standard (A = ${sk.tuning.hz} Hz)`
      : `Recording is ${Math.abs(c)} cents ${c > 0 ? 'sharp' : 'flat'} of standard (A = ${sk.tuning.hz} Hz): retune to play along in tune`;
  }
}

function beatLoop() {
  const sk = state.sketch, dots = $('pulse').children;
  let on = -1;
  if (sk && sk.beat && sk.beat.period && state.ctx && state.ctxStart !== null && state.running) {
    const t = state.ctx.currentTime - state.ctxStart;
    const since = (t - sk.beat.last) / sk.beat.period;
    const k = Math.floor(since);
    if (k >= 0 && since - k < 0.3) on = (sk.beat.index + k) % 4;
  }
  for (let i = 0; i < 4; i++) dots[i].classList.toggle('on', i === on);
  requestAnimationFrame(beatLoop);
}

function renderChart(sk) {
  const bars = sk.bars.map((b, i) => ({ ...b, i })).filter(b => !b.pickup);
  if (!bars.length) return;
  const sectionAt = new Map(sk.sections.map(s => [s.startBar, s]));
  const rows = [];
  let row = null;
  for (const b of bars) {
    if (!row || row.bars.length === 4 || sectionAt.has(b.i)) {
      row = { label: sectionAt.has(b.i) ? sectionAt.get(b.i).label : '', bars: [] };
      rows.push(row);
    }
    row.bars.push(b);
  }
  const last = bars[bars.length - 1].i;
  const html = [];
  for (const r of rows) {
    html.push(`<div class="sec">${r.label}</div>`);
    for (const b of r.bars) {
      const cls = ['bar', b.confidence < 0.2 ? 'low' : '', b.i === last ? 'latest' : ''].join(' ');
      const chords = b.chords.map(c => `<span class="half">${c === 'N' ? '·' : c}</span>`).join('');
      html.push(`<div class="${cls}"><span class="n">${b.i + 1}</span>${chords}</div>`);
    }
    for (let k = r.bars.length; k < 4; k++) html.push('<div></div>');
  }
  $('chart').innerHTML = html.join('');
  $('btnCopy').disabled = false;
  state.chartText = rows.map(r => `${(r.label || ' ').padEnd(2)}| ${r.bars.map(b => b.chords.join(' ').padEnd(7)).join(' | ')} |`).join('\n');
}

function renderSections(sk) {
  $('sections').innerHTML = sk.sections.filter(s => s.label).map(s =>
    `<span class="section"><b>${s.label}</b> ${s.bars} bars${s.guess ? ' · ' + s.guess : ''}</span>`).join('');
}

// ---------------------------------------------------------------- wiring

$('btnTab').onclick = () => startTab();
$('btnMic').onclick = () => startMic();
$('btnFile').onclick = () => $('fileInput').click();
$('fileInput').onchange = ev => { const f = ev.target.files[0]; if (f) startFile(f); ev.target.value = ''; };
$('btnStop').onclick = () => stop();
$('btnNew').onclick = () => newSong();
$('btnHalf').onclick = () => setTempoScale(0.5);
$('btnDouble').onclick = () => setTempoScale(2);
$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(state.chartText || ''); $('btnCopy').textContent = 'Copied'; }
  catch (_) { $('btnCopy').textContent = 'Copy failed'; }
  setTimeout(() => { $('btnCopy').textContent = 'Copy chart'; }, 1500);
};

function setTempoScale(f) {
  state.tempoScale = Math.max(0.25, Math.min(4, state.tempoScale * f));
  if (state.worker) state.worker.postMessage({ type: 'tempoScale', scale: state.tempoScale });
}

if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  $('btnTab').disabled = true;
  showError('Tab listening needs Chrome (or Edge) on a computer, opened over https.');
}

// Test hook: ?src=<url>&fast=1 analyses a file from a URL without the file picker.
if (params.get('src')) {
  fetch(params.get('src')).then(r => r.blob()).then(b => startFile(new File([b], 'test')));
}

drawFretboard(null, null);
requestAnimationFrame(beatLoop);
