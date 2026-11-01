// Analysis worker: keeps the heavy lifting off the page's main thread.

import { EssentiaWASM } from './vendor/essentia/essentia-wasm.es.js';
import Essentia from './vendor/essentia/essentia.js-core.es.js';
import { SketchEngine } from './lib/sketch.js';

let essentia = null;
let engine = null;
let lastSketchAt = 0;

async function loadEssentia() {
  if (essentia) return essentia;
  // The ES build compiles its WebAssembly asynchronously; wait until the runtime is up.
  if (!EssentiaWASM.calledRun) {
    await new Promise(resolve => {
      const prev = EssentiaWASM.onRuntimeInitialized;
      EssentiaWASM.onRuntimeInitialized = () => { if (prev) prev(); resolve(); };
      setTimeout(resolve, 5000);
    });
  }
  essentia = new Essentia(EssentiaWASM);
  return essentia;
}

function send() {
  try {
    postMessage({ type: 'sketch', sketch: engine.sketch() });
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
}

onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.type === 'start') {
      const e = await loadEssentia();
      engine = new SketchEngine(e, m.sampleRate);
      lastSketchAt = 0;
      postMessage({ type: 'ready', version: e.version, sampleRate: m.sampleRate });
    } else if (m.type === 'audio' && engine) {
      engine.push(m.samples);
      if (engine.time - lastSketchAt >= 1) {
        lastSketchAt = engine.time;
        send();
      }
      if (m.last) send();
    } else if (m.type === 'tempoScale' && engine) {
      engine.setTempoScale(m.scale);
      send();
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
