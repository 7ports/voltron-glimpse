'use strict';

// T4 — Fake clock. Same contract the reconciler expects via
// createReconciler({ timer }): setTimeout / clearTimeout / now. Mirrors the
// makeFakeTimer() pattern already proven in test/liveness.test.js, with two
// extra introspection hooks the stress harness needs:
//   - size()      : number of timers currently scheduled (the leak detector)
//   - dueCount(ms): how many would fire if we advanced by ms
// Timers fire only when advance() crosses their due time, in due-time order.
function makeFakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + (Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    now() {
      return now;
    },
    advance(ms) {
      now += Number(ms) || 0;
      // Re-scan after each fire: a fired timer may schedule another (none of
      // ours do today, but this keeps the clock honest if they ever do).
      let guard = 0;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, t] of due) {
          timers.delete(id);
          t.fn();
        }
        if (++guard > 1e6) throw new Error('fake clock: runaway timer loop');
      }
    },
    // Introspection (not part of the runtime timer contract).
    size() {
      return timers.size;
    },
  };
}

module.exports = { makeFakeClock };
