/**
 * Cytoscape visual stylesheet for Voltron Glimpse — live-monitor vocabulary.
 * Consumed by app.js via window.GLIMPSE_CYTO_STYLE.
 *
 * Node classes assigned by app.js:
 *   Tier:   tier1 | tier2 | tier3
 *   Status: dispatching | working | exiting-done | exiting-errored
 *   Anim:   node-entering | node-exiting  (pulse loop skips these)
 *
 * Edge classes:
 *   dispatch   — inferred parent→child spoke (dashed base)
 *   active     — target is working; app.js drives line-dash-offset via rAF
 */

/* Live-centric palette — 4-state model only (§2.4) */
/* Motion duration constants (ms) — keep a small token set for cohesion */
var _DUR = { fast: 120, base: 240, slow: 480 };

var _C = {
  dispatching:    '#2196f3',
  working:        '#4caf50',
  exitingDone:    '#00e676',   /* bright vivid green terminal flash */
  exitingErrored: '#f44336',
  hub:            '#00e5ff',   /* accent cyan for the synthetic hub anchor */
  subdispatch:    '#9c6ade',   /* violet — doubly-inferred Tier-2→Tier-3 edge */
  bg:             '#0a1628',
  border:         'rgba(255,255,255,0.18)',
  borderDim:      'rgba(255,255,255,0.08)',
  text:           '#e0e6ed',
  textDim:        '#8899aa',
  accent:         '#00e5ff',
};

window.GLIMPSE_CYTO_STYLE = [

  /* ─── Global node defaults ──────────────────────────────────────────── */
  {
    selector: 'node',
    style: {
      'shape':              'ellipse',
      'background-color':   _C.dispatching,
      'border-width':       2,
      'border-color':       _C.border,
      'label':              'data(label)',
      'text-valign':        'bottom',
      'text-halign':        'center',
      'color':              _C.text,
      'text-outline-color': 'rgba(5, 12, 24, 0.90)',
      'text-outline-width': 2,
      'font-family':        'Inter, system-ui, sans-serif',
      'font-size':          10,
      'text-wrap':          'wrap',
      'text-max-width':     80,
      'text-margin-y':      4,
      /* Level-of-detail: when the rendered label would be smaller than this
         (i.e. the graph is zoomed out to fit a dense swarm), hide it rather
         than draw cramped, overlapping, unreadable text. Labels reappear as
         the user zooms/pans in. Keeps high node counts legible. */
      'min-zoomed-font-size': 8,
      'overlay-opacity':    0,
      'overlay-color':      _C.working,
      'z-index':            10,
      /* Smooth state-class transitions (background-color + border-color are
         class-driven; border-width + overlay-opacity stay rAF-owned) */
      'transition-property':        'background-color, border-color',
      'transition-duration':        _DUR.base,
      'transition-timing-function': 'ease-in-out',
    }
  },

  /* ─── Hub node (synthetic scrum-master anchor) ─────────────────────── */
  {
    selector: 'node.hub',
    style: {
      'background-color':  _C.hub,
      'border-color':      'rgba(0,229,255,0.60)',
      'border-width':      3,
      'color':             '#ffffff',
      'font-weight':       'bold',
      'overlay-color':     _C.hub,
      'transition-property':        'background-color, border-color, opacity',
      'transition-duration':        _DUR.slow,
      'transition-timing-function': 'ease-in-out',
    }
  },

  /* ─── Hub active: rAF drives border-width + overlay-opacity (§3.4) ─── */
  {
    selector: 'node.hub.hub-active',
    style: {
      'background-color':  _C.hub,
      'border-color':      'rgba(0,229,255,0.85)',
      'border-width':      4,
      'opacity':           1,
      'overlay-color':     _C.hub,
      'z-index':           20,
    }
  },

  /* ─── Hub idle: dimmed, pulse stopped ───────────────────────────────── */
  {
    selector: 'node.hub.hub-idle',
    style: {
      'background-color':  'rgba(0,229,255,0.25)',
      'border-color':      'rgba(0,229,255,0.22)',
      'border-width':      2,
      'opacity':           0.40,
      'overlay-opacity':   0,
    }
  },

  /* ─── Tier sizing ─────────────────────────────────────────────────────
   *   Tier 1 — orchestrators (scrum-master, code-analyst …)
   *   Tier 2 — specialists (fullstack-dev, ui-designer …)
   *   Tier 3 — micro-agents + default unknown
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'node.tier1',
    style: {
      'width': 64, 'height': 64,
      'font-size': 12, 'font-weight': 'bold',
      'text-max-width': 80, 'border-width': 3,
    }
  },
  {
    selector: 'node.tier2',
    style: { 'shape': 'rectangle', 'width': 44, 'height': 44, 'font-size': 10 }
  },
  {
    selector: 'node.tier3',
    style: { 'shape': 'triangle', 'width': 28, 'height': 28, 'font-size': 9, 'text-max-width': 60 }
  },

  /* ─── Inferred-agent: ghosted Tier-3 triangle (§6.1) ──────────────────
   * Applied when entry.inferred===true (synthesized sub-agent, no container).
   * Layered on top of tier3 shape so shape/size stay unchanged; only the fill
   * opacity and border style change to visually signal "not a real container".
   * border-color is still overridden inline by pod accent — that's fine;
   * border-style stays 'dashed' because it's a separate property.
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'node.inferred-agent',
    style: {
      'width':              20,        /* T7: one step smaller than tier3 (28px) so fan-outs read as subordinate */
      'height':             20,
      'font-size':          8,
      'background-opacity': 0.50,
      'border-style':       'dashed',
      'opacity':            0.80,
    }
  },

  /* ─── Fan-out pill node (T7): "+N" collapse badge when a parent has more than
   * SUBAGENT_FANOUT_MAX inferred children. Violet fill matches the sub-dispatch
   * edge hue. Clicking it expands the hidden children (handled in app.js).
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'node.pill-node',
    style: {
      'shape':              'roundrectangle',
      'width':              32,
      'height':             18,
      'background-color':   'rgba(156,106,222,0.20)',
      'border-color':       _C.subdispatch,
      'border-style':       'solid',
      'border-width':       1,
      'color':              _C.subdispatch,
      'font-size':          9,
      'font-weight':        'bold',
      'text-valign':        'center',
      'text-halign':        'center',
      'text-margin-y':      0,
      'label':              'data(label)',
      'overlay-opacity':    0,
      'opacity':            0.90,
      'z-index':            5,
    }
  },

  /* ─── Live status colours ─────────────────────────────────────────────
   *
   *  dispatching  — dim blue; container Up but no [exec] yet
   *  working      — vivid green; dominant state; pulse is driven by rAF
   *  exiting-done — bright green flash; clean exit
   *  exiting-errored — vivid red flash; non-zero exit code
   *
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'node.dispatching',
    style: {
      'background-color': _C.dispatching,
      'border-color':     'rgba(33,150,243,0.55)',
      'overlay-color':    _C.dispatching,
    }
  },
  {
    selector: 'node.working',
    style: {
      'background-color': _C.working,
      'border-color':     'rgba(76,175,80,0.85)',
      'border-width':     3,
      'overlay-color':    _C.working,
      /* border-width + overlay-opacity are driven frame-by-frame in the rAF
         loop; the values here are the resting / pre-animation baseline. */
    }
  },
  {
    selector: 'node.exiting-done',
    style: {
      'background-color': _C.exitingDone,
      'border-color':     'rgba(0,230,118,0.90)',
      'border-width':     4,
      'overlay-color':    _C.exitingDone,
    }
  },
  {
    selector: 'node.exiting-errored',
    style: {
      'background-color': _C.exitingErrored,
      'border-color':     'rgba(244,67,54,0.90)',
      'border-width':     4,
      'overlay-color':    _C.exitingErrored,
    }
  },

  /* ─── Hover affordance: class added by app.js mouseover/mouseout events ─
   * overlay-opacity is visible on hub-idle / exiting nodes; working/dispatching
   * nodes have rAF-driven inline overlay-opacity that takes precedence.        */
  {
    selector: 'node.node-hovered:not(.node-entering):not(.node-exiting)',
    style: {
      'overlay-opacity': 0.07,
      'overlay-color':   'rgba(255,255,255,0.9)',
      'z-index':         15,
    }
  },

  /* ─── Selection ─────────────────────────────────────────────────────── */
  {
    selector: 'node:selected',
    style: {
      'border-color':    _C.accent,
      'border-width':    3,
      'overlay-color':   _C.accent,
      'overlay-opacity': 0.12,
      'z-index':         20,
    }
  },

  /* ─── Global edge defaults ───────────────────────────────────────────── */
  {
    selector: 'edge',
    style: {
      'width':              1.5,
      'line-color':         _C.textDim,
      'target-arrow-color': _C.textDim,
      'target-arrow-shape': 'triangle',
      'arrow-scale':        0.8,
      'curve-style':        'bezier',
      'opacity':            0.45,
    }
  },

  /* ─── Dispatch spokes: dashed base (line-dash-offset driven by rAF) ─── */
  {
    selector: 'edge.dispatch',
    style: {
      'line-style':         'dashed',
      'line-dash-pattern':  [6, 4],
      'line-dash-offset':   0,           /* marching-ants starting position */
      'line-color':         _C.dispatching,
      'target-arrow-color': _C.dispatching,
      'opacity':            0.45,
    }
  },

  /* Active dispatch (target working): vivid; rAF animates line-dash-offset */
  {
    selector: 'edge.dispatch.active',
    style: {
      'line-color':         _C.working,
      'target-arrow-color': _C.working,
      'opacity':            0.85,
      'width':              2,
    }
  },

  /* Dispatch launch flash (§3.5): one-shot bright cyan burst when the hub just
     launched this agent. app.js animates line-color/width/opacity/dash inline
     over ~1 s; this class supplies the glow halo + raised z-index for the burst,
     then app.js removes it. */
  {
    selector: 'edge.dispatch.dispatch-flash',
    style: {
      'line-color':         _C.hub,
      'target-arrow-color': _C.hub,
      'width':              4,
      'opacity':            1,
      'overlay-color':      _C.hub,
      'overlay-opacity':    0.20,
      'z-index':            30,
    }
  },

  /* ─── Sub-dispatch edge: Tier-2 → inferred Tier-3 child (§6.2) ────────
   * Distinct from hub dispatch spokes: violet hue, thinner, lower base
   * opacity — visually reads as "even less certain" (both parentage AND
   * child existence are inferred, no container proof). rAF flow loop in
   * app.js drives line-dash-offset while the child is working.
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'edge.subdispatch',
    style: {
      'line-style':         'dashed',
      'line-dash-pattern':  [4, 5],      /* shorter dashes → visually weaker */
      'line-dash-offset':   0,
      'line-color':         _C.subdispatch,
      'target-arrow-color': _C.subdispatch,
      'width':              1.2,
      'opacity':            0.40,
    }
  },

  /* Active sub-dispatch (child working): vivid violet; rAF animates dash-offset */
  {
    selector: 'edge.subdispatch.active',
    style: {
      'line-color':         _C.subdispatch,
      'target-arrow-color': _C.subdispatch,
      'opacity':            0.75,
      'width':              1.6,
    }
  },

  /* ─── Pod accent border-color ────────────────────────────────────────
   * Per-pod hue rings are applied inline by app.js via
   *   ele.style('border-color', podAccentColor(podKey))
   * after every state-class change. Status fill (background-color) is the
   * primary live-state signal; the pod hue is a secondary orthogonal channel
   * on the border ring. No stylesheet rule is needed — inline styles take
   * precedence over the status-class border-color values above.
   * 'unknown' pods receive a neutral grey: rgba(136,153,170,0.55).
  ─────────────────────────────────────────────────────────────────── */

  /* ─── Pod compound-parent region ─────────────────────────────────────
   * Solid border = REAL pod membership (mount-source derived), visually
   * honest contrast with the dashed inferred dispatch spokes.
   * background-color + border-color are overridden inline per pod by
   * ensureCompoundParent() using the pod's deterministic hue.
   * z-index: 0 keeps the parent behind its children (z-index: 10).
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'node.pod-parent',
    style: {
      'shape':              'roundrectangle',
      'background-color':   'rgba(255,255,255,0.03)',
      'background-opacity': 1,
      'border-width':       2,
      'border-style':       'solid',
      'border-color':       'rgba(136,153,170,0.35)',
      'label':              'data(label)',
      'text-valign':        'top',
      'text-halign':        'center',
      'text-margin-y':      8,
      'color':              _C.text,
      'text-outline-color': 'rgba(5, 12, 24, 0.80)',
      'text-outline-width': 1,
      'font-size':          10,
      'font-weight':        'bold',
      'text-transform':     'uppercase',
      'padding':            24,
      'overlay-opacity':    0,
      'z-index':            0,
    }
  },

  /* Self-pod compound parent: warmer label color matching the gold hue */
  {
    selector: 'node.pod-parent.pod-self',
    style: {
      'color': 'hsla(45,80%,70%,0.90)',
    }
  },

  /* ─── Edge selection ─────────────────────────────────────────────────── */
  {
    selector: 'edge:selected',
    style: {
      'width':           2.5,
      'opacity':         1,
      'overlay-color':   _C.accent,
      'overlay-opacity': 0.10,
    }
  },
];
