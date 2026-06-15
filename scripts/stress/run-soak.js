#!/usr/bin/env node
'use strict';

// Voltron Glimpse — SOAK stress set. The plan's periodic/pre-release set
// (docs/stress-test-plan.md §Prioritized run order, "Soak set"): V1 container
// count, V3 log throughput, V5 WS fan-out, V7 reconnect storm, V10 multi-pod
// watcher fan-out, plus the full V2 churn vector as the long-soak entry.
//
// TWO RUN MODES (mode applies to V1/V3/V5/V7/V10; V2 takes a duration):
//   abbrev (DEFAULT) — a few seconds per level / short holds. Proves each vector
//      runs and produces valid metrics. Safe to run in-container under a time cap.
//   full — the plan's real magnitudes/durations (1000 nodes, 1000 lines/sec×100
//      files, 200 clients, 5-min holds, 3-min reconnect storm). Too long for a
//      capped container; run on the host via `npm run stress:soak`.
//
// SELECT MODE:  STRESS_SOAK=full|abbrev   or   --full / --abbrev   (default abbrev)
//
// READ-ONLY DISCIPLINE: every synthetic write goes into an os.tmpdir() throwaway
// root via lib/tempProject.js, whose assertTempRoot() guard refuses any path not
// under os.tmpdir(). This runner DEMONSTRATES that guard before running anything.
const path = require('node:path');
const os = require('node:os');
const { assertTempRoot } = require('./lib/tempProject');

const v1 = require('./vectors/v1');
const v3 = require('./vectors/v3');
const v5 = require('./vectors/v5');
const v7 = require('./vectors/v7');
const v10 = require('./vectors/v10');
const v2 = require('./vectors/v2');

function resolveMode() {
  const argv = process.argv.slice(2);
  if (argv.includes('--full')) return 'full';
  if (argv.includes('--abbrev')) return 'abbrev';
  const env = (process.env.STRESS_SOAK || '').toLowerCase();
  if (env === 'full') return 'full';
  if (env === 'abbrev') return 'abbrev';
  return 'abbrev';
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
  lines.push('│ Vector │ Stat │ Metric vs threshold                                  │');
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
  const m = r.metrics || {};
  switch (r.vector) {
    case 'V1':
      return `p95@200=${m.latencyP95_at200ms}ms≤250; RSSΔ=${m.rssDeltaMB}MB≤150; trip~${m.maxBufferTripRows}rows`;
    case 'V3':
      return `dropped ${m.droppedSteps}step/${m.droppedExits}exit; recent≤${m.maxRecentStepsPerAgent}/5`;
    case 'V5':
      return `top p95=${m.latencyP95_topLevelMs}ms≤500; connect=${m.worstNewConnectMs}ms<1000`;
    case 'V7':
      return `ws→${m.wsClientsAfterStorm}; fdΔ=${m.fdDelta}; snapMax=${m.snapSerializeMaxMs}ms≤50`;
    case 'V10':
      return `${m.podRootsSurfacedInScope}/${m.pods} in-scope; leaked ${m.podRootsLeakedAfterLeave}`;
    case 'V2':
      return `p95=${m.latencyP95ms}ms≤300; drained ${m.liveSetDrainedToZero}; RSSΔ=${m.rssDeltaMB}MB`;
    default:
      return '';
  }
}

async function main() {
  const mode = resolveMode();
  console.log('');
  console.log('Voltron Glimpse — SOAK stress set');
  console.log('=================================');
  console.log(`mode: ${mode.toUpperCase()}  ${mode === 'abbrev' ? '(short holds — in-container proof)' : '(plan magnitudes — host run)'}`);
  console.log('');

  const guardOk = demonstrateGuard();
  if (!guardOk) {
    console.error('FATAL: tmpdir guard did not behave correctly — refusing to run writers.');
    process.exit(2);
  }

  // V2 long-soak duration: abbrev ~8 s, full 5 min (plan §V2).
  const v2DurationMs = mode === 'full' ? 300000 : 8000;

  const steps = [
    ['V1', () => v1.run({ mode })],
    ['V3', () => v3.run({ mode })],
    ['V5', () => v5.run({ mode })],
    ['V7', () => v7.run({ mode })],
    ['V10', () => v10.run({ mode })],
    ['V2', () => v2.run({ durationMs: v2DurationMs })],
  ];

  const rows = [];
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
  }

  console.log('');
  console.log(fmtTable(rows));
  console.log('');

  for (const r of rows) {
    console.log(`── ${r.vector} — ${r.name} — ${r.pass ? 'PASS' : 'FAIL'}`);
    for (const [k, v] of Object.entries(r.metrics)) console.log(`     ${k}: ${v}`);
    for (const n of r.notes) console.log(`     • ${n}`);
    console.log('');
  }

  const failed = rows.filter((r) => !r.pass);
  const summary = `${rows.length - failed.length}/${rows.length} soak vectors PASS`;
  console.log('=================================');
  console.log(`SOAK RESULT (${mode}): ${summary}${failed.length ? ' — FAIL: ' + failed.map((r) => r.vector).join(', ') : ''}`);
  if (mode === 'abbrev') {
    console.log('Run full magnitudes on the host with:  npm run stress:soak');
  }
  console.log('=================================');
  console.log('');

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('soak runner crashed:', e && e.stack ? e.stack : e);
  process.exit(2);
});
