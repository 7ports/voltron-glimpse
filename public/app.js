/**
 * Voltron Glimpse — live dashboard behavior.
 *
 * Single IIFE, no modules / imports / build step. Consumes browser globals
 * (window.cytoscape, window.GLIMPSE_CYTO_STYLE) and a WebSocket served from
 * the same origin. Read-only observer: we never POST/write anything.
 */
(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────────────
   * Constants & baked-in maps
   * ────────────────────────────────────────────────────────────────────── */

  // Tier map mirrors src/model/tiers.js. Unknown agents (and beads) → 3.
  var TIER_MAP = {
    'scrum-master': 1,
    'code-analyst': 1,
    'doc-writer': 1,
    'project-planner': 1,
    'reflection-processor': 1,
    'fullstack-dev': 2,
    'csharp-dev': 2,
    'devops-engineer': 2,
    'qa-tester': 2,
    'scene-architect': 2,
    'ui-designer': 2,
    'shader-artist': 2,
    'asset-manager': 2,
  };

  // Strip the container ISO timestamp suffix to recover the bare agent name.
  var CONTAINER_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-[A-Za-z0-9]+)?$/;

  var STATUS_KEYS = ['queued', 'dispatching', 'working', 'done', 'blocked', 'errored'];
  var STATUS_PRECEDENCE = {
    errored: 6, blocked: 5, done: 4, working: 3, dispatching: 2, queued: 1,
  };

  var PROGRESS_TO_STATE = {
    queued: 'queued',
    in_progress: 'working',
    completed: 'done',
    blocked: 'blocked',
    failed: 'errored',
  };
  var BEAD_TO_PROGRESS = {
    open: 'queued',
    in_progress: 'in_progress',
    closed: 'completed',
    blocked: 'blocked',
  };

  var LOG_CAP = 200;
  var FEED_DOM_CAP = 500;
  var RELAYOUT_DEBOUNCE_MS = 150;

  /* ──────────────────────────────────────────────────────────────────────
   * DOM lookups (null-safe wrapper)
   * ────────────────────────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  var els = {
    badge: $('connection-badge'),
    agentChips: $('agent-filter-chips'),
    phaseChips: $('phase-filter-chips'),
    feed: $('activity-feed'),
    cy: $('cy'),
    btnFit: $('btn-fit'),
    btnZoomIn: $('btn-zoom-in'),
    btnZoomOut: $('btn-zoom-out'),
    phaseBars: $('phase-bars'),
    activeAgents: $('active-agents'),
    modalNode: $('modal-node'),
    modalNodeTitle: $('modal-node-title'),
    modalNodeClose: $('modal-node-close'),
    nodeMeta: $('node-meta'),
    nodeLogTail: $('node-log-tail'),
    modalAnalysis: $('modal-analysis'),
    modalAnalysisTitle: $('modal-analysis-title'),
    modalAnalysisClose: $('modal-analysis-close'),
    analysisContent: $('analysis-content'),
  };

  /* ──────────────────────────────────────────────────────────────────────
   * Internal state
   * ────────────────────────────────────────────────────────────────────── */

  var nodes = {};            // id -> node record
  var edgeIds = {};          // edge id -> true (de-dupe)
  var phases = {};           // phase name -> { total, done }
  var feedEntries = [];      // array of feed entry objects (newest pushed last)
  var analysesById = {};     // analysis id -> payload (for modal)
  var seedCounts = null;     // counts:update seed before nodes exist

  var filterAgent = '__all__';
  var filterPhase = '__all__';

  var cy = null;
  var didInitialFit = false;
  var relayoutTimer = null;

  /* ──────────────────────────────────────────────────────────────────────
   * Small helpers
   * ────────────────────────────────────────────────────────────────────── */

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function bareAgentName(name) {
    if (typeof name !== 'string') return '';
    return name.replace(CONTAINER_SUFFIX_RE, '');
  }

  function getTier(record) {
    if (record && record.kind === 'bead') return 3;
    var bare = bareAgentName((record && record.agent) || (record && record.id) || '');
    var t = TIER_MAP[bare];
    return typeof t === 'number' ? t : 3;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Normalization — turn a raw 'agent:update' / snapshot agent payload into
   * accumulated fields on a node record, then derive the visual status.
   * ────────────────────────────────────────────────────────────────────── */

  function resolveNodeId(p) {
    return p.id || p.nodeId || p.containerName || p.taskId || p.agent || null;
  }

  function deriveAgentName(p, id) {
    if (p.kind === 'bead') return p.title || p.id || id;
    return p.agent || p.assignee || id;
  }

  // A payload is "progress-shaped" when it has a taskId, or carries a `status`
  // enum without being a log payload (which uses nodeId/state instead).
  function isProgressShape(p) {
    if (typeof p.taskId !== 'undefined') return true;
    if (typeof p.status !== 'undefined' &&
        typeof p.nodeId === 'undefined' &&
        typeof p.state === 'undefined') {
      return true;
    }
    return false;
  }

  // Combine progressStatus + logState/exitCode into one visual status,
  // mirroring src/model/statusMachine.js.
  function deriveStatus(rec) {
    var fromProgress = (typeof rec.progressStatus === 'string')
      ? (PROGRESS_TO_STATE[rec.progressStatus] || null) : null;

    var fromLog = null;
    var ls = rec.logState;
    if (ls === 'errored') fromLog = 'errored';
    else if (ls === 'done') fromLog = 'done';
    else if (ls === 'working') fromLog = 'working';
    else if (ls === 'dispatching') fromLog = 'dispatching';
    else if (typeof rec.exitCode === 'number') fromLog = (rec.exitCode !== 0) ? 'errored' : 'done';

    if (fromLog === 'errored' || fromProgress === 'errored') return 'errored';
    if (fromProgress === 'blocked') return 'blocked';
    if (fromLog) return fromLog;
    if (fromProgress) return fromProgress;
    return 'queued';
  }

  // Apply a raw agent payload to the in-memory node record. Returns the id,
  // or null if it should be skipped.
  function applyAgentPayload(p) {
    var id = resolveNodeId(p);
    if (!id) return null;

    var rec = nodes[id];
    var isNew = false;
    if (!rec) {
      rec = nodes[id] = { id: id, logs: [], structuralDirty: true };
      isNew = true;
    }

    rec.label = deriveAgentName(p, id);
    rec.agent = p.agent || p.assignee || rec.agent || id;

    if (p.kind === 'bead') {
      rec.kind = 'bead';
      rec.title = p.title || rec.title;
      rec.priority = p.priority != null ? p.priority : rec.priority;
      rec.issueType = p.issue_type != null ? p.issue_type : rec.issueType;
      rec.updatedAt = p.updated_at || rec.updatedAt;
      var mapped = BEAD_TO_PROGRESS[p.status];
      rec.progressStatus = mapped || 'queued';
    } else if (isProgressShape(p)) {
      // Progress shape (has status from the progress enum, taskId/description).
      if (typeof p.status === 'string') rec.progressStatus = p.status;
      if (p.taskId != null) rec.taskId = p.taskId;
      if (p.phase != null) rec.phase = p.phase;
      if (p.description != null) rec.description = p.description;
      if (p.createdAt != null) rec.createdAt = p.createdAt;
      if (p.startedAt != null) rec.startedAt = p.startedAt;
      if (p.completedAt != null) rec.completedAt = p.completedAt;
      if (p.updatedAt != null) rec.updatedAt = p.updatedAt;
    }

    // Log shape (may coexist with progress fields on the same payload).
    if (typeof p.state === 'string' || typeof p.exitCode === 'number' ||
        p.latestStep != null || p.containerName != null) {
      applyLogFields(rec, p);
    }

    rec.status = deriveStatus(rec);
    if (isNew) rec.structuralDirty = true;
    return id;
  }

  function applyLogFields(rec, p) {
    if (typeof p.state === 'string') rec.logState = p.state;
    if (typeof p.exitCode === 'number') rec.exitCode = p.exitCode;
    if (p.containerName != null) rec.containerName = p.containerName;
    if (p.latestStep != null) {
      rec.latestStep = p.latestStep;
      pushLog(rec, p.latestStep);
    }
  }

  function pushLog(rec, line) {
    if (!rec.logs) rec.logs = [];
    if (rec.logs[rec.logs.length - 1] !== line) {
      rec.logs.push(line);
      if (rec.logs.length > LOG_CAP) rec.logs.splice(0, rec.logs.length - LOG_CAP);
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Cytoscape — node / edge / phase rendering
   * ────────────────────────────────────────────────────────────────────── */

  function ensurePhaseContainer(phaseName) {
    var pid = 'phase::' + phaseName;
    if (cy.getElementById(pid).nonempty()) return pid;
    cy.add({
      group: 'nodes',
      data: { id: pid, label: phaseName },
      classes: 'phase-container',
    });
    scheduleRelayout();
    return pid;
  }

  // Create a minimal placeholder node so edge endpoints never throw.
  function ensurePlaceholderNode(id) {
    if (cy.getElementById(id).nonempty()) return;
    if (!nodes[id]) {
      nodes[id] = { id: id, label: id, logs: [], progressStatus: 'queued', placeholder: true };
    }
    cy.add({ group: 'nodes', data: { id: id, label: id } });
    var n = cy.getElementById(id);
    n.addClass('tier3');
    n.addClass('queued');
    scheduleRelayout();
  }

  // Sync a node record into the cytoscape graph (create or update classes).
  function renderNode(id) {
    var rec = nodes[id];
    if (!rec) return;
    var tier = getTier(rec);
    var status = rec.status || 'queued';

    var ele = cy.getElementById(id);
    if (ele.empty()) {
      cy.add({ group: 'nodes', data: { id: id, label: rec.label || id } });
      ele = cy.getElementById(id);
      rec.structuralDirty = true;
    } else {
      ele.data('label', rec.label || id);
    }

    // Swim-lane parent assignment.
    if (rec.phase) {
      var pid = ensurePhaseContainer(rec.phase);
      if (ele.data('parent') !== pid) {
        ele.move({ parent: pid });
        rec.structuralDirty = true;
      }
    }

    // Exactly one tier class.
    ['tier1', 'tier2', 'tier3'].forEach(function (c) { ele.removeClass(c); });
    ele.addClass('tier' + tier);

    // Exactly one status class.
    STATUS_KEYS.forEach(function (c) { ele.removeClass(c); });
    ele.addClass(status);

    if (status === 'working') ele.addClass('working-pulse');
    else ele.removeClass('working-pulse');

    if (rec.structuralDirty) {
      scheduleRelayout();
      rec.structuralDirty = false;
    }

    updateDispatchEdgeActivity(id, status === 'working');
  }

  // Toggle `active` on dispatch edges targeting this node.
  function updateDispatchEdgeActivity(targetId, isWorking) {
    if (!cy) return;
    var node = cy.getElementById(targetId);
    if (node.empty()) return;
    node.connectedEdges('.dispatch').forEach(function (e) {
      if (e.data('target') === targetId) {
        if (isWorking) e.addClass('active');
        else e.removeClass('active');
      }
    });
  }

  function applyEdge(p) {
    var from = p.from, to = p.to, kind = p.kind;
    if (!from || !to || !kind) return;
    var id = from + '__' + kind + '__' + to;
    if (edgeIds[id]) return;

    ensurePlaceholderNode(from);
    ensurePlaceholderNode(to);

    cy.add({ group: 'edges', data: { id: id, source: from, target: to } });
    cy.getElementById(id).addClass(kind);
    edgeIds[id] = true;
    scheduleRelayout();

    // Reflect active state if target is already working.
    var tRec = nodes[to];
    if (kind === 'dispatch' && tRec && tRec.status === 'working') {
      updateDispatchEdgeActivity(to, true);
    }
  }

  function scheduleRelayout() {
    if (relayoutTimer) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () {
      relayoutTimer = null;
      runLayout(false);
    }, RELAYOUT_DEBOUNCE_MS);
  }

  function runLayout(fit) {
    if (!cy || cy.nodes().length === 0) return;
    try {
      cy.layout({
        name: 'dagre',
        rankDir: 'LR',
        nodeSep: 25,
        rankSep: 60,
        fit: !!fit,
      }).run();
    } catch (e) {
      // dagre may not be registered in some odd state — fail soft.
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Status counts — authoritative live tally from node records.
   * ────────────────────────────────────────────────────────────────────── */

  function recomputeCounts() {
    var tally = { queued: 0, dispatching: 0, working: 0, done: 0, blocked: 0, errored: 0 };
    var any = false;
    Object.keys(nodes).forEach(function (id) {
      var rec = nodes[id];
      any = true;
      var s = rec.status || 'queued';
      if (tally[s] != null) tally[s] += 1;
    });

    // Seed from counts:update only when no nodes exist yet.
    if (!any && seedCounts) tally = seedCounts;

    STATUS_KEYS.forEach(function (k) {
      var el = $('count-' + k);
      if (el) el.textContent = String(tally[k] || 0);
    });
  }

  function seedFromCounts(p) {
    seedCounts = {
      queued: p.queued || 0,
      dispatching: 0,
      working: p.in_progress || 0,
      done: p.completed || 0,
      blocked: p.blocked || 0,
      errored: p.failed || 0,
    };
    if (Object.keys(nodes).length === 0) recomputeCounts();
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Phase progress bars
   * ────────────────────────────────────────────────────────────────────── */

  function applyPhase(name, total, done) {
    if (name == null) return;
    phases[name] = {
      total: (typeof total === 'number') ? total : 0,
      done: (typeof done === 'number') ? done : 0,
    };
    renderPhaseBars();
  }

  function renderPhaseBars() {
    if (!els.phaseBars) return;
    els.phaseBars.textContent = '';
    Object.keys(phases).forEach(function (name) {
      var ph = phases[name];
      var total = ph.total || 0;
      var done = ph.done || 0;
      var pct = total === 0 ? 0 : Math.round((done / total) * 100);

      var row = document.createElement('div');
      row.className = 'phase-bar-row';

      var label = document.createElement('span');
      label.className = 'phase-bar-label';
      label.textContent = name;

      var track = document.createElement('div');
      track.className = 'phase-bar-track';
      var fill = document.createElement('div');
      fill.className = 'phase-bar-fill';
      fill.style.width = pct + '%';
      track.appendChild(fill);

      var count = document.createElement('span');
      count.className = 'phase-bar-count';
      count.textContent = done + '/' + total;

      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(count);
      els.phaseBars.appendChild(row);
    });
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Active-now strip
   * ────────────────────────────────────────────────────────────────────── */

  function renderActiveStrip() {
    if (!els.activeAgents) return;
    els.activeAgents.textContent = '';
    Object.keys(nodes).forEach(function (id) {
      var rec = nodes[id];
      if (rec.status !== 'working') return;
      var chip = document.createElement('span');
      chip.className = 'active-chip';
      var name = document.createElement('strong');
      name.textContent = bareAgentName(rec.agent || rec.label || id) || id;
      chip.appendChild(name);
      if (rec.latestStep) {
        var step = document.createElement('span');
        step.className = 'active-chip-step';
        step.textContent = ' · ' + rec.latestStep;
        chip.appendChild(step);
      }
      els.activeAgents.appendChild(chip);
    });
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Activity feed + filter chips
   * ────────────────────────────────────────────────────────────────────── */

  function addJournalEntry(p) {
    feedEntries.push({
      type: 'journal',
      time: p.time || '',
      date: p.date || '',
      emoji: p.emoji || '•',
      agent: p.agent || '',
      kind: p.kind || '',
      text: p.text || '',
    });
    trimFeed();
    renderFeed();
    rebuildChips();
  }

  function addAnalysisFeedEntry(p) {
    feedEntries.push({
      type: 'analysis',
      analysisId: p.id,
      time: '',
      emoji: '📄',
      agent: p.topic || '',
      kind: 'analysis',
      text: p.title || p.topic || p.id || 'analysis',
    });
    trimFeed();
    renderFeed();
    rebuildChips();
  }

  function trimFeed() {
    if (feedEntries.length > FEED_DOM_CAP * 2) {
      feedEntries.splice(0, feedEntries.length - FEED_DOM_CAP * 2);
    }
  }

  // Does an entry pass the current agent + phase filters?
  function entryPasses(entry) {
    if (filterAgent !== '__all__') {
      var a = bareAgentName(entry.agent) || entry.agent;
      if (a !== filterAgent && entry.agent !== filterAgent) return false;
    }
    if (filterPhase !== '__all__') {
      // Map entry.agent -> node phase; entries with no known node skip phase filter.
      var rec = findNodeByAgent(entry.agent);
      if (rec && rec.phase && rec.phase !== filterPhase) return false;
      if (rec && !rec.phase) return false;
      // unknown agent / no node → allow through (can't determine phase)
    }
    return true;
  }

  function findNodeByAgent(agent) {
    if (!agent) return null;
    var bare = bareAgentName(agent);
    var found = null;
    Object.keys(nodes).forEach(function (id) {
      var rec = nodes[id];
      if (found) return;
      if (rec.agent === agent || bareAgentName(rec.agent) === bare ||
          rec.id === agent || rec.label === agent) {
        found = rec;
      }
    });
    return found;
  }

  function renderFeed() {
    if (!els.feed) return;
    els.feed.textContent = '';
    var rendered = 0;
    // newest on top → iterate from end backwards.
    for (var i = feedEntries.length - 1; i >= 0 && rendered < FEED_DOM_CAP; i--) {
      var entry = feedEntries[i];
      if (!entryPasses(entry)) continue;
      els.feed.appendChild(buildFeedItem(entry));
      rendered++;
    }
  }

  function buildFeedItem(entry) {
    var li = document.createElement('li');
    li.className = 'feed-item feed-' + (entry.kind || 'event');

    var emoji = document.createElement('span');
    emoji.className = 'feed-emoji';
    emoji.textContent = entry.emoji || '•';
    li.appendChild(emoji);

    if (entry.time) {
      var time = document.createElement('span');
      time.className = 'feed-time';
      time.textContent = entry.time;
      li.appendChild(time);
    }

    if (entry.agent) {
      var agent = document.createElement('span');
      agent.className = 'feed-agent';
      agent.textContent = bareAgentName(entry.agent) || entry.agent;
      li.appendChild(agent);
    }

    if (entry.kind) {
      var badge = document.createElement('span');
      badge.className = 'feed-kind-badge';
      badge.textContent = entry.kind;
      li.appendChild(badge);
    }

    var text = document.createElement('span');
    text.className = 'feed-text';
    text.textContent = entry.text || '';
    li.appendChild(text);

    if (entry.type === 'analysis') {
      li.classList.add('feed-clickable');
      li.addEventListener('click', function () {
        openAnalysisModal(entry.analysisId);
      });
    }
    return li;
  }

  // Build single-select chip groups for agents and phases.
  function rebuildChips() {
    var agentSet = {};
    var phaseSet = {};
    Object.keys(nodes).forEach(function (id) {
      var rec = nodes[id];
      var a = bareAgentName(rec.agent) || rec.agent || id;
      if (a) agentSet[a] = true;
      if (rec.phase) phaseSet[rec.phase] = true;
    });
    feedEntries.forEach(function (e) {
      if (e.type === 'journal' && e.agent) {
        var a = bareAgentName(e.agent) || e.agent;
        agentSet[a] = true;
      }
    });

    renderChipGroup(els.agentChips, Object.keys(agentSet).sort(), 'agent');
    renderChipGroup(els.phaseChips, Object.keys(phaseSet).sort(), 'phase');
  }

  function renderChipGroup(container, values, group) {
    if (!container) return;
    container.textContent = '';
    var active = group === 'agent' ? filterAgent : filterPhase;

    container.appendChild(buildChip('All', '__all__', group, active === '__all__'));
    values.forEach(function (v) {
      container.appendChild(buildChip(v, v, group, active === v));
    });
  }

  function buildChip(label, value, group, isActive) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip' + (isActive ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', function () {
      if (group === 'agent') filterAgent = value;
      else filterPhase = value;
      rebuildChips();
      renderFeed();
    });
    return btn;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Node detail modal
   * ────────────────────────────────────────────────────────────────────── */

  function openNodeModal(id) {
    var rec = nodes[id];
    if (!rec || !els.modalNode) return;

    if (els.modalNodeTitle) {
      els.modalNodeTitle.textContent = bareAgentName(rec.agent || rec.label || id) || id;
    }

    if (els.nodeMeta) {
      els.nodeMeta.textContent = '';
      addMetaRow('Container', rec.containerName);
      addMetaRow('Status', rec.status);
      addMetaRow('Exit code', (typeof rec.exitCode === 'number') ? String(rec.exitCode) : null);
      addMetaRow('Latest step', rec.latestStep);
      addMetaRow('Phase', rec.phase);
      addMetaRow('Description', rec.description);
      addMetaRow('Kind', rec.kind);
      addMetaRow('Title', rec.title);
      addMetaRow('Priority', rec.priority);
      addMetaRow('Issue type', rec.issueType);
      addMetaRow('Created', rec.createdAt);
      addMetaRow('Started', rec.startedAt);
      addMetaRow('Completed', rec.completedAt);
      addMetaRow('Updated', rec.updatedAt);
    }

    if (els.nodeLogTail) {
      var tail = (rec.logs && rec.logs.length) ? rec.logs.join('\n') : (rec.latestStep || '');
      els.nodeLogTail.textContent = tail;
    }

    els.modalNode.classList.remove('hidden');
  }

  function addMetaRow(label, value) {
    if (value == null || value === '') return;
    var row = document.createElement('div');
    row.className = 'meta-row';
    var k = document.createElement('span');
    k.className = 'meta-key';
    k.textContent = label;
    var v = document.createElement('span');
    v.className = 'meta-val';
    v.textContent = String(value);
    row.appendChild(k);
    row.appendChild(v);
    els.nodeMeta.appendChild(row);
  }

  function closeNodeModal() {
    if (els.modalNode) els.modalNode.classList.add('hidden');
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Analysis modal + tiny markdown renderer
   * ────────────────────────────────────────────────────────────────────── */

  function openAnalysisModal(analysisId) {
    var a = analysesById[analysisId];
    if (!a || !els.modalAnalysis) return;

    if (els.modalAnalysisTitle) {
      els.modalAnalysisTitle.textContent = a.title || a.topic || a.id || 'Analysis';
    }
    if (els.analysisContent) {
      var md = a.markdown || a.content;
      if (md) {
        els.analysisContent.innerHTML = renderMarkdown(md);
      } else {
        var note = '## ' + (a.title || a.topic || 'Analysis') + '\n\n' +
          (a.timestamp ? ('_' + a.timestamp + '_\n\n') : '') +
          (a.path ? ('`' + a.path + '`') : '');
        els.analysisContent.innerHTML = renderMarkdown(note);
      }
    }
    els.modalAnalysis.classList.remove('hidden');
  }

  function closeAnalysisModal() {
    if (els.modalAnalysis) els.modalAnalysis.classList.add('hidden');
  }

  // Small, dependency-free, safe markdown → HTML. Escape FIRST, then emit
  // only known tags. Supports headings, fenced code, inline code, bold,
  // italic, links, unordered lists, paragraphs.
  function renderMarkdown(src) {
    var text = String(src).replace(/\r\n/g, '\n');
    var lines = text.split('\n');
    var out = [];
    var inCode = false;
    var codeBuf = [];
    var listBuf = [];
    var paraBuf = [];

    function flushPara() {
      if (paraBuf.length) {
        out.push('<p>' + inline(paraBuf.join('<br>')) + '</p>');
        paraBuf = [];
      }
    }
    function flushList() {
      if (listBuf.length) {
        out.push('<ul>' + listBuf.map(function (item) {
          return '<li>' + inline(item) + '</li>';
        }).join('') + '</ul>');
        listBuf = [];
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = /^\s*```/.test(line);

      if (fence) {
        if (inCode) {
          out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
          codeBuf = [];
          inCode = false;
        } else {
          flushPara(); flushList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushPara(); flushList();
        var level = heading[1].length;
        out.push('<h' + level + '>' + inline(escapeHtml(heading[2])) + '</h' + level + '>');
        continue;
      }

      var li = /^\s*[-*]\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        listBuf.push(escapeHtml(li[1]));
        continue;
      }

      if (/^\s*$/.test(line)) {
        flushPara(); flushList();
        continue;
      }

      flushList();
      paraBuf.push(escapeHtml(line));
    }

    if (inCode) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
    flushPara(); flushList();
    return out.join('\n');
  }

  // Inline formatting on already-escaped text: code, bold, italic, links.
  function inline(s) {
    // inline code first (so we don't process markdown inside it)
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    // links [text](url) — url already escaped; only allow http/https/relative
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, url) {
      if (/^javascript:/i.test(url)) return t;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return s;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Render orchestration after applying any change.
   * ────────────────────────────────────────────────────────────────────── */

  function refreshDerived() {
    recomputeCounts();
    renderActiveStrip();
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Snapshot + patch dispatch
   * ────────────────────────────────────────────────────────────────────── */

  function applySnapshot(state) {
    // Full replace of all state.
    nodes = {};
    edgeIds = {};
    phases = {};
    feedEntries = [];
    analysesById = {};
    seedCounts = null;
    didInitialFit = false;

    if (cy) cy.elements().remove();

    state = state || {};

    if (state.counts) seedFromCounts(state.counts);

    // Agents (object keyed by id; each value is a raw shape).
    if (state.agents) {
      Object.keys(state.agents).forEach(function (key) {
        var raw = state.agents[key];
        if (!raw || typeof raw !== 'object') return;
        if (resolveNodeId(raw) == null && key) raw = shallowWithId(raw, key);
        applyAgentPayload(raw);
      });
    }

    // Phases (object keyed by id; values may be {phase,total,done} or keyed).
    if (state.phases) {
      Object.keys(state.phases).forEach(function (key) {
        var ph = state.phases[key];
        if (!ph || typeof ph !== 'object') return;
        var name = ph.phase || key;
        applyPhase(name, ph.total, ph.done);
      });
    }

    // Render all nodes.
    Object.keys(nodes).forEach(function (id) { renderNode(id); });

    // Edges (array).
    if (Array.isArray(state.edges)) {
      state.edges.forEach(function (e) { applyEdge(e); });
    }

    // Journal (array).
    if (Array.isArray(state.journal)) {
      state.journal.forEach(function (entry) {
        feedEntries.push({
          type: 'journal',
          time: entry.time || '',
          date: entry.date || '',
          emoji: entry.emoji || '•',
          agent: entry.agent || '',
          kind: entry.kind || '',
          text: entry.text || '',
        });
      });
    }

    // Analyses (array).
    if (Array.isArray(state.analyses)) {
      state.analyses.forEach(function (a) {
        if (!a || a.id == null) return;
        analysesById[a.id] = a;
        feedEntries.push({
          type: 'analysis',
          analysisId: a.id,
          time: '',
          emoji: '📄',
          agent: a.topic || '',
          kind: 'analysis',
          text: a.title || a.topic || a.id,
        });
      });
    }

    trimFeed();
    rebuildChips();
    renderFeed();
    renderPhaseBars();
    refreshDerived();

    // Layout + fit once after the snapshot.
    if (relayoutTimer) { clearTimeout(relayoutTimer); relayoutTimer = null; }
    runLayout(true);
    didInitialFit = true;
  }

  function shallowWithId(obj, id) {
    var copy = {};
    Object.keys(obj).forEach(function (k) { copy[k] = obj[k]; });
    if (copy.id == null) copy.id = id;
    return copy;
  }

  function applyPatch(event, payload) {
    payload = payload || {};
    switch (event) {
      case 'agent:update': {
        var id = applyAgentPayload(payload);
        if (id) { renderNode(id); rebuildChips(); refreshDerived(); }
        break;
      }
      case 'log:update': {
        var lid = resolveNodeId(payload);
        if (!lid) break;
        if (!nodes[lid]) nodes[lid] = { id: lid, logs: [], structuralDirty: true };
        var rec = nodes[lid];
        if (!rec.agent) rec.agent = payload.agent || lid;
        if (!rec.label) rec.label = payload.agent || lid;
        applyLogFields(rec, payload);
        rec.status = deriveStatus(rec);
        renderNode(lid);
        refreshDerived();
        break;
      }
      case 'edge:update':
        applyEdge(payload);
        break;
      case 'journal:append':
        addJournalEntry(payload);
        break;
      case 'phase:update':
        applyPhase(payload.phase, payload.total, payload.done);
        break;
      case 'analysis:add':
        if (payload.id != null) {
          analysesById[payload.id] = payload;
          addAnalysisFeedEntry(payload);
        }
        break;
      case 'counts:update':
        seedFromCounts(payload);
        recomputeCounts();
        break;
      default:
        break;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Connection badge
   * ────────────────────────────────────────────────────────────────────── */

  function setBadge(stateClass, label) {
    if (!els.badge) return;
    ['connected', 'reconnecting', 'disconnected'].forEach(function (c) {
      els.badge.classList.remove(c);
    });
    els.badge.classList.add(stateClass);
    var labelEl = els.badge.querySelector('.connection-label');
    if (labelEl) labelEl.textContent = label;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * WebSocket client with exponential backoff reconnect.
   * ────────────────────────────────────────────────────────────────────── */

  var ws = null;
  var backoff = 500;
  var BACKOFF_MAX = 10000;
  var hasConnectedOnce = false;

  function connect() {
    try {
      ws = new WebSocket('ws://' + location.host);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      hasConnectedOnce = true;
      backoff = 500;
      setBadge('connected', 'Connected');
    };

    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'snapshot') {
          applySnapshot(msg.state);
        } else if (msg.type === 'patch') {
          applyPatch(msg.event, msg.payload);
        }
      } catch (err) {
        // One malformed message must never break the socket.
      }
    };

    ws.onerror = function () {
      try { ws.close(); } catch (e) { /* ignore */ }
    };

    ws.onclose = function () {
      setBadge('reconnecting', 'Reconnecting…');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    var jitter = Math.floor(Math.random() * 250);
    var delay = Math.min(backoff, BACKOFF_MAX) + jitter;
    setTimeout(connect, delay);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Init — cytoscape, toolbar, modal wiring, then connect.
   * ────────────────────────────────────────────────────────────────────── */

  function initCytoscape() {
    cy = cytoscape({
      container: els.cy,
      style: window.GLIMPSE_CYTO_STYLE,
      layout: { name: 'preset' },
      wheelSensitivity: 0.2,
      elements: [],
    });

    cy.on('tap', 'node', function (evt) {
      var node = evt.target;
      if (node.hasClass('phase-container')) return;
      openNodeModal(node.id());
    });
  }

  function wireToolbar() {
    if (els.btnFit) els.btnFit.addEventListener('click', function () { cy.fit(undefined, 40); });
    if (els.btnZoomIn) els.btnZoomIn.addEventListener('click', function () {
      cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    });
    if (els.btnZoomOut) els.btnZoomOut.addEventListener('click', function () {
      cy.zoom({ level: cy.zoom() * 0.8, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    });
  }

  function wireModals() {
    if (els.modalNodeClose) els.modalNodeClose.addEventListener('click', closeNodeModal);
    if (els.modalAnalysisClose) els.modalAnalysisClose.addEventListener('click', closeAnalysisModal);

    // Backdrop click: close only when the backdrop element itself is clicked.
    if (els.modalNode) {
      els.modalNode.addEventListener('click', function (e) {
        if (e.target === els.modalNode) closeNodeModal();
      });
    }
    if (els.modalAnalysis) {
      els.modalAnalysis.addEventListener('click', function (e) {
        if (e.target === els.modalAnalysis) closeAnalysisModal();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeNodeModal(); closeAnalysisModal(); }
    });
  }

  function init() {
    initCytoscape();
    wireToolbar();
    wireModals();
    setBadge('disconnected', 'Connecting…');
    recomputeCounts();
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
