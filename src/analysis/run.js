/**
 * src/analysis/run.js — Analysis execution orchestrator with Worker & fallback.
 *
 * Provides runAnalysis(samples, sampleRate, onProgress) which delegates heavy
 * DSP computation to a module Web Worker. If Worker is unsupported or encounters
 * a runtime failure, it gracefully falls back to main-thread execution with a
 * console warning.
 */

import { analyzeRecording } from './pipeline.js';

let requestIdCounter = 0;

/**
 * Execute recording analysis asynchronously.
 *
 * @param {Float32Array|Float64Array} samples
 * @param {number} sampleRate
 * @param {Function} [onProgress] — ({ stage, progress, message }) => void
 * @param {object} [options]
 * @returns {Promise<object>} — Analysis result
 */
export async function runAnalysis(samples, sampleRate, onProgress = null, options = {}) {
  // Feature-detect module Web Worker support
  const hasWorkerSupport = typeof Worker !== 'undefined';

  if (!hasWorkerSupport) {
    console.warn('[runAnalysis] Web Worker is unavailable in this environment, falling back to main thread execution');
    const res = analyzeRecording({ samples, sampleRate, onProgress, options });
    if (res && typeof res === 'object') {
      res.executionMode = 'main';
    }
    return res;
  }

  return new Promise((resolve) => {
    let worker = null;
    const reqId = ++requestIdCounter;

    const cleanup = () => {
      if (worker) {
        try {
          worker.terminate();
        } catch (_) {}
        worker = null;
      }
    };

    const fallbackToMainThread = (reason) => {
      cleanup();
      console.warn(`[runAnalysis] Web Worker failed (${reason}), falling back to main thread execution`);
      try {
        const result = analyzeRecording({ samples, sampleRate, onProgress, options });
        if (result && typeof result === 'object') {
          result.executionMode = 'main';
        }
        resolve(result);
      } catch (fallbackErr) {
        resolve({
          ok: false,
          rejectReason: fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr),
          warning: null,
          decayTruncated: false,
          canOverrideLowPnr: false,
          lowConfidence: false,
          pnrDb: 0,
          dynamicRangeDb: 0,
          weakestBandHz: null,
          clipped: false,
          irPlot: null,
          edcPlot: null,
          bands: null,
          executionMode: 'main',
          timingsMs: { sweepMs: 0, deconvolveMs: 0, filteringMs: 0, rt60Ms: 0, totalMs: 0 },
        });
      }
    };

    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

      worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.id !== reqId) return;

        if (msg.type === 'progress') {
          if (typeof onProgress === 'function') {
            try {
              onProgress({
                stage: msg.stage,
                progress: msg.progress,
                message: msg.message,
              });
            } catch (_) {}
          }
        } else if (msg.type === 'result') {
          cleanup();
          const res = msg.data || {};
          res.executionMode = 'worker';
          resolve(res);
        } else if (msg.type === 'error') {
          fallbackToMainThread(msg.error || 'Worker execution error');
        }
      };

      worker.onerror = (err) => {
        fallbackToMainThread(err && err.message ? err.message : 'Worker onerror event');
      };

      // Create a copy of the buffer to transfer so original samples remain intact if fallback occurs
      const transferCopy = (samples instanceof Float64Array)
        ? new Float64Array(samples)
        : new Float32Array(samples);

      worker.postMessage(
        {
          id: reqId,
          samples: transferCopy,
          sampleRate,
          options,
        },
        [transferCopy.buffer]
      );
    } catch (err) {
      fallbackToMainThread(err && err.message ? err.message : 'Worker instantiation failed');
    }
  });
}
