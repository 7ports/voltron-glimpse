'use strict';

const { performance } = require('node:perf_hooks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `cond` until truthy or timeout. Returns true if satisfied.
async function until(cond, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return !!(await cond());
}

// A single vector result row for the PASS/FAIL table.
function result(vector, name) {
  return {
    vector,
    name,
    pass: false,
    metrics: {},
    notes: [],
    setPass(v) {
      this.pass = !!v;
      return this;
    },
    metric(k, v) {
      this.metrics[k] = v;
      return this;
    },
    note(s) {
      this.notes.push(s);
      return this;
    },
  };
}

module.exports = { sleep, until, result };
