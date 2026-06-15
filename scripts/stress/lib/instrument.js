'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

// Latency tracker. Stamp a source event (membership change / [STEP] write) with
// mark(key); record arrival at a WS client with observe(key). Percentiles are
// computed over (arrival - source) in ms via perf_hooks (single process → one
// monotonic clock, so cross-component timestamps are directly comparable).
function makeLatencyTracker() {
  const stamps = new Map(); // key -> source perf time
  const samples = []; // ms
  return {
    mark(key) {
      stamps.set(key, performance.now());
    },
    observe(key) {
      const t0 = stamps.get(key);
      if (t0 == null) return null;
      stamps.delete(key);
      const dt = performance.now() - t0;
      samples.push(dt);
      return dt;
    },
    count() {
      return samples.length;
    },
    pending() {
      return stamps.size;
    },
    percentiles() {
      if (samples.length === 0) return { p50: null, p95: null, p99: null, max: null, n: 0 };
      const s = samples.slice().sort((a, b) => a - b);
      const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
      return {
        p50: round(at(50)),
        p95: round(at(95)),
        p99: round(at(99)),
        max: round(s[s.length - 1]),
        n: s.length,
      };
    },
  };
}

function round(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

// RSS sampler — process.memoryUsage().rss every `intervalMs` (default 1s, per
// methodology). Reports baseline, peak, final, and delta in MB.
function makeRssSampler(intervalMs = 1000) {
  const samples = [];
  let timer = null;
  function sample() {
    samples.push(process.memoryUsage().rss);
  }
  return {
    start() {
      sample();
      timer = setInterval(sample, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      sample();
    },
    report() {
      if (samples.length === 0) return { baselineMB: 0, peakMB: 0, finalMB: 0, deltaMB: 0 };
      const mb = (b) => Math.round((b / (1024 * 1024)) * 10) / 10;
      const baseline = samples[0];
      const peak = Math.max(...samples);
      const final = samples[samples.length - 1];
      return {
        baselineMB: mb(baseline),
        peakMB: mb(peak),
        finalMB: mb(final),
        deltaMB: mb(peak - baseline),
        samples: samples.length,
      };
    },
  };
}

// Open file-descriptor count (Linux). Returns null off Linux so callers can
// degrade gracefully. The FD leak detector for V6/V7.
function fdCount() {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch (_e) {
    return null;
  }
}

module.exports = { makeLatencyTracker, makeRssSampler, fdCount, performance };
