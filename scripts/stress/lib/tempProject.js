'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// T3 (safety core) — the MANDATORY read-only guard. The harness is the only
// writer in this whole exercise; the single catastrophic mistake would be
// pointing it at a real `.voltron/`. Every write path runs through assertTempRoot
// first, which refuses any path not strictly under os.tmpdir().
function assertTempRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error(`tempProject: write root must be a non-empty string, got ${root}`);
  }
  const resolved = path.resolve(root);
  const tmp = path.resolve(os.tmpdir());
  const underTmp = resolved === tmp || resolved.startsWith(tmp + path.sep);
  if (!underTmp) {
    throw new Error(
      `REFUSING to write outside os.tmpdir(): ${resolved} is not under ${tmp}. ` +
        `The stress harness must never touch a real .voltron/.beads.`
    );
  }
  return resolved;
}

// Create a throwaway Voltron-shaped project under os.tmpdir():
//   <tmp>/.voltron/logs/  +  <tmp>/.voltron/journal/
// Returns { root, logsDir, journalDir, cleanup() }. Glimpse is pointed at `root`
// via --root (or createWatcher(root, ...)).
function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimpse-stress-'));
  assertTempRoot(root); // belt-and-suspenders: mkdtemp already lands in tmp
  const logsDir = path.join(root, '.voltron', 'logs');
  const journalDir = path.join(root, '.voltron', 'journal');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  return {
    root,
    logsDir,
    journalDir,
    cleanup() {
      try {
        assertTempRoot(root);
        fs.rmSync(root, { recursive: true, force: true });
      } catch (_e) {
        /* best-effort teardown */
      }
    },
  };
}

// T3 — Synthetic log writer for one container. Appends Voltron log lines into
// <tmp>/.voltron/logs/<nodeId>.log. Rotation/truncation helpers (V4) live here.
// Every operation re-asserts the temp guard before opening a handle.
function makeLogWriter(logsDir, nodeId) {
  assertTempRoot(logsDir);
  const file = path.join(logsDir, `${nodeId}.log`);
  let lineCount = 0;
  function appendRaw(text) {
    assertTempRoot(file);
    fs.appendFileSync(file, text);
  }
  return {
    file,
    nodeId,
    lineCount: () => lineCount,
    exec(ts = '2026-06-15T10:00:01+00:00') {
      appendRaw(`[exec] voltron-${nodeId} ${ts}\n`);
      lineCount += 1;
    },
    step(n, text = 'doing work') {
      appendRaw(`[STEP ${n}] ${text}\n`);
      lineCount += 1;
    },
    done(summary = 'ok') {
      appendRaw(`[DONE] ${summary}\n`);
      lineCount += 1;
    },
    exit(code = 0) {
      appendRaw(`[exit] voltron-${nodeId} code=${code}\n`);
      lineCount += 1;
    },
    // V4 (a): rename x.log -> x.<n>.log and recreate a fresh empty x.log.
    rotateRename(suffix) {
      assertTempRoot(file);
      const rotated = path.join(logsDir, `${nodeId}.${suffix}.log`);
      assertTempRoot(rotated);
      try {
        fs.renameSync(file, rotated);
      } catch (_e) {
        /* file may not exist yet */
      }
      fs.writeFileSync(file, ''); // fresh, empty current log (new inode, same path)
    },
    // V4 (b): truncate x.log in place to 0 bytes.
    truncate() {
      assertTempRoot(file);
      fs.truncateSync(file, 0);
    },
  };
}

// T3 — Synthetic journal writer (drives the scrum-master hub).
function makeJournalWriter(journalDir, day = '2026-06-15') {
  assertTempRoot(journalDir);
  const file = path.join(journalDir, `${day}.md`);
  return {
    file,
    dispatch(agent, task) {
      assertTempRoot(file);
      fs.appendFileSync(file, `- \`${day} 10:00\` → Dispatched \`${agent}\` (B1) to ${task}\n`);
    },
    note(text) {
      assertTempRoot(file);
      fs.appendFileSync(file, `- \`${day} 10:00\` 📝 ${text}\n`);
    },
  };
}

module.exports = { assertTempRoot, makeTempProject, makeLogWriter, makeJournalWriter };
