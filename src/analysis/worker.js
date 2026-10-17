/**
 * src/analysis/worker.js — Module Web Worker for acoustic analysis.
 *
 * Runs the heavy Cooley–Tukey FFT, deconvolution, band filtering, and Schroeder
 * decay analysis off the main UI thread.
 *
 * Instantiation:
 *   new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
 */

import { analyzeRecording } from './pipeline.js';

self.addEventListener('message', (event) => {
  const { id = 1, samples, sampleRate, options = {} } = event.data || {};

  try {
    const onProgress = ({ stage, progress, message }) => {
      self.postMessage({ type: 'progress', id, stage, progress, message });
    };

    const result = analyzeRecording({
      samples,
      sampleRate,
      onProgress,
      options,
    });

    self.postMessage({ type: 'result', id, data: result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      error: err && err.message ? err.message : String(err),
    });
  }
});
