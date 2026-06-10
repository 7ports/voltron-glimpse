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
// Windows / Docker-Desktop variants of one root to a single canonical key:
//   C:\work\proj  /host_mnt/c/work/proj  //host_mnt/c/work/proj  /c/work/proj
// all become  c/work/proj. Genuine Linux paths keep their leading slash.
function normalizePodPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/').toLowerCase();
  s = s.replace(/\/{2,}/g, '/'); // collapse duplicate slashes (incl. leading //)
  s = s.replace(/^\/host_mnt\//, ''); // docker-desktop: /host_mnt/c/.. -> c/..
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
      const podKey = normalizePodPath(inspectMap.get(id)) || 'unknown';
      podCache.set(id, { podKey, podLabel: podLabelFor(podKey) });
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
  podLabelFor,
  podKeyMatches,
  resolvePods,
  selectPods,
  parseInspect,
  defaultInspectExec,
  INSPECT_FORMAT,
  WORKSPACE_DEST,
};
