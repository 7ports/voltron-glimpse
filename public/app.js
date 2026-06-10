/**
 * Voltron Glimpse — LIVE CORE + ANIMATION PASS (build-steps F2 + F3).
 *
 * A real-time, present-tense picture of the Voltron agents whose Docker
 * containers are running right now, plus the inferred dispatch spokes from a
 * synthetic `scrum-master` hub. Read-only observer: we only consume a WS feed
 * served from the same origin and never write anything.
 *
 * No modules / imports / build step. Consumes browser globals only:
 *   - window.cytoscape          (vendor/cytoscape.min.js, core only — NO dagre)
 *   - window.GLIMPSE_CYTO_STYLE (cytoscape-style.js)
 *
 * Animation (§4 of docs/live-monitor-redesign.md):
 *   - §4.1 Node entrance  — scale+fade in, one-shot ripple overlay
 *   - §4.2 Working pulse  — shared rAF loop, sinusoidal border + overlay, phase-jittered
 *   - §4.3 Edge flow      — marching-ants line-dash-offset on dispatch spokes to working agents
 *   - §4.4 Exit wind-down — terminal flash, scale-down + fade, linger, then remove
 *   - §4.5 Layout motion  — concentric relayout with animate:true
 */
(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────────────
   * Constants & baked-in maps
   * ────────────────────────────────────────────────────────────────────── */

  // Synthetic orchestrator hub id — mirrors src/model/edges.js HUB_ID. Never a
  // real container; a fixed anchor the live agents hang off. Present only while
  // >= 1 agent is live.
  var HUB_ID = 'scrum-master';

  // Tier map mirrors src/model/tiers.js. Unknown agents default to Tier 3.
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

  // Backend live states (src/liveness.js) → CSS-safe node classes. The colon
  // form 'exiting:done' is not a valid CSS class, so it is hyphenated here.
  var STATE_CLASSES = ['dispatching', 'working', 'exiting-done', 'exiting-errored'];
  var TIER_CLASSES = ['tier1', 'tier2', 'tier3'];

  var LABEL_STEP_MAX = 28;        // truncate the [STEP] line in node labels
  var RELAYOUT_DEBOUNCE_MS = 200; // §4.5: settle a dispatch burst into one reflow
  var LAYOUT_ANIM_MS = 400;       // §4.5: glide, don't snap

  // Animation (§4)
  var PULSE_PERIOD_MS = 1400;     // §4.2: working-node breathing period
  var EDGE_FLOW_SPEED = 0.04;     // §4.3: dash-offset px per ms → ~40 px/s marching-ants

  /* ──────────────────────────────────────────────────────────────────────
   * DOM lookups (null-safe)
   * ────────────────────────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  var els = {
    cy: $('cy'),
    connBadge: $('connection-badge'),
    dockerBadge: $('docker-badge'),
    btnFit: $('btn-fit'),
    btnZoomIn: $('btn-zoom-in'),
    btnZoomOut: $('btn-zoom-out'),
    tooltip: $('node-tooltip'),
    tooltipAgent: $('tooltip-agent'),
    tooltipMeta: $('tooltip-meta'),
    tooltipClose: $('tooltip-close'),
  };

  /* ──────────────────────────────────────────────────────────────────────
   * Internal state — the in-memory mirror of the backend live set.
   * ────────────────────────────────────────────────────────────────────── */

  var liveAgents = {};   // nodeId -> live agent entry
  var edges = [];        // [{ id, source, target, kind, inferred }]
  var dockerAvailable;   // boolean | undefined (unknown until first message)

  var cy = null;
  var layoutTimer = null;
  var rafId = null;      // requestAnimationFrame handle for the pulse loop

  /* ──────────────────────────────────────────────────────────────────────
   * Small helpers
   * ────────────────────────────────────────────────────────────────────── */

  function getTier(agentName) {
    if (typeof agentName !== 'string' || agentName.length === 0) return 3;
    var t = TIER_MAP[agentName];
    return typeof t === 'number' ? t : 3;
  }

  // 'exiting:done' -> 'exiting-done'; pass through known states; default to
  // 'dispatching' so a node always carries exactly one state class.
  function stateClass(state) {
    if (state === 'exiting:done' || state === 'exiting-done') return 'exiting-done';
    if (state === 'exiting:errored' || state === 'exiting-errored') return 'exiting-errored';
    if (state === 'working') return 'working';
    return 'dispatching';
  }

  function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // Label: "<agent>\n<truncated [STEP]>" — or "<agent>\n<state>" when no step.
  // Never renders the literal "undefined".
  function nodeLabel(entry) {
    var agent = (entry && entry.agent) || (entry && entry.nodeId) || 'agent';
    var step = entry && entry.step;
    if (typeof step === 'string' && step.length) {
      return agent + '\n' + truncate(step, LABEL_STEP_MAX);
    }
    var state = (entry && entry.state) ? String(entry.state) : '';
    return state ? agent + '\n' + state : agent;
  }

  // Deterministic per-node phase jitter — stable hash from the node id string
  // so the swarm shimmers organically rather than blinking in unison (§4.2).
  function hashCode(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) & 0xffffffff;
    }
    return h < 0 ? -h : h;
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Cytoscape — node / edge sync + concentric layout
   * ────────────────────────────────────────────────────────────────────── */

  function initCytoscape() {
    cy = cytoscape({
      container: els.cy,
      style: window.GLIMPSE_CYTO_STYLE,
      layout: { name: 'preset' },
      wheelSensitivity: 0.2,
      elements: [],
    });

    // Click a node → minimal detail tooltip. Hub has no live entry.
    cy.on('tap', 'node', function (evt) {
      showTooltip(evt.target);
    });
    // Tap empty canvas → dismiss tooltip.
    cy.on('tap', function (evt) {
      if (evt.target === cy) hideTooltip();
    });

    startPulseLoop(); // §4.2/§4.3 — runs continuously once the graph is ready
  }

  // The synthetic hub exists only while referenced as an edge source.
  function ensureHubNode() {
    if (!cy) return;
    if (cy.getElementById(HUB_ID).nonempty()) return;
    cy.add({
      group: 'nodes',
      data: { id: HUB_ID, label: HUB_ID, agent: HUB_ID, tier: 1 },
      classes: 'tier1 hub',
    });
  }

  function removeHubIfOrphan() {
    if (!cy) return;
    if (Object.keys(liveAgents).length === 0) {
      var hub = cy.getElementById(HUB_ID);
      if (hub.nonempty()) hub.remove();
    }
  }

  // Create or update a single live-agent node from its entry. Returns true when
  // the node was newly added (i.e. the node set changed → caller relayouts).
  function upsertNode(entry) {
    if (!cy || !entry || !entry.nodeId) return false;
    var id = entry.nodeId;
    var tier = getTier(entry.agent);
    var ele = cy.getElementById(id);
    var added = false;

    if (ele.empty()) {
      cy.add({
        group: 'nodes',
        data: {
          id: id,
          label: nodeLabel(entry),
          agent: entry.agent || id,
          container: entry.containerName,
          createdAt: entry.createdAt,
          step: entry.step,
          state: entry.state,
          exitCode: entry.exitCode,
          tier: tier,
        },
      });
      ele = cy.getElementById(id);
      added = true;
    } else {
      ele.data('label', nodeLabel(entry));
      ele.data('step', entry.step);
      ele.data('state', entry.state);
      ele.data('exitCode', entry.exitCode);
      ele.data('container', entry.containerName);
      ele.data('createdAt', entry.createdAt);
    }

    // Exactly one tier class.
    TIER_CLASSES.forEach(function (c) { ele.removeClass(c); });
    ele.addClass('tier' + tier);

    // Exactly one live-state class (only if not in an exit animation).
    if (!ele.hasClass('node-exiting')) {
      STATE_CLASSES.forEach(function (c) { ele.removeClass(c); });
      ele.addClass(stateClass(entry.state));
    }

    return added;
  }

  function removeNode(nodeId) {
    if (!cy) return;
    var ele = cy.getElementById(nodeId);
    if (ele.nonempty()) ele.remove(); // also drops connected edges
  }

  // Replace the entire edge set to match the authoritative payload (§3.2: hub →
  // each live agent, inferred + dashed). Endpoints must already exist as nodes.
  function setEdges(nextEdges) {
    if (!cy) return;
    edges = Array.isArray(nextEdges) ? nextEdges.slice() : [];
    cy.edges().remove();
    if (edges.length === 0) return;
    ensureHubNode();
    edges.forEach(function (e) {
      if (!e || !e.source || !e.target) return;
      if (cy.getElementById(e.source).empty()) return;
      if (cy.getElementById(e.target).empty()) return;
      var id = e.id || (e.source + '->' + e.target);
      if (cy.getElementById(id).nonempty()) return;
      cy.add({
        group: 'edges',
        data: { id: id, source: e.source, target: e.target },
        classes: 'dispatch', // inferred dispatch spoke (dashed, per stylesheet)
      });
    });
  }

  // Optimistic hub + single spoke for a freshly-entered agent, so the node is
  // wired even before the authoritative edge:update lands.
  function ensureSpoke(targetId) {
    if (!cy) return;
    ensureHubNode();
    var id = HUB_ID + '->' + targetId;
    if (cy.getElementById(id).nonempty()) return;
    if (cy.getElementById(targetId).empty()) return;
    cy.add({
      group: 'edges',
      data: { id: id, source: HUB_ID, target: targetId },
      classes: 'dispatch',
    });
  }

  function scheduleLayout() {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(function () {
      layoutTimer = null;
      runLayout();
    }, RELAYOUT_DEBOUNCE_MS);
  }

  // Built-in concentric layout (no dagre): hub / tier-1 at the center, higher
  // tiers fan outward. concentric() returns a higher value for more-central
  // nodes, so we invert tier (tier1 → 3, tier3 → 1).
  function runLayout() {
    if (!cy || cy.nodes().length === 0) return;
    try {
      cy.layout({
        name: 'concentric',
        concentric: function (node) { return 4 - (node.data('tier') || 3); },
        levelWidth: function () { return 1; },
        minNodeSpacing: 42,
        animate: true,
        animationDuration: LAYOUT_ANIM_MS,
        fit: true,
        padding: 48,
      }).run();
    } catch (e) {
      // Layout must never break the live feed.
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Animation — rAF pulse loop, entrance / exit flourishes (§4)
   * ────────────────────────────────────────────────────────────────────── */

  // Single shared rAF loop: working-node breathing pulse + marching-ants edge
  // flow. Nodes tagged .node-entering or .node-exiting are skipped (they have
  // their own one-shot animations running). (§4.2, §4.3)
  function pulseFrame(ts) {
    rafId = requestAnimationFrame(pulseFrame);
    if (!cy) return;

    // ── §4.2 Working pulse — vivid, dominant ─────────────────────────────
    cy.nodes('.working:not(.node-entering):not(.node-exiting)').forEach(function (node) {
      var phase = (hashCode(node.id()) % 1000) / 1000;
      var sin = 0.5 + 0.5 * Math.sin(((ts / PULSE_PERIOD_MS) + phase) * 2 * Math.PI);
      var tier = node.data('tier') || 3;
      var bwMin = tier === 1 ? 3 : 2;
      var bwMax = tier === 1 ? 10 : (tier === 2 ? 7 : 5);
      var ovMax = tier === 1 ? 0.42 : (tier === 2 ? 0.30 : 0.20);
      node.style({
        'border-width':    bwMin + sin * (bwMax - bwMin),
        'overlay-opacity': 0.05 + sin * (ovMax - 0.05),
        'overlay-color':   '#4caf50',
      });
    });

    // ── §4.2 Dispatching: slower, dimmer fade (transient, usually < 1 s) ──
    cy.nodes('.dispatching:not(.node-entering):not(.node-exiting)').forEach(function (node) {
      var phase = (hashCode(node.id()) % 1000) / 1000;
      var sin = 0.5 + 0.5 * Math.sin(((ts / (PULSE_PERIOD_MS * 1.8)) + phase) * 2 * Math.PI);
      node.style({
        'border-width':    1.5 + sin * 1.5,
        'overlay-opacity': 0.01 + sin * 0.07,
        'overlay-color':   '#2196f3',
      });
    });

    // ── §4.3 Edge flow — marching-ants on spokes to working targets ──────
    cy.edges('.dispatch').forEach(function (edge) {
      var targetId = edge.data('target');
      var target = cy.getElementById(targetId);
      var flowing = target.nonempty() &&
                    target.hasClass('working') &&
                    !target.hasClass('node-exiting');
      if (flowing) {
        edge.style({
          'line-dash-offset':   -((ts * EDGE_FLOW_SPEED) % 20),
          'opacity':             0.85,
          'line-color':          '#4caf50',
          'target-arrow-color':  '#4caf50',
          'width':               2,
        });
        if (!edge.hasClass('active')) edge.addClass('active');
      } else if (edge.hasClass('active')) {
        edge.removeClass('active');
        edge.style({
          'line-dash-offset':    0,
          'opacity':             0.45,
          'line-color':          '#2196f3',
          'target-arrow-color':  '#2196f3',
          'width':               1.5,
        });
      }
    });
  }

  // Start the shared rAF loop once; never restarted (runs until page unload).
  function startPulseLoop() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(pulseFrame);
  }

  // §4.1 — new node scales/fades in from near-zero, then emits a one-shot ripple.
  function animateNodeEntrance(ele) {
    if (!ele || ele.empty()) return;
    var tier = ele.data('tier') || 3;
    var targetW = tier === 1 ? 64 : (tier === 2 ? 44 : 28);

    ele.addClass('node-entering');
    ele.style({
      'opacity': 0,
      'width':   targetW * 0.2,
      'height':  targetW * 0.2,
      'overlay-opacity': 0,
    });

    // Scale + fade in over 450 ms
    ele.animate({
      style: { 'opacity': 1, 'width': targetW, 'height': targetW },
      duration: 450,
      easing: 'ease-out',
      complete: function () {
        ele.removeClass('node-entering');
        // One-shot ripple: overlay flashes then fades
        ele.animate({
          style: { 'overlay-opacity': 0.50, 'overlay-color': '#4caf50' },
          duration: 180,
          easing: 'ease-out',
          complete: function () {
            ele.animate({
              style: { 'overlay-opacity': 0 },
              duration: 320,
              easing: 'ease-in',
            });
          },
        });
      },
    });

    // Spoke fades in alongside the node (starts invisible)
    var spoke = cy.getElementById(HUB_ID + '->' + ele.id());
    if (spoke.nonempty()) {
      spoke.style({ 'opacity': 0 });
      spoke.animate({ style: { 'opacity': 0.45 }, duration: 450, easing: 'ease-out' });
    }
  }

  // §4.4 — exit: terminal flash → scale-down + fade → linger → hard remove.
  // Timing: ~300 ms flash + ~600 ms scale = ~900 ms; linger to ~2.5 s total.
  function animateNodeExit(nodeId, exitCode) {
    if (!cy) { scheduleLayout(); return; }
    var ele = cy.getElementById(nodeId);
    if (ele.empty()) { removeHubIfOrphan(); scheduleLayout(); return; }

    var isError = typeof exitCode === 'number' && exitCode !== 0;
    var flashColor = isError ? '#f44336' : '#00e676';
    // After 300 ms flash + 600 ms scale = 900 ms elapsed; wait lingerAfterScale
    // more ms before final removal so total from exit ≈ 2.5 s (clean) / 3 s (err).
    var lingerAfterScaleMs = isError ? 2100 : 1600;

    // Tag as exiting so the pulse loop leaves it alone; set terminal state class.
    ele.addClass('node-exiting');
    STATE_CLASSES.forEach(function (c) { ele.removeClass(c); });
    ele.addClass(isError ? 'exiting-errored' : 'exiting-done');

    // Stop spoke flow immediately; tint it to match the terminal colour.
    var spoke = cy.getElementById(HUB_ID + '->' + nodeId);
    if (spoke.nonempty()) {
      if (spoke.hasClass('active')) spoke.removeClass('active');
      spoke.style({
        'line-dash-offset':   0,
        'opacity':            0.30,
        'line-color':         flashColor,
        'target-arrow-color': flashColor,
        'width':              1.5,
      });
    }

    // 1. Terminal flash — bright overlay pulse ~300 ms.
    ele.style({ 'overlay-color': flashColor, 'overlay-opacity': 0 });
    ele.animate({
      style: { 'overlay-opacity': 0.70 },
      duration: 150,
      easing: 'ease-out',
      complete: function () {
        ele.animate({
          style: { 'overlay-opacity': 0 },
          duration: 150,
          easing: 'ease-in',
          complete: function () {
            // 2. Scale-down + fade ~600 ms.
            var tier = ele.data('tier') || 3;
            var baseW = tier === 1 ? 64 : (tier === 2 ? 44 : 28);
            ele.animate({
              style: { 'opacity': 0, 'width': baseW * 0.25, 'height': baseW * 0.25 },
              duration: 600,
              easing: 'ease-in',
              complete: function () {
                // Spoke retracts toward hub as node fades.
                if (spoke && spoke.nonempty()) {
                  spoke.animate({ style: { 'opacity': 0 }, duration: 400 });
                }
                // 3. Linger, then hard-remove.
                setTimeout(function () {
                  var n = cy.getElementById(nodeId);
                  if (n.nonempty()) n.remove();
                  var s = cy.getElementById(HUB_ID + '->' + nodeId);
                  if (s.nonempty()) s.remove();
                  removeHubIfOrphan();
                  scheduleLayout();
                }, lingerAfterScaleMs);
              },
            });
          },
        });
      },
    });
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Node detail tooltip (minimal, lightweight)
   * ────────────────────────────────────────────────────────────────────── */

  function showTooltip(node) {
    if (!els.tooltip) return;
    var id = node.id();
    var entry = liveAgents[id];

    if (els.tooltipAgent) {
      els.tooltipAgent.textContent = (entry && entry.agent) || id;
    }
    if (els.tooltipMeta) {
      els.tooltipMeta.textContent = '';
      if (entry) {
        addMetaRow('Container', entry.containerName);
        addMetaRow('Dispatched', entry.createdAt);
        addMetaRow('Step', entry.step);
        addMetaRow('State', entry.state);
        if (entry.state === 'exiting:done' || entry.state === 'exiting:errored' ||
            typeof entry.exitCode === 'number') {
          addMetaRow('Exit code',
            (typeof entry.exitCode === 'number') ? String(entry.exitCode) : '—');
        }
      } else if (id === HUB_ID) {
        addMetaRow('Role', 'orchestrator hub (synthetic)');
      }
    }

    // Position near the tapped node within the full-bleed canvas.
    var pos = node.renderedPosition();
    if (pos) {
      els.tooltip.style.left = Math.round(pos.x + 16) + 'px';
      els.tooltip.style.top = Math.round(pos.y + 16) + 'px';
    }
    els.tooltip.classList.remove('hidden');
  }

  function addMetaRow(key, value) {
    if (value == null || value === '') return;
    var row = document.createElement('div');
    row.className = 'tooltip-row';
    var k = document.createElement('span');
    k.className = 'tooltip-key';
    k.textContent = key;
    var v = document.createElement('span');
    v.className = 'tooltip-val';
    v.textContent = String(value);
    row.appendChild(k);
    row.appendChild(v);
    els.tooltipMeta.appendChild(row);
  }

  function hideTooltip() {
    if (els.tooltip) els.tooltip.classList.add('hidden');
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Badges
   * ────────────────────────────────────────────────────────────────────── */

  function setConnBadge(stateClassName, label) {
    if (!els.connBadge) return;
    ['connected', 'reconnecting', 'disconnected'].forEach(function (c) {
      els.connBadge.classList.remove(c);
    });
    els.connBadge.classList.add(stateClassName);
    var labelEl = els.connBadge.querySelector('.connection-label');
    if (labelEl) labelEl.textContent = label;
  }

  function setDockerBadge(available) {
    if (!els.dockerBadge) return;
    ['docker-connected', 'docker-unavailable', 'docker-unknown'].forEach(function (c) {
      els.dockerBadge.classList.remove(c);
    });
    var labelEl = els.dockerBadge.querySelector('.connection-label');
    if (available === true) {
      els.dockerBadge.classList.add('docker-connected');
      if (labelEl) labelEl.textContent = 'Docker connected';
    } else if (available === false) {
      els.dockerBadge.classList.add('docker-unavailable');
      if (labelEl) labelEl.textContent = 'Docker unavailable — inferred from logs';
    } else {
      els.dockerBadge.classList.add('docker-unknown');
      if (labelEl) labelEl.textContent = 'Docker…';
    }
  }

  // Any message may carry the current Docker availability; reflect it whenever
  // present.
  function trackDocker(payload) {
    if (payload && typeof payload.dockerAvailable === 'boolean') {
      dockerAvailable = payload.dockerAvailable;
      setDockerBadge(dockerAvailable);
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Snapshot + patch reconciliation
   * ────────────────────────────────────────────────────────────────────── */

  function applySnapshot(state) {
    state = state || {};
    liveAgents = {};
    edges = [];
    if (cy) cy.elements().remove();
    hideTooltip();

    dockerAvailable = (typeof state.dockerAvailable === 'boolean')
      ? state.dockerAvailable : undefined;
    setDockerBadge(dockerAvailable);

    var la = state.liveAgents || {};
    Object.keys(la).forEach(function (id) {
      var entry = la[id];
      if (!entry || !entry.nodeId) return;
      liveAgents[entry.nodeId] = entry;
      upsertNode(entry);
    });

    if (Array.isArray(state.edges)) setEdges(state.edges);

    if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null; }
    runLayout();
  }

  function onAgentEnter(p) {
    if (!p || !p.nodeId) return;
    liveAgents[p.nodeId] = Object.assign({}, liveAgents[p.nodeId], p);
    var added = upsertNode(liveAgents[p.nodeId]);
    ensureSpoke(p.nodeId); // optimistic hub + spoke until edge:update confirms
    if (added) {
      animateNodeEntrance(cy.getElementById(p.nodeId)); // §4.1
    }
    scheduleLayout();
  }

  function onAgentUpdate(p) {
    if (!p || !p.nodeId) return;
    var existing = liveAgents[p.nodeId];
    if (!existing) return; // updates for unknown nodes are ignored (matches state.js)
    liveAgents[p.nodeId] = Object.assign({}, existing, p);
    upsertNode(liveAgents[p.nodeId]); // refresh state class + live step label, no relayout
  }

  function onAgentExit(p) {
    if (!p || !p.nodeId) return;
    var exitCode = (p && typeof p.exitCode === 'number') ? p.exitCode : undefined;
    delete liveAgents[p.nodeId]; // remove from live set immediately
    animateNodeExit(p.nodeId, exitCode); // §4.4 — node removal is deferred ~2.5 s
    // scheduleLayout() is called inside animateNodeExit after the linger window
  }

  function onEdgeUpdate(p) {
    if (!p) return;
    if (Array.isArray(p.edges)) setEdges(p.edges);
    if (Object.keys(liveAgents).length === 0) removeHubIfOrphan();
    scheduleLayout();
  }

  function applyPatch(event, payload) {
    payload = payload || {};
    trackDocker(payload);
    switch (event) {
      case 'agent:enter':  onAgentEnter(payload);  break;
      case 'agent:update': onAgentUpdate(payload); break;
      case 'agent:exit':   onAgentExit(payload);   break;
      case 'edge:update':  onEdgeUpdate(payload);  break;
      default: break;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * WebSocket client with exponential-backoff reconnect.
   * ────────────────────────────────────────────────────────────────────── */

  var ws = null;
  var backoff = 500;
  var BACKOFF_MAX = 10000;

  function connect() {
    try {
      ws = new WebSocket('ws://' + location.host);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      backoff = 500;
      setConnBadge('connected', 'Connected');
    };

    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'snapshot') {
          applySnapshot(msg.state); // rebuild from the fresh snapshot on (re)connect
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
      setConnBadge('reconnecting', 'Reconnecting…');
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
   * Toolbar + tooltip wiring, then boot.
   * ────────────────────────────────────────────────────────────────────── */

  function wireToolbar() {
    if (els.btnFit) {
      els.btnFit.addEventListener('click', function () { if (cy) cy.fit(undefined, 48); });
    }
    if (els.btnZoomIn) {
      els.btnZoomIn.addEventListener('click', function () {
        if (!cy) return;
        cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      });
    }
    if (els.btnZoomOut) {
      els.btnZoomOut.addEventListener('click', function () {
        if (!cy) return;
        cy.zoom({ level: cy.zoom() * 0.8, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      });
    }
  }

  function wireTooltip() {
    if (els.tooltipClose) els.tooltipClose.addEventListener('click', hideTooltip);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideTooltip();
    });
  }

  function init() {
    initCytoscape();
    wireToolbar();
    wireTooltip();
    setConnBadge('disconnected', 'Connecting…');
    setDockerBadge(undefined);
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
