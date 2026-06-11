'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

// Pod identity for Voltron Glimpse. A container's "pod" is the host source path
// of its `/workspace` bind-mount (the launching project root). See
// docs/pod-distinction-design.md §2. Read-only: we only ever `docker inspect`.

const WORKSPACE_DEST = '/workspace';

// `docker inspect` format printing, per id: "<full-id>\t<workspace-mount-source>".
const INSPECT_FORMAT =
  '{{.Id}}\t{{range .Mounts}}{{if eq .Destination "' +
  WORKSPACE_DEST +
  '"}}{{.Source}}{{end}}{{end}}';

// Normalize a host path for tolerant, cross-platform pod matching. Collapses the
// Windows / WSL2 / Docker-Desktop variants of one root to a single canonical key:
//   C:\work\proj  c:/work/proj  /c/work/proj  /host_mnt/c/work/proj
//   /mnt/c/work/proj  /run/desktop/mnt/host/c/work/proj
// all become  c/work/proj. Genuine Linux paths keep their leading slash.
function normalizePodPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/').toLowerCase();
  s = s.replace(/\/{2,}/g, '/'); // collapse duplicate slashes (incl. leading //)
  s = s.replace(/^\/run\/desktop\/mnt\/host\/([a-z])\//, '$1/'); // docker-desktop (wsl2 backend): /run/desktop/mnt/host/c/.. -> c/..
  s = s.replace(/^\/host_mnt\//, ''); // docker-desktop: /host_mnt/c/.. -> c/..
  s = s.replace(/^\/mnt\/([a-z])\//, '$1/'); // wsl2 drive mount: /mnt/c/.. -> c/..
  s = s.replace(/^([a-z]):\//, '$1/'); // windows drive: c:/.. -> c/..
  s = s.replace(/^\/([a-z])\//, '$1/'); // msys/git-bash: /c/.. -> c/..
  if (s.length > 1) s = s.replace(/\/+$/, ''); // drop trailing slash
  return s;
}

// Display label for a normalized pod key (its basename). 'unknown' stays 'unknown'.
function podLabelFor(podKey) {
  if (!podKey || podKey === 'unknown') return 'unknown';
  return path.posix.basename(podKey) || 'unknown';
}

// Recognize a Windows-drive host path in any of the encodings a `docker inspect`
// mount-source can use, and split it into { letter, rest } where `rest` is the
// forward-slash path under the drive (no leading slash). Returns null for a
// genuine Linux path (e.g. /home/user/proj) or any unrecognized form. The
// single-letter drive segment is what distinguishes a drive mount (/mnt/c/..)
// from a real multi-segment Linux mount (/mnt/data/..).
function parseDriveEncoded(u) {
  if (typeof u !== 'string') return null;
  const c = u.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  let m;
  // docker-desktop (wsl2 backend): /run/desktop/mnt/host/c/..
  if ((m = /^\/run\/desktop\/mnt\/host\/([a-zA-Z])(?:\/(.*))?$/.exec(c)))
    return { letter: m[1], rest: m[2] || '' };
  // docker-desktop (linux backend): /host_mnt/c/..
  if ((m = /^\/host_mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(c)))
    return { letter: m[1], rest: m[2] || '' };
  // wsl2 drive mount: /mnt/c/..  (single-letter segment only)
  if ((m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(c)))
    return { letter: m[1], rest: m[2] || '' };
  // windows drive: c:/..
  if ((m = /^([a-zA-Z]):(?:\/(.*))?$/.exec(c)))
    return { letter: m[1], rest: m[2] || '' };
  // msys / git-bash: /c/..  (single-letter segment only)
  if ((m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(c)))
    return { letter: m[1], rest: m[2] || '' };
  return null;
}

// Translate a `docker inspect` mount-source (the pod's host project dir) into a
// path THIS host's Node process can actually read — i.e. reverse the encoding to
// the running host's native filesystem view. On a Windows host every drive
// encoding (/host_mnt/c/.., /mnt/c/.., /run/desktop/mnt/host/c/.., c:/.., /c/..)
// becomes a real `C:\..` path; on a POSIX host (e.g. WSL2) a drive encoding
// becomes `/mnt/c/..` (WSL2's host-drive view). Genuine Linux paths
// (/home/user/proj, /mnt/data/proj) pass through unchanged on both. `platform`
// is injectable (defaults to process.platform) so the win32/posix branches are
// testable on either runner. Returns '' for non-string/empty input.
function toHostPath(mountSource, platform) {
  if (typeof mountSource !== 'string') return '';
  const s = mountSource.trim();
  if (!s) return '';
  const plat = platform || process.platform;
  const drive = parseDriveEncoded(s);
  if (!drive) return s; // genuine Linux path (or already host-native) — leave as-is
  if (plat === 'win32') {
    const rest = drive.rest ? '\\' + drive.rest.replace(/\//g, '\\') : '\\';
    return drive.letter.toUpperCase() + ':' + rest;
  }
  return '/mnt/' + drive.letter.toLowerCase() + (drive.rest ? '/' + drive.rest : '');
}

// Default read-only inspect: shell out to `docker inspect` for the given ids.
// Resolves with stdout even on non-zero exit when SOME output exists (docker
// inspect exits non-zero if any id is gone but still prints the resolvable ones).
function defaultInspectExec(ids) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['inspect', '--format', INSPECT_FORMAT, ...ids],
      { maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) reject(err);
        else resolve(stdout || '');
      }
    );
  });
}

// Parse the tab-format inspect output into Map<id, sourcePath>. A mount-less
// container yields an empty source (line is "<id>\t").
function parseInspect(text) {
  const map = new Map();
  if (typeof text !== 'string') return map;
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.trim()) continue;
    const tab = line.indexOf('\t');
    const id = (tab === -1 ? line : line.slice(0, tab)).trim();
    const src = tab === -1 ? '' : line.slice(tab + 1).trim();
    if (id) map.set(id, src);
  }
  return map;
}

// Attribute each container to its pod, inspecting ONCE per newly-seen id and
// caching by id for the container's lifetime (steady-state polls do zero
// inspects). Evicts cache entries for ids no longer present. Never throws: an
// inspect failure or a mount-less container yields podKey 'unknown'.
// `exec(ids) => Promise<string>` is injectable for tests.
async function resolvePods(containers, { exec, cache } = {}) {
  const list = Array.isArray(containers) ? containers : [];
  const podCache = cache instanceof Map ? cache : new Map();
  const inspect = typeof exec === 'function' ? exec : defaultInspectExec;

  const seen = new Set();
  const newIds = [];
  for (const c of list) {
    if (!c || !c.id) continue;
    seen.add(c.id);
    if (!podCache.has(c.id)) newIds.push(c.id);
  }

  if (newIds.length > 0) {
    let inspectMap = new Map();
    try {
      const out = await inspect(newIds);
      inspectMap = parseInspect(typeof out === 'string' ? out : '');
    } catch {
      inspectMap = new Map(); // whole batch failed: leave uncached, retry next poll
    }
    for (const id of newIds) {
      if (!inspectMap.has(id)) continue; // unresolved this round -> retry next poll
      const rawSource = inspectMap.get(id);
      const podKey = normalizePodPath(rawSource) || 'unknown';
      // podRoot is the HOST-READABLE absolute project dir (mount source translated
      // to this host's filesystem view) — used to watch <podRoot>/.voltron/logs.
      const podRoot = toHostPath(rawSource) || null;
      podCache.set(id, { podKey, podLabel: podLabelFor(podKey), podRoot });
    }
  }

  // Bound memory: forget ids that are no longer running.
  for (const id of Array.from(podCache.keys())) {
    if (!seen.has(id)) podCache.delete(id);
  }

  return list.map((c) => {
    const pod = (c && c.id && podCache.get(c.id)) || null;
    return {
      ...c,
      podKey: pod ? pod.podKey : 'unknown',
      podLabel: pod ? pod.podLabel : 'unknown',
      podRoot: pod && pod.podRoot ? pod.podRoot : null,
    };
  });
}

// Path-equality of two pod keys after normalization (either may be a raw form).
function podKeyMatches(a, b) {
  const na = normalizePodPath(a);
  const nb = normalizePodPath(b);
  return na !== '' && nb !== '' && na === nb;
}

// Scope a pod-attributed row set per the flag surface (design §3.2):
//   default          -> keep only self-pod rows, but ALWAYS keep `unknown`
//                       (never silently drop a container we couldn't attribute)
//   { allPods:true } -> keep everything
//   { pods:[..] }    -> keep only rows matching a requested label or path
// Every returned row is tagged `selfPod: true|false`.
function selectPods(rows, opts, selfPodKey) {
  const list = Array.isArray(rows) ? rows : [];
  const o = opts || {};
  const self = normalizePodPath(selfPodKey);

  const tagged = list.map((r) => ({
    ...r,
    selfPod: r && r.podKey && r.podKey !== 'unknown' ? podKeyMatches(r.podKey, self) : false,
  }));

  if (o.allPods) return tagged;

  if (Array.isArray(o.pods) && o.pods.length > 0) {
    const wanted = o.pods.filter((w) => typeof w === 'string' && w.trim());
    return tagged.filter((r) => {
      if (!r || r.podKey === 'unknown') return false;
      const key = normalizePodPath(r.podKey);
      const label = normalizePodPath(r.podLabel);
      return wanted.some((w) => {
        const nw = normalizePodPath(w);
        return nw === key || nw === label || podKeyMatches(r.podKey, w);
      });
    });
  }

  // Default: scope to self pod; keep unknowns so activity is never lost.
  return tagged.filter((r) => r && (r.selfPod || r.podKey === 'unknown'));
}

module.exports = {
  normalizePodPath,
  toHostPath,
  podLabelFor,
  podKeyMatches,
  resolvePods,
  selectPods,
  parseInspect,
  defaultInspectExec,
  INSPECT_FORMAT,
  WORKSPACE_DEST,
};
