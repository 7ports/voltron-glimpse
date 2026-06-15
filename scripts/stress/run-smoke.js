#!/usr/bin/env node
'use strict';

// Voltron Glimpse — SMOKE stress set. Fast, deterministic, fake-driven, fully
// in-container (no real Docker daemon, no network beyond 127.0.0.1). Runs the
// plan's smoke set in priority order: V9, V8, V4, a short V2, a short V6
// (docs/stress-test-plan.md §Prioritized run order). Prints a per-vector
// PASS/FAIL table against the plan's thresholds and exits non-zero on any miss.
//
// READ-ONLY DISCIPLINE: every synthetic write goes into an os.tmpdir() throwaway
// root via lib/tempProject.js, whose assertTempRoot() guard refuses any path not
// under os.tmpdir(). This runner DEMONSTRATES that guard before running anything.
const path = require('node:path');
const os = require('node:os');
const { assertTempRoot } = require('./lib/tempProject');

const v9 = require('./vectors/v9');
const v8 = require('./vectors/v8');
const v4 = require('./vectors/v4');
const v2 = require('./vectors/v2');
const v6 = require('./vectors/v6');

function envInt(name, dflt) {
  const v = process.env[name];
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

// --- Mandatory tmpdir-guard demonstration ---------------------------------
function demonstrateGuard() {
  const realVoltron = path.join(process.cwd(), '.voltron');
  let refused = false;
  let message = '';
  try {
    assertTempRoot(realVoltron);
  } catch (e) {
    refused = true;
    message = e.message;
  }
  // And prove it ACCEPTS a real tmp path (no false-positive).
  let acceptsTmp = false;
  try {
    assertTempRoot(os.tmpdir());
    acceptsTmp = true;
  } catch (_e) {
    acceptsTmp = false;
  }
  console.log('── Read-only guard demonstration ──────────────────────────────');
  console.log(`  assertTempRoot(${realVoltron})`);
  console.log(`    → ${refused ? 'REFUSED ✓' : 'ACCEPTED ✗ (GUARD BROKEN)'}`);
  if (refused) console.log(`    → ${message.split('.')[0]}.`);
  console.log(`  assertTempRoot(os.tmpdir()) → ${acceptsTmp ? 'accepted ✓' : 'refused ✗'}`);
  console.log('');
  return refused && acceptsTmp;
}

function fmtTable(rows) {
  const lines = [];
  lines.push('┌────────┬──────┬──────────────────────────────────────────────────────┐');
  lines.push('│ Vector │ Stat │ Headline metric                                      │');
  lines.push('├────────┼──────┼──────────────────────────────────────────────────────┤');
  for (const r of rows) {
    const stat = r.pass ? 'PASS' : 'FAIL';
    const head = (r.headline || '').slice(0, 52).padEnd(52);
    lines.push(`│ ${r.vector.padEnd(6)} │ ${stat.padEnd(4)} │ ${head} │`);
  }
  lines.push('└────────┴──────┴──────────────────────────────────────────────────────┘');
  return lines.join('\n');
}

function headlineFor(r) {
  switch (r.vector) {
    case 'V9':
      return `${r.metrics.maxOverlappingTimers} timers peak → ${r.metrics.orphanTimersAfterDrain} orphaned`;
    case 'V8':
      return `${r.metrics.spuriousFromSingleFailedPoll} spurious on fail; resync ${r.metrics.recoveryCadences} cadence`;
    case 'V4':
      return `stuck-live: ${r.metrics.stuckLiveNodes}; ctl exit ${r.metrics.controlExitSurfacedViaLog}`;
    case 'V2':
      return `latency p95 ${r.metrics.latencyP95ms}ms; drained ${r.metrics.liveSetDrainedToZero}`;
    case 'V6':
      return `healthy ok ${r.metrics.healthyGotSentinel}; RSS Δ ${r.metrics.rssDeltaMB}MB`;
    default:
      return '';
  }
}

async function main() {
  console.log('');
  console.log('Voltron Glimpse — SMOKE stress set');
  console.log('==================================');
  console.log('');

  const guardOk = demonstrateGuard();
  if (!guardOk) {
    console.error('FATAL: tmpdir guard did not behave correctly — refusing to run writers.');
    process.exit(2);
  }

  const rows = [];
  const detail = [];

  // Plan smoke order: V9 → V8 → V4 → short V2 → short V6.
  const steps = [
    ['V9', () => v9.run()],
    ['V8', () => v8.run()],
    ['V4', () => v4.run()],
    ['V2', () => v2.run({ durationMs: envInt('STRESS_V2_MS', 10000) })],
    ['V6', () => v6.run({ updates: envInt('STRESS_V6_UPDATES', 5000) })],
  ];

  for (const [label, fn] of steps) {
    process.stdout.write(`▶ running ${label} … `);
    let r;
    try {
      r = await fn();
    } catch (e) {
      console.log('ERROR');
      r = { vector: label, name: label, pass: false, metrics: {}, notes: ['threw: ' + (e && e.stack ? e.stack : e)] };
    }
    r.headline = headlineFor(r);
    console.log(r.pass ? 'PASS' : 'FAIL');
    rows.push(r);
    detail.push(r);
  }

  console.log('');
  console.log(fmtTable(rows));
  console.log('');

  // Per-vector detail.
  for (const r of detail) {
    console.log(`── ${r.vector} — ${r.name} — ${r.pass ? 'PASS' : 'FAIL'}`);
    for (const [k, v] of Object.entries(r.metrics)) {
      console.log(`     ${k}: ${v}`);
    }
    for (const n of r.notes) console.log(`     • ${n}`);
    console.log('');
  }

  const failed = rows.filter((r) => !r.pass);
  const summary = `${rows.length - failed.length}/${rows.length} smoke vectors PASS`;
  console.log('==================================');
  console.log(`SMOKE RESULT: ${summary}${failed.length ? ' — FAIL: ' + failed.map((r) => r.vector).join(', ') : ''}`);
  console.log('==================================');
  console.log('');

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke runner crashed:', e && e.stack ? e.stack : e);
  process.exit(2);
});
