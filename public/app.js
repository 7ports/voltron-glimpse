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
  var HUB_PULSE_PERIOD_MS = 2200; // §3.4: hub active breathing — slower/distinct from working nodes

  // §3.5 dispatch flash — one-shot bright burst along a hub→agent spoke when the
  // orchestrator just launched that agent. Cyan to read as "the hub did this",
  // distinct from the green working flow and the blue resting dispatch dash.
  var DISPATCH_FLASH_MS = 1000;
  var DISPATCH_FLASH_COLOR = '#00e5ff';
  var DISPATCH_DASH_COLOR = '#2196f3';

  /* ──────────────────────────────────────────────────────────────────────
   * Pod tracking — deterministic hue, registry, legend
   * ────────────────────────────────────────────────────────────────────── */

  var podRegistry = {}; // podKey → { label, isSelf, hue }

  // Multi-pod state — derived from podRegistry when >= 2 distinct pods are live.
  var multiPodMode = false; // true when 2+ pods visible; drives compound-parent rendering
  var selfPodId = null;     // podKey whose selfPod===true (the CLI's own project)
  var selfPodLabel = null;  // basename for the self-pod status badge

  // Palette of HSL hues for non-self pods. Chosen to avoid:
  //   green (working, ~100-160), red (errored, ~340-20), cyan/blue (hub/dispatch, ~175-215).
  var POD_HUE_PALETTE = [270, 300, 30, 240, 320, 60, 15, 195];

  // Returns a deterministic hue for a podKey. Self pod = gold (45). Unknown = null.
  function podHue(podKey) {
    if (!podKey || podKey === 'unknown') return null;
    var reg = podRegistry[podKey];
    if (reg && reg.hue != null) return reg.hue;
    // Self pod is registered before this is called for it, so fall through to palette.
    return POD_HUE_PALETTE[hashCode(podKey) % POD_HUE_PALETTE.length];
  }

  // HSLA border-color for the pod accent ring on nodes (secondary signal; status
  // fill is unchanged). 'unknown' pods get a neutral grey.
  function podAccentColor(podKey) {
    var reg = podRegistry[podKey];
    var hue = (reg && reg.hue != null) ? reg.hue : podHue(podKey);
    if (hue === null) return 'rgba(136,153,170,0.55)';
    return 'hsla(' + hue + ',65%,62%,0.90)';
  }

  // Solid HSL string for legend swatches.
  function podSwatchColor(podKey) {
    var reg = podRegistry[podKey];
    var hue = (reg && reg.hue != null) ? reg.hue : podHue(podKey);
    if (hue === null) return '#8899aa';
    return 'hsl(' + hue + ',65%,62%)';
  }

  // Register or update a pod entry. Called from upsertNode and applySnapshot.
  function registerPod(podKey, podLabel, isSelf) {
    if (!podKey) return;
    var selfFlag = !!isSelf;
    if (!podRegistry[podKey]) {
      // Self pod always gets gold (45) to be immediately distinguishable.
      var hue = selfFlag ? 45 : podHue(podKey);
      podRegistry[podKey] = { label: podLabel || podKey, isSelf: selfFlag, hue: hue };
    } else {
      if (podLabel) podRegistry[podKey].label = podLabel;
      if (selfFlag && !podRegistry[podKey].isSelf) {
        podRegistry[podKey].isSelf = true;
        podRegistry[podKey].hue = 45; // retroactively apply gold hue
      }
    }
    if (selfFlag && !selfPodId) {
      selfPodId = podKey;
      selfPodLabel = podLabel || podKey;
    }
    recomputeMultiPodMode();
  }

  // Recompute multiPodMode from podRegistry. Called automatically by registerPod.
  // When the mode first transitions false→true mid-session, existing nodes are
  // retroactively grouped into compound parents via a clean graph rebuild.
  function recomputeMultiPodMode() {
    var wasMulti = multiPodMode;
    multiPodMode = Object.keys(podRegistry).length > 1;
    // Guard: only retrofit when there are actual nodes in the graph (not during a
    // snapshot rebuild where cy.elements().remove() already cleared the canvas).
    if (!wasMulti && multiPodMode && cy && cy.nodes().length > 0) {
      retrofitCompoundParents();
    }
  }

  // When a second pod appears mid-session, rebuild the Cytoscape graph so all
  // existing agent nodes get compound parents. Clears and repopulates from the
  // in-memory liveAgents + edges arrays, which already reflect current state.
  function retrofitCompoundParents() {
    if (!cy) return;
    cy.elements().remove();
    Object.keys(podRegistry).forEach(function (podKey) { ensureCompoundParent(podKey); });
    ensureHubNode();
    Object.keys(liveAgents).forEach(function (id) {
      var entry = liveAgents[id];
      if (entry) upsertNode(entry);
    });
    setEdges(edges);
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Pod structural helpers — hub id namespacing, compound parents
   * ────────────────────────────────────────────────────────────────────── */

  // In multi-pod mode the hub id is namespaced per pod to avoid a single hub
  // falsely implying one orchestrator dispatched all pods' containers.
  function hubIdForPod(podKey) {
    return multiPodMode ? (HUB_ID + '@' + (podKey || 'unknown')) : HUB_ID;
  }

  // Look up the pod-specific hub id for a live agent node.
  function hubIdForNode(nodeId) {
    var entry = liveAgents[nodeId];
    var podKey = entry && (entry.podKey || null);
    return hubIdForPod(podKey);
  }

  // Stable compound-parent node id for a pod. Prefix `pod::` avoids clashes.
  function compoundParentId(podKey) {
    return 'pod::' + (podKey || 'unknown');
  }

  // Ensure a Cytoscape compound-parent node for a pod exists (multi-pod only).
  // The solid boundary signals real mount-source attribution (not inferred).
  function ensureCompoundParent(podKey) {
    if (!cy || !multiPodMode) return;
    var pid = compoundParentId(podKey);
    if (cy.getElementById(pid).nonempty()) return;
    var reg = podRegistry[podKey] || { label: podKey || 'unknown', isSelf: false, hue: null };
    var hue = reg.hue != null ? reg.hue : podHue(podKey);
    var selfMarker = reg.isSelf ? ' ● you' : '';
    var bgColor = hue != null
      ? 'hsla(' + hue + ',38%,16%,0.36)'
      : 'rgba(136,153,170,0.08)';
    var borderColor = hue != null
      ? 'hsla(' + hue + ',50%,48%,0.55)'
      : 'rgba(136,153,170,0.35)';
    cy.add({
      group: 'nodes',
      data: { id: pid, label: (reg.label || podKey || 'unknown') + selfMarker, podKey: podKey },
      classes: 'pod-parent' + (reg.isSelf ? ' pod-self' : ''),
      style: {
        'background-color': bgColor,
        'border-color':     borderColor,
      },
    });
  }

  // Ensure the hub node for a specific pod (or the global hub in single-pod mode).
  function ensureHubNodeForPod(podKey) {
    if (!cy) return;
    var hid = hubIdForPod(podKey);
    if (cy.getElementById(hid).nonempty()) return;
    var reg = (podKey && podRegistry[podKey]) ? podRegistry[podKey] : {};
    var hue = reg.hue != null ? reg.hue : (podKey ? podHue(podKey) : null);
    // In multi-pod, include the pod label so users can tell hubs apart.
    var label = (multiPodMode && reg.label)
      ? HUB_ID + '\n' + reg.label
      : hubLabel(hubState);
    var nodeData = { id: hid, label: label, agent: HUB_ID, tier: 1, podKey: podKey };
    if (multiPodMode && podKey) {
      ensureCompoundParent(podKey);
      nodeData.parent = compoundParentId(podKey);
    }
    cy.add({ group: 'nodes', data: nodeData, classes: 'tier1 hub' });
    // Apply pod-hue accent as a secondary border tint (doesn't override hub fill for self pod).
    if (hue != null) {
      var hubEle = cy.getElementById(hid);
      if (hubEle.nonempty()) {
        if (reg.isSelf) {
          hubEle.style({ 'border-color': 'hsla(' + hue + ',80%,55%,0.85)' });
        } else {
          hubEle.style({
            'background-color': 'hsla(' + hue + ',55%,38%,1)',
            'border-color':     'hsla(' + hue + ',65%,52%,0.80)',
          });
        }
      }
    }
  }

  // Returns all pods (including 'unknown') that have at least one currently live agent.
  function getLivePods() {
    var seen = {};
    Object.keys(liveAgents).forEach(function (id) {
      var e = liveAgents[id];
      var key = (e && e.podKey) || 'unknown';
      if (!seen[key]) {
        var reg = podRegistry[key] || {};
        seen[key] = {
          label:  reg.label || (e && e.podLabel) || key,
          isSelf: !!(reg.isSelf || (e && e.selfPod)),
          hue:    (reg.hue != null) ? reg.hue : podHue(key),
        };
      }
    });
    return seen;
  }

  // Rebuild the pod legend section inside .legend.
  // Hidden when fewer than 2 named pods are live (keeps single-pod view clean).
  function updatePodLegend() {
    var legendEl = document.querySelector('.legend');
    if (!legendEl) return;

    var livePods = getLivePods();
    var keys = Object.keys(livePods);

    var section = document.getElementById('pod-legend-section');
    if (!section) {
      section = document.createElement('div');
      section.id = 'pod-legend-section';
      section.className = 'legend-section pod-legend-section';
      legendEl.appendChild(section);
    }

    if (keys.length < 2) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    section.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'legend-title';
    title.textContent = 'Pods';
    section.appendChild(title);

    keys.forEach(function (key) {
      var pod = livePods[key];
      var row = document.createElement('div');
      row.className = 'legend-row pod-legend-row';

      var swatch = document.createElement('span');
      swatch.className = 'pod-swatch';
      swatch.style.background = podSwatchColor(key);
      swatch.setAttribute('aria-hidden', 'true');
      row.appendChild(swatch);

      var labelSpan = document.createElement('span');
      labelSpan.className = 'pod-legend-label';
      labelSpan.textContent = pod.label || key;
      row.appendChild(labelSpan);

      if (pod.isSelf) {
        var badge = document.createElement('span');
        badge.className = 'pod-you-badge';
        badge.textContent = 'you';
        badge.setAttribute('aria-label', 'this project');
        row.appendChild(badge);
      }

      section.appendChild(row);
    });
  }

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
  var hubState = null;   // hub payload from backend: { id, state:'active'|'idle', label, kind, … } or null
  var pinnedNodeId = null; // nodeId of the click-pinned detail panel; null when closed

  // Progress block — live elapsed-clock machinery (design §3.2). The interval is
  // (re)bound on every panel render and cleared on close/re-pin so no timer leaks.
  var elapsedTimer = null;        // setInterval handle for the 1 s elapsed clock
  var panelElapsedEl = null;      // current elapsed <span>, re-acquired each render
  var panelElapsedStartMs = null; // epoch ms the elapsed clock counts up from
  var panelExitFrozenMs = null;   // frozen final elapsed (ms), captured once on exit
  var exitedEntries = {};         // nodeId -> terminal snapshot, so a pinned panel can
                                  // show the ✔/✘ chip after the live entry is dropped

  var cy = null;
  var layoutTimer = null;
  var rafId = null;      // requestAnimationFrame handle for the pulse loop
  var prevRafTs = 0;     // last rAF timestamp — delta-time for smooth edge flow
  var edgeFlowAccum = 0; // accumulated marching-ants dash-offset (px)

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

  // Hub label: optional emoji prefix + truncated journal text; fallback to 'scrum-master'.
  function hubLabel(hub) {
    if (!hub) return HUB_ID;
    var prefix = (typeof hub.emoji === 'string' && hub.emoji) ? hub.emoji + ' ' : '';
    var text = (typeof hub.label === 'string' && hub.label) ? hub.label : '';
    var full = (prefix + text).trim();
    return full.length > 0 ? truncate(full, 60) : HUB_ID;
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

    // Click a node → press feedback (scale dip + spring back) + tooltip.
    cy.on('tap', 'node', function (evt) {
      var node = evt.target;
      if (!node.hasClass('node-entering') && !node.hasClass('node-exiting')) {
        var tier = node.data('tier') || 3;
        var baseW = tier === 1 ? 64 : (tier === 2 ? 44 : 28);
        node.stop(true);
        node.animate({
          style: { 'width': baseW * 0.88, 'height': baseW * 0.88 },
          duration: 80,
          easing: 'ease-in',
          complete: function () {
            node.animate({
              style: { 'width': baseW * 1.06, 'height': baseW * 1.06 },
              duration: 130,
              easing: 'ease-out',
              complete: function () {
                node.animate({
                  style: { 'width': baseW, 'height': baseW },
                  duration: 120,
                  easing: 'ease-in-out',
                });
              },
            });
          },
        });
      }
      pinPanel(node.id());
    });
    // Tap empty canvas → dismiss the pinned panel.
    cy.on('tap', function (evt) {
      if (evt.target === cy) closePanel();
    });

    // Hover affordance — class drives subtle halo in the stylesheet
    cy.on('mouseover', 'node', function (evt) {
      evt.target.addClass('node-hovered');
    });
    cy.on('mouseout', 'node', function (evt) {
      evt.target.removeClass('node-hovered');
    });

    startPulseLoop(); // §4.2/§4.3 — runs continuously once the graph is ready
  }

  // The synthetic hub exists while edges reference it OR while the orchestrator is
  // journal-active (hubState non-null). Multi-pod mode creates one hub per pod.
  function ensureHubNode() {
    if (!cy) return;
    if (multiPodMode) {
      Object.keys(podRegistry).forEach(function (podKey) { ensureHubNodeForPod(podKey); });
    } else {
      ensureHubNodeForPod(null);
    }
  }

  function removeHubIfOrphan() {
    if (!cy) return;
    if (!multiPodMode) {
      if (hubState !== null || Object.keys(liveAgents).length > 0) return;
      var hub = cy.getElementById(HUB_ID);
      if (hub.nonempty()) hub.remove();
      return;
    }
    // Multi-pod: remove each pod's hub (and empty compound parent) independently.
    Object.keys(podRegistry).forEach(function (podKey) {
      var hid = hubIdForPod(podKey);
      var isSelfPod = (podKey === selfPodId);
      var hasLiveAgents = Object.keys(liveAgents).some(function (nid) {
        var e = liveAgents[nid];
        return e && (e.podKey === podKey || (!e.podKey && podKey === 'unknown'));
      });
      if (hasLiveAgents || (isSelfPod && hubState !== null)) return;
      var hubEle = cy.getElementById(hid);
      if (hubEle.nonempty()) hubEle.remove();
      var parentEle = cy.getElementById(compoundParentId(podKey));
      if (parentEle.nonempty() && parentEle.children().length === 0) parentEle.remove();
    });
  }

  // Create or update a single live-agent node from its entry. Returns true when
  // the node was newly added (i.e. the node set changed → caller relayouts).
  function upsertNode(entry) {
    if (!cy || !entry || !entry.nodeId) return false;
    var id = entry.nodeId;
    var tier = getTier(entry.agent);
    var ele = cy.getElementById(id);
    var added = false;

    // Pre-register the pod so multiPodMode + compound parents are ready before cy.add().
    if (entry.podKey) registerPod(entry.podKey, entry.podLabel, entry.selfPod);

    if (ele.empty()) {
      var podKey = entry.podKey || null;
      var nodeData = {
        id: id,
        label: nodeLabel(entry),
        agent: entry.agent || id,
        container: entry.containerName,
        createdAt: entry.createdAt,
        step: entry.step,
        state: entry.state,
        exitCode: entry.exitCode,
        tier: tier,
        podKey: podKey,
      };
      if (multiPodMode && podKey) {
        ensureCompoundParent(podKey);
        nodeData.parent = compoundParentId(podKey);
      }
      cy.add({ group: 'nodes', data: nodeData });
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

    // Pod accent — border ring in the pod's hue; status fill is unchanged.
    // (registerPod already called at top of upsertNode before cy.add())
    if (entry.podKey) {
      ele.data('podKey', entry.podKey);
      ele.style('border-color', podAccentColor(entry.podKey));
    }

    return added;
  }

  function removeNode(nodeId) {
    if (!cy) return;
    var ele = cy.getElementById(nodeId);
    if (ele.nonempty()) ele.remove(); // also drops connected edges
  }

  // Replace the entire edge set to match the authoritative payload (§3.2: hub →
  // each live agent, inferred + dashed). In multi-pod mode, remaps the global
  // scrum-master source to the pod-specific hub for each target agent.
  function setEdges(nextEdges) {
    if (!cy) return;
    edges = Array.isArray(nextEdges) ? nextEdges.slice() : [];
    cy.edges().remove();
    if (edges.length === 0) return;
    ensureHubNode();
    edges.forEach(function (e) {
      if (!e || !e.source || !e.target) return;
      var src = e.source;
      // Remap global hub to pod-specific hub in multi-pod mode.
      if (multiPodMode && src === HUB_ID) {
        var targetEntry = liveAgents[e.target];
        var targetPodKey = targetEntry && (targetEntry.podKey || null);
        src = hubIdForPod(targetPodKey);
        if (targetPodKey) ensureHubNodeForPod(targetPodKey);
      }
      if (cy.getElementById(src).empty()) return;
      if (cy.getElementById(e.target).empty()) return;
      var id = src + '->' + e.target;
      if (cy.getElementById(id).nonempty()) return;
      cy.add({
        group: 'edges',
        data: { id: id, source: src, target: e.target },
        classes: 'dispatch',
      });
    });
  }

  // Optimistic hub + single spoke for a freshly-entered agent, so the node is
  // wired even before the authoritative edge:update lands.
  function ensureSpoke(targetId) {
    if (!cy) return;
    var entry = liveAgents[targetId];
    var podKey = entry && (entry.podKey || null);
    var hid = hubIdForPod(podKey);
    if (multiPodMode && podKey) {
      ensureHubNodeForPod(podKey);
    } else {
      ensureHubNodeForPod(null);
    }
    var id = hid + '->' + targetId;
    if (cy.getElementById(id).nonempty()) return;
    if (cy.getElementById(targetId).empty()) return;
    cy.add({
      group: 'edges',
      data: { id: id, source: hid, target: targetId },
      classes: 'dispatch',
    });
  }

  // §3.5 — one-shot launch flash on the hub→agent spoke.
  function flashDispatchSpoke(targetId) {
    if (!cy) return;
    var hid = hubIdForNode(targetId);
    var spoke = cy.getElementById(hid + '->' + targetId);
    if (spoke.empty()) return;
    // Clear any queued/running spoke animation (e.g. the entrance fade) so the
    // flash plays immediately rather than after it.
    spoke.stop(true);
    spoke.addClass('dispatch-flash');
    spoke.style({
      'line-color':         DISPATCH_FLASH_COLOR,
      'target-arrow-color': DISPATCH_FLASH_COLOR,
      'opacity':            1,
      'width':              4,
      'line-dash-offset':   0,
    });
    spoke.animate({
      style: {
        'line-color':         DISPATCH_DASH_COLOR,
        'target-arrow-color': DISPATCH_DASH_COLOR,
        'opacity':            0.45,
        'width':              1.5,
        'line-dash-offset':   -60, // accelerated marching-ants sweep during decay
      },
      duration: DISPATCH_FLASH_MS,
      easing: 'ease-out',
      complete: function () {
        spoke.removeClass('dispatch-flash');
        // Drop the inline overrides so the stylesheet + rAF flow loop fully
        // own the spoke again.
        spoke.removeStyle('line-color target-arrow-color opacity width line-dash-offset');
      },
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
  // tiers fan outward. In multi-pod mode, run a separate concentric per pod
  // cluster positioned in a grid so pods occupy distinct screen regions.
  function runLayout() {
    if (!cy || cy.nodes().length === 0) return;
    try {
      if (!multiPodMode) {
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
      } else {
        // Per-pod concentric clusters arranged in a grid of non-overlapping regions.
        var podKeys = Object.keys(podRegistry);
        var cols = Math.max(1, Math.ceil(Math.sqrt(podKeys.length)));
        var groupSize = 360;
        var layoutsStarted = 0;
        podKeys.forEach(function (podKey, idx) {
          var pid = compoundParentId(podKey);
          var parent = cy.getElementById(pid);
          if (parent.empty()) return;
          var children = parent.children();
          if (children.length === 0) return;
          var col = idx % cols;
          var row = Math.floor(idx / cols);
          layoutsStarted++;
          children.layout({
            name: 'concentric',
            concentric: function (node) { return 4 - (node.data('tier') || 3); },
            levelWidth: function () { return 1; },
            minNodeSpacing: 32,
            animate: true,
            animationDuration: LAYOUT_ANIM_MS,
            fit: false,
            padding: 20,
            boundingBox: {
              x1: col * groupSize,
              y1: row * groupSize,
              w: groupSize - 30,
              h: groupSize - 30,
            },
          }).run();
        });
        if (layoutsStarted > 0) {
          setTimeout(function () {
            try { cy.fit(undefined, 80); } catch (e) { /* never break the feed */ }
          }, LAYOUT_ANIM_MS + 60);
        }
      }
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
    if (!cy) { prevRafTs = ts; return; }
    // Clamp delta to 100 ms so a tab-unhide pause can't jump the marching-ants.
    var delta = prevRafTs > 0 ? Math.min(ts - prevRafTs, 100) : 16;
    prevRafTs = ts;
    edgeFlowAccum = (edgeFlowAccum + delta * EDGE_FLOW_SPEED) % 20;

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
      // A spoke mid dispatch-flash (§3.5) owns its own one-shot animation; leave
      // it alone until the burst completes and the class is removed.
      if (edge.hasClass('dispatch-flash')) return;
      var targetId = edge.data('target');
      var target = cy.getElementById(targetId);
      var flowing = target.nonempty() &&
                    target.hasClass('working') &&
                    !target.hasClass('node-exiting');
      if (flowing) {
        edge.style({
          'line-dash-offset':   -edgeFlowAccum,
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

    // ── §3.4 Hub active pulse — slow cyan halo, distinct from working ─────
    cy.nodes('.hub.hub-active').forEach(function (node) {
      var sin = 0.5 + 0.5 * Math.sin((ts / HUB_PULSE_PERIOD_MS) * 2 * Math.PI);
      node.style({
        'border-width':    3 + sin * 6,
        'overlay-opacity': 0.04 + sin * 0.18,
        'overlay-color':   '#00e5ff',
      });
    });

    // ── Hub idle — reset pulse styles so they don't linger ───────────────
    cy.nodes('.hub.hub-idle').forEach(function (node) {
      node.style({ 'border-width': 2, 'overlay-opacity': 0 });
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

    // Scale + fade in: slight overshoot then settle (spring feel)
    ele.animate({
      style: { 'opacity': 1, 'width': targetW * 1.10, 'height': targetW * 1.10 },
      duration: 300,
      easing: 'ease-out',
      complete: function () {
        ele.animate({
          style: { 'width': targetW, 'height': targetW },
          duration: 200,
          easing: 'ease-in-out',
          complete: function () {
            ele.removeClass('node-entering');
            // One-shot ripple: overlay flashes then fades
            ele.animate({
              style: { 'overlay-opacity': 0.55, 'overlay-color': '#4caf50' },
              duration: 160,
              easing: 'ease-out',
              complete: function () {
                ele.animate({
                  style: { 'overlay-opacity': 0 },
                  duration: 380,
                  easing: 'ease-in',
                });
              },
            });
          },
        });
      },
    });

    // Spoke fades in alongside the node (pod-aware hub lookup).
    var nodePodKey = ele.data('podKey');
    var spoke = cy.getElementById(hubIdForPod(nodePodKey) + '->' + ele.id());
    if (spoke.nonempty()) {
      spoke.style({ 'opacity': 0 });
      spoke.animate({ style: { 'opacity': 0.45 }, duration: 500, easing: 'ease-in-out' });
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
    var exitPodKey = ele.data('podKey');
    var exitHubId = hubIdForPod(exitPodKey);
    var spoke = cy.getElementById(exitHubId + '->' + nodeId);
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
                  spoke.animate({ style: { 'opacity': 0 }, duration: 400, easing: 'ease-in' });
                }
                // 3. Linger, then hard-remove.
                setTimeout(function () {
                  var n = cy.getElementById(nodeId);
                  if (n.nonempty()) n.remove();
                  var s = cy.getElementById(exitHubId + '->' + nodeId);
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
   * Node detail panel — click-to-pin, live-updating (§3, §5 of
   * docs/agent-detail-panel-design.md). The panel binds to a nodeId and stays
   * open across snapshot/patch updates until dismissed (Esc / ✕ / empty canvas).
   * ────────────────────────────────────────────────────────────────────── */

  // Human-readable state label — last-resort "current task" fallback when no
  // journal dispatch text or step output exists (mirrors parsers/logs.js intent).
  function stateLabel(state) {
    if (state === 'working') return 'Agent running';
    if (state === 'exiting:done' || state === 'exiting-done') return 'Completed';
    if (state === 'exiting:errored' || state === 'exiting-errored') return 'Errored';
    return 'Container started, awaiting first output';
  }

  // Strip the "Dispatched <agent> to " prefix the scrum-master journal writes,
  // plus any wrapping quotes, leaving just the task description.
  function stripDispatchPrefix(text) {
    if (typeof text !== 'string') return '';
    var t = text.trim().replace(/^Dispatched\s+\S+\s+to\s+/i, '');
    return t.replace(/^["'"']+|["'"']+$/g, '').trim();
  }

  // Resolve the §3.1 current-task precedence chain. Returns { text, source }
  // where source ∈ 'dispatch' | 'done' | 'step' | 'state'. Only 'dispatch' is an
  // inferred (journal-correlated) source, so only it gets the honesty caption.
  function resolveCurrentTask(entry) {
    if (entry && typeof entry.dispatchTaskText === 'string' && entry.dispatchTaskText.trim()) {
      var stripped = stripDispatchPrefix(entry.dispatchTaskText);
      if (stripped) return { text: stripped, source: 'dispatch' };
    }
    if (entry && typeof entry.doneSummary === 'string' && entry.doneSummary.trim()) {
      return { text: entry.doneSummary.trim(), source: 'done' };
    }
    if (entry && typeof entry.step === 'string' && entry.step.trim()) {
      return { text: entry.step.trim(), source: 'step' };
    }
    return { text: stateLabel(entry && entry.state), source: 'state' };
  }

  // Build the "Current task" section: label + task text + optional honesty caption.
  function buildCurrentTaskSection(entry) {
    var section = document.createElement('div');
    section.className = 'panel-section current-task-section';

    var label = document.createElement('div');
    label.className = 'panel-section-label';
    label.textContent = 'Current task';
    section.appendChild(label);

    var task = resolveCurrentTask(entry);
    var body = document.createElement('div');
    body.className = 'current-task-text';
    body.textContent = task.text;
    section.appendChild(body);

    if (task.source === 'dispatch') {
      var caption = document.createElement('div');
      caption.className = 'current-task-caption';
      caption.textContent = 'inferred from journal';
      section.appendChild(caption);
    }
    return section;
  }

  // Parse a backend timestamp (execTs / createdAt) to epoch ms. Accepts a numeric
  // ms value, an all-digits string, or any Date-parseable string; null if unusable.
  function toEpochMs(ts) {
    if (ts == null) return null;
    if (typeof ts === 'number') return isFinite(ts) ? ts : null;
    if (typeof ts === 'string') {
      var s = ts.trim();
      if (s === '') return null;
      if (/^\d+$/.test(s)) { var n = Number(s); return isFinite(n) ? n : null; }
      var parsed = Date.parse(s);
      return isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  // mm:ss from a millisecond duration (negative clamps to 0). Minutes are not capped
  // at 99 — a long run simply keeps counting. This is a duration, never a ratio.
  function formatElapsed(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) ms = 0;
    var totalSec = Math.floor(ms / 1000);
    var mins = Math.floor(totalSec / 60);
    var secs = totalSec - mins * 60;
    var mm = mins < 10 ? '0' + mins : String(mins);
    var ss = secs < 10 ? '0' + secs : String(secs);
    return mm + ':' + ss;
  }

  // Step counter text (design §3.2): "Step 7" from the agent's own [STEP N];
  // else "N steps" from a raw count of unnumbered steps; else '' so the caller
  // OMITS it entirely (never "step 0").
  function stepCounterText(entry) {
    if (entry && typeof entry.stepNum === 'number' && entry.stepNum > 0) {
      return 'Step ' + entry.stepNum;
    }
    if (entry && typeof entry.stepCount === 'number' && entry.stepCount > 0) {
      return entry.stepCount === 1 ? '1 step' : entry.stepCount + ' steps';
    }
    return '';
  }

  // True for the two terminal states (colon or hyphen form).
  function isTerminalState(state) {
    return state === 'exiting:done' || state === 'exiting-done' ||
           state === 'exiting:errored' || state === 'exiting-errored';
  }

  // Build the "how far along" progress block (design §3.2): a status line (state +
  // step counter + live elapsed clock) over an INDETERMINATE activity bar while the
  // agent runs, replaced by a ✔/✘ outcome chip on exit. HONESTY (the no-fake-% rule):
  // it renders no percentage, ratio, N/M, or ETA — no honest total exists, so none
  // is shown; "progress" is activity + position + elapsed, never completion.
  function buildProgressSection(entry) {
    var section = document.createElement('div');
    section.className = 'panel-section progress-section';

    var terminal = isTerminalState(entry.state);
    var isError = (entry.state === 'exiting:errored' || entry.state === 'exiting-errored');

    // -- Status line: state chip + step counter + elapsed clock --
    var statusLine = document.createElement('div');
    statusLine.className = 'progress-status';
    statusLine.setAttribute('role', 'status');
    statusLine.setAttribute('aria-live', 'polite');

    var stateChip = document.createElement('span');
    stateChip.className = 'progress-state ' + stateClass(entry.state);
    stateChip.textContent = stateLabel(entry.state);
    statusLine.appendChild(stateChip);

    var stepText = stepCounterText(entry);
    if (stepText) {
      var stepEl = document.createElement('span');
      stepEl.className = 'progress-step';
      stepEl.textContent = stepText;
      statusLine.appendChild(stepEl);
    }

    // Live elapsed clock since [exec], falling back to container createdAt.
    var startMs = toEpochMs(entry.execTs);
    if (startMs == null) startMs = toEpochMs(entry.createdAt);
    if (startMs != null) {
      var clockEl = document.createElement('span');
      clockEl.className = 'progress-elapsed';
      var shownMs = (terminal && panelExitFrozenMs != null)
        ? panelExitFrozenMs
        : (Date.now() - startMs);
      clockEl.textContent = formatElapsed(shownMs);
      statusLine.appendChild(clockEl);
      panelElapsedEl = clockEl;          // ticked by setupElapsedClock()
      panelElapsedStartMs = startMs;
    } else {
      panelElapsedEl = null;
      panelElapsedStartMs = null;
    }
    section.appendChild(statusLine);

    // -- Activity indicator: indeterminate sweep, or terminal outcome chip --
    if (terminal) {
      var chip = document.createElement('div');
      chip.className = 'outcome-chip ' + (isError ? 'outcome-errored' : 'outcome-done');
      var mark = document.createElement('span');
      mark.className = 'outcome-mark';
      mark.textContent = isError ? '✘' : '✔';
      chip.appendChild(mark);
      var chipText = document.createElement('span');
      chipText.className = 'outcome-text';
      var code = (typeof entry.exitCode === 'number') ? ' (exit ' + entry.exitCode + ')' : '';
      chipText.textContent = (isError ? 'errored' : 'completed') + code;
      chip.appendChild(chipText);
      section.appendChild(chip);
    } else {
      var bar = document.createElement('div');
      bar.className = 'activity-bar' + (entry.state === 'dispatching' ? ' dispatching' : '');
      bar.setAttribute('aria-hidden', 'true'); // decorative; status line carries the signal
      var sweep = document.createElement('div');
      sweep.className = 'activity-bar-sweep';
      bar.appendChild(sweep);
      section.appendChild(bar);
    }

    return section;
  }

  // Build the "Recent activity" mini step-log (design §3.3): up to 5 recentSteps,
  // newest first, each truncated to one line with the full text on hover. Agents
  // that emit no steps show an honest empty-state caption (true for many).
  function buildRecentActivitySection(entry) {
    var section = document.createElement('div');
    section.className = 'panel-section recent-activity-section';

    var label = document.createElement('div');
    label.className = 'panel-section-label';
    label.textContent = 'Recent activity';
    section.appendChild(label);

    var steps = (entry && Array.isArray(entry.recentSteps)) ? entry.recentSteps : [];
    if (steps.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'recent-empty';
      empty.textContent = 'This agent reports no step output.';
      section.appendChild(empty);
      return section;
    }

    var list = document.createElement('ul');
    list.className = 'recent-step-list';
    steps.slice(0, 5).forEach(function (s) {
      var text = (s && typeof s.text === 'string') ? s.text
               : (typeof s === 'string' ? s : '');
      var num = (s && typeof s.stepNum === 'number') ? s.stepNum : null;

      var li = document.createElement('li');
      li.className = 'recent-step-row';
      li.title = (num != null ? num + ' ' : '') + text; // full text on hover

      if (num != null) {
        var numEl = document.createElement('span');
        numEl.className = 'recent-step-num';
        numEl.textContent = String(num);
        li.appendChild(numEl);
      }
      var textEl = document.createElement('span');
      textEl.className = 'recent-step-text';
      textEl.textContent = text;
      li.appendChild(textEl);

      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
  }

  // Clear the live elapsed-clock interval (idempotent; called before every re-bind
  // and on panel dismiss so no timer ever leaks).
  function clearElapsedClock() {
    if (elapsedTimer !== null) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  // (Re)bind the 1 s elapsed-clock interval to the freshly-rendered panel. For a
  // terminal agent it freezes the value (capturing the final elapsed once) and
  // starts no interval; for a live agent it ticks mm:ss every second.
  function setupElapsedClock(entry) {
    clearElapsedClock();
    if (!entry || panelElapsedEl == null || panelElapsedStartMs == null) return;
    if (isTerminalState(entry.state)) {
      if (panelExitFrozenMs == null) panelExitFrozenMs = Date.now() - panelElapsedStartMs;
      panelElapsedEl.textContent = formatElapsed(panelExitFrozenMs);
      return;
    }
    elapsedTimer = setInterval(function () {
      if (panelElapsedEl == null || panelElapsedStartMs == null) { clearElapsedClock(); return; }
      panelElapsedEl.textContent = formatElapsed(Date.now() - panelElapsedStartMs);
    }, 1000);
  }

  // Append a key/value pair directly into a 2-column .tooltip-meta grid.
  function appendMetaRow(grid, key, value) {
    if (value == null || value === '') return;
    var k = document.createElement('span');
    k.className = 'tooltip-key';
    k.textContent = key;
    var v = document.createElement('span');
    v.className = 'tooltip-val';
    v.textContent = String(value);
    grid.appendChild(k);
    grid.appendChild(v);
  }

  // Build the agent meta grid (container / dispatch time / step / state / exit).
  function buildAgentMeta(entry) {
    var grid = document.createElement('div');
    grid.className = 'tooltip-meta';
    appendMetaRow(grid, 'Container', entry.containerName);
    appendMetaRow(grid, 'Dispatched', entry.createdAt);
    appendMetaRow(grid, 'Step', entry.step);
    appendMetaRow(grid, 'State', entry.state);
    if (entry.state === 'exiting:done' || entry.state === 'exiting:errored' ||
        typeof entry.exitCode === 'number') {
      appendMetaRow(grid, 'Exit code',
        (typeof entry.exitCode === 'number') ? String(entry.exitCode) : '—');
    }
    return grid;
  }

  // Build the hub (orchestrator) meta grid — same content as the prior card.
  function buildHubMeta(node) {
    var grid = document.createElement('div');
    grid.className = 'tooltip-meta';
    appendMetaRow(grid, 'Role', 'orchestrator (host session, inferred)');
    var hubPodKey = node.data('podKey');
    if (hubPodKey && podRegistry[hubPodKey]) {
      var hreg = podRegistry[hubPodKey];
      appendMetaRow(grid, 'Pod', hreg.label + (hreg.isSelf ? ' (you)' : ''));
    }
    if (hubState && (!multiPodMode || !hubPodKey || hubPodKey === selfPodId)) {
      appendMetaRow(grid, 'Status', hubState.state || '—');
      if (hubState.label) appendMetaRow(grid, 'Activity', truncate(hubState.label, 80));
      if (hubState.kind) appendMetaRow(grid, 'Kind', hubState.kind);
    }
    return grid;
  }

  // Render (or re-render) the detail card for a nodeId. Safe to call repeatedly —
  // it rebuilds the body from current state. If the node is gone (post-linger) or
  // the agent entry has been dropped, it leaves the last render intact rather than
  // blanking the card (terminal-state handling is a later build step).
  function renderPanel(nodeId) {
    if (!els.tooltip || !nodeId) return;
    var node = cy && cy.getElementById(nodeId);
    if (!node || node.empty()) return;
    var entry = liveAgents[nodeId] || exitedEntries[nodeId];
    var isHub = (nodeId === HUB_ID || nodeId.indexOf(HUB_ID + '@') === 0);
    if (!entry && !isHub) return;

    if (els.tooltipAgent) {
      els.tooltipAgent.textContent = (entry && entry.agent) || (isHub ? HUB_ID : nodeId);
    }

    if (els.tooltipMeta) {
      els.tooltipMeta.innerHTML = '';
      if (entry) {
        els.tooltipMeta.appendChild(buildCurrentTaskSection(entry));
        els.tooltipMeta.appendChild(buildProgressSection(entry));
        els.tooltipMeta.appendChild(buildRecentActivitySection(entry));
        els.tooltipMeta.appendChild(buildAgentMeta(entry));
        setupElapsedClock(entry);
      } else if (isHub) {
        clearElapsedClock();
        panelElapsedEl = null;
        els.tooltipMeta.appendChild(buildHubMeta(node));
      }
    }

    // Position near the pinned node within the full-bleed canvas.
    var pos = node.renderedPosition();
    if (pos) {
      els.tooltip.style.left = Math.round(pos.x + 16) + 'px';
      els.tooltip.style.top = Math.round(pos.y + 16) + 'px';
    }
    els.tooltip.classList.remove('hidden');
  }

  // Pin the panel to a node (click). It stays open and live-updates until dismissed.
  function pinPanel(nodeId) {
    pinnedNodeId = nodeId;
    panelExitFrozenMs = null; // fresh pin target — recompute the freeze on its own exit
    exitedEntries = {};       // drop any retained terminal snapshot from a prior pin
    renderPanel(nodeId);
  }

  // Re-render the pinned panel only if the changed nodeId is the one on screen.
  function refreshPinnedPanel(nodeId) {
    if (pinnedNodeId && pinnedNodeId === nodeId) renderPanel(pinnedNodeId);
  }

  // Dismiss the panel and clear the pin.
  function closePanel() {
    pinnedNodeId = null;
    clearElapsedClock();      // no leaked elapsed-clock interval after dismiss
    panelExitFrozenMs = null;
    exitedEntries = {};
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

  // Create or update the self-pod badge next to the connection badges (P4).
  function setPodBadge(label) {
    var badgesEl = document.querySelector('.status-badges');
    if (!badgesEl) return;
    var badge = document.getElementById('pod-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'pod-badge';
      badge.className = 'connection-badge pod-badge';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      var dot = document.createElement('span');
      dot.className = 'connection-dot';
      badge.appendChild(dot);
      var lbl = document.createElement('span');
      lbl.className = 'connection-label';
      badge.appendChild(lbl);
      badgesEl.appendChild(badge);
    }
    var labelEl = badge.querySelector('.connection-label');
    if (label) {
      if (labelEl) labelEl.textContent = 'pod: ' + label;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
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
    podRegistry = {}; // full reset — snapshot is authoritative
    multiPodMode = false;
    if (cy) cy.elements().remove();

    dockerAvailable = (typeof state.dockerAvailable === 'boolean')
      ? state.dockerAvailable : undefined;
    setDockerBadge(dockerAvailable);

    // Set hubState first so ensureHubNode() uses the correct label when called by setEdges/ensureSpoke.
    hubState = (state.hub && state.hub.id) ? state.hub : null;

    // Pre-register ALL pods BEFORE creating any nodes so that multiPodMode is
    // correct and compound parents exist when the first cy.add() runs.
    // (1) Explicit pods map from backend:
    if (state.pods && typeof state.pods === 'object') {
      Object.keys(state.pods).forEach(function (key) {
        var p = state.pods[key];
        if (p) registerPod(key, p.label || p.podLabel, p.isSelf);
      });
    }
    // (2) Pods inferred from agent entries (covers snapshots without a pods map):
    var la = state.liveAgents || {};
    Object.keys(la).forEach(function (id) {
      var entry = la[id];
      if (entry && entry.podKey) registerPod(entry.podKey, entry.podLabel, entry.selfPod);
    });
    // Pre-create compound parents now that multiPodMode is definitive. The
    // cy.nodes().length guard in recomputeMultiPodMode prevented auto-retrofit
    // (graph is empty), so we do it manually here.
    if (multiPodMode) {
      Object.keys(podRegistry).forEach(function (podKey) { ensureCompoundParent(podKey); });
    }

    // Now add agent nodes — multiPodMode and compound parents are already ready.
    Object.keys(la).forEach(function (id) {
      var entry = la[id];
      if (!entry || !entry.nodeId) return;
      liveAgents[entry.nodeId] = entry;
      upsertNode(entry);
    });

    if (Array.isArray(state.edges)) setEdges(state.edges);

    // Ensure hub node exists and is styled when journal-active (even with zero agents).
    if (hubState) {
      ensureHubNode();
      var hubEle = cy.getElementById(HUB_ID);
      if (hubEle.nonempty()) {
        hubEle.data('label', hubLabel(hubState));
        hubEle.removeClass('hub-active hub-idle');
        hubEle.addClass(hubState.state === 'active' ? 'hub-active' : 'hub-idle');
      }
    }

    if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null; }
    updatePodLegend();
    runLayout();

    // Re-render a still-pinned panel against the fresh snapshot; close it if its
    // node no longer exists in the new authoritative state.
    if (pinnedNodeId) {
      if (cy && cy.getElementById(pinnedNodeId).nonempty()) renderPanel(pinnedNodeId);
      else closePanel();
    }
  }

  function onAgentEnter(p) {
    if (!p || !p.nodeId) return;
    liveAgents[p.nodeId] = Object.assign({}, liveAgents[p.nodeId], p);
    var added = upsertNode(liveAgents[p.nodeId]);
    ensureSpoke(p.nodeId); // optimistic hub + spoke until edge:update confirms
    if (added) {
      animateNodeEntrance(cy.getElementById(p.nodeId)); // §4.1
    }
    if (p.dispatchFlash) {
      flashDispatchSpoke(p.nodeId); // §3.5 — correlated launch flash
    }
    updatePodLegend();
    scheduleLayout();
  }

  function onAgentUpdate(p) {
    if (!p || !p.nodeId) return;
    var existing = liveAgents[p.nodeId];
    if (!existing) return; // updates for unknown nodes are ignored (matches state.js)
    liveAgents[p.nodeId] = Object.assign({}, existing, p);
    upsertNode(liveAgents[p.nodeId]); // refresh state class + live step label, no relayout
    refreshPinnedPanel(p.nodeId); // live-update the panel if this node is pinned open
  }

  function onAgentExit(p) {
    if (!p || !p.nodeId) return;
    var exitCode = (p && typeof p.exitCode === 'number') ? p.exitCode : undefined;
    // Retain a terminal snapshot for a pinned panel so it can show the ✔/✘ chip and a
    // frozen clock after the live entry is dropped (design §5 — no auto-close on exit).
    if (pinnedNodeId === p.nodeId) {
      var prev = liveAgents[p.nodeId] || {};
      var terminalState = (exitCode != null && exitCode !== 0) ? 'exiting:errored' : 'exiting:done';
      exitedEntries[p.nodeId] = Object.assign({}, prev, p, {
        state: (typeof p.state === 'string' ? p.state : terminalState),
        exitCode: exitCode,
      });
    }
    delete liveAgents[p.nodeId]; // remove from live set immediately
    updatePodLegend(); // pod may have no more live agents
    animateNodeExit(p.nodeId, exitCode); // §4.4 — node removal is deferred ~2.5 s
    refreshPinnedPanel(p.nodeId); // swap to terminal chip + freeze clock if pinned
    // scheduleLayout() is called inside animateNodeExit after the linger window
  }

  function onEdgeUpdate(p) {
    if (!p) return;
    if (Array.isArray(p.edges)) setEdges(p.edges);
    if (Object.keys(liveAgents).length === 0) removeHubIfOrphan();
    scheduleLayout();
  }

  function onHubUpdate(p) {
    if (!p) return;
    // Removal: backend signals hub is gone (journal stale + no agents).
    if (p.present === false || p.removed === true) {
      hubState = null;
      if (!cy) return;
      if (Object.keys(liveAgents).length === 0) {
        var ele = cy.getElementById(HUB_ID);
        if (ele.nonempty()) {
          // Idle wind-down: dim briefly, then remove.
          ele.removeClass('hub-active');
          ele.addClass('hub-idle');
          setTimeout(function () {
            if (hubState !== null) return; // re-activated before timer fired
            var h = cy.getElementById(HUB_ID);
            if (h.nonempty() && hubState === null && Object.keys(liveAgents).length === 0) {
              h.remove();
              scheduleLayout();
            }
          }, 800);
        }
      }
      return;
    }

    var wasAbsent = !cy || cy.getElementById(HUB_ID).empty();
    hubState = Object.assign({}, hubState || {}, p);
    if (!cy) return;
    ensureHubNode();
    var ele = cy.getElementById(HUB_ID);
    if (!ele || ele.empty()) return;
    ele.data('label', hubLabel(hubState));
    ele.removeClass('hub-active hub-idle');
    ele.addClass(hubState.state === 'active' ? 'hub-active' : 'hub-idle');
    if (wasAbsent) {
      animateNodeEntrance(ele);
      scheduleLayout();
    }
    if (pinnedNodeId && (pinnedNodeId === HUB_ID || pinnedNodeId.indexOf(HUB_ID + '@') === 0)) {
      renderPanel(pinnedNodeId); // keep a pinned hub panel live as its label/state changes
    }
  }

  function applyPatch(event, payload) {
    payload = payload || {};
    trackDocker(payload);
    switch (event) {
      case 'agent:enter':  onAgentEnter(payload);  break;
      case 'agent:update': onAgentUpdate(payload); break;
      case 'agent:exit':   onAgentExit(payload);   break;
      case 'edge:update':  onEdgeUpdate(payload);  break;
      case 'hub:update':   onHubUpdate(payload);   break;
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
    if (els.tooltipClose) els.tooltipClose.addEventListener('click', closePanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
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
