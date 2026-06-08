/**
 * Cytoscape visual stylesheet for Voltron Glimpse.
 * Consumed by app.js via window.GLIMPSE_CYTO_STYLE.
 *
 * Node classes assigned by app.js:
 *   Tier:   tier1 | tier2 | tier3
 *   Status: queued | dispatching | working | done | blocked | errored
 *
 * Edge classes:
 *   dispatch   — inferred parent→child (dashed)
 *   dependency — declared beads dep (solid)
 *   active     — animate while target is working
 */

/* Status palette (mirrors CSS custom properties) */
var _C = {
  queued:      '#607d8b',
  dispatching: '#2196f3',
  working:     '#4caf50',
  done:        '#1b8c32',
  blocked:     '#ff9800',
  errored:     '#f44336',
  bg:          '#0a1628',
  surface:     'rgba(255,255,255,0.07)',
  border:      'rgba(255,255,255,0.18)',
  text:        '#e0e6ed',
  textDim:     '#8899aa',
  accent:      '#00e5ff',
};

window.GLIMPSE_CYTO_STYLE = [

  /* ─── Global node defaults ──────────────────────────────────────────── */
  {
    selector: 'node',
    style: {
      'shape':                  'ellipse',
      'background-color':       _C.queued,
      'border-width':           2,
      'border-color':           _C.border,
      'label':                  'data(label)',
      'text-valign':            'bottom',
      'text-halign':            'center',
      'color':                  _C.text,
      'font-family':            'Inter, system-ui, sans-serif',
      'font-size':              10,
      'text-wrap':              'wrap',
      'text-max-width':         80,
      'text-margin-y':          4,
      'overlay-opacity':        0,
      'z-index':                10,
    }
  },

  /* ─── Node tier sizing ───────────────────────────────────────────────
   *   Tier 1 — orchestrators (scrum-master, code-analyst, …)
   *   Tier 2 — specialists (fullstack-dev, ui-designer, …)
   *   Tier 3 — micro-agents (committer, route-adder, …) + default
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'node.tier1',
    style: {
      'width':      64,
      'height':     64,
      'font-size':  12,
      'font-weight':'bold',
      'text-max-width': 80,
      'border-width': 3,
    }
  },
  {
    selector: 'node.tier2',
    style: {
      'width':      44,
      'height':     44,
      'font-size':  10,
    }
  },
  {
    selector: 'node.tier3',
    style: {
      'width':      28,
      'height':     28,
      'font-size':  9,
      'text-max-width': 60,
    }
  },

  /* ─── Status colours ────────────────────────────────────────────────── */
  {
    selector: 'node.queued',
    style: {
      'background-color': _C.queued,
      'border-color':     'rgba(96,125,139,0.45)',
    }
  },
  {
    selector: 'node.dispatching',
    style: {
      'background-color': _C.dispatching,
      'border-color':     'rgba(33,150,243,0.60)',
    }
  },
  {
    selector: 'node.working',
    style: {
      'background-color': _C.working,
      'border-color':     'rgba(76,175,80,0.80)',
      /* Cytoscape doesn't support CSS animations on nodes, so we approximate
         a "pulse halo" by cycling border + shadow-like properties via
         the transition/animation properties Cytoscape supports. */
      'border-width':      3,
      'border-opacity':    1,
    }
  },
  {
    selector: 'node.done',
    style: {
      'background-color': _C.done,
      'border-color':     'rgba(27,140,50,0.60)',
      'opacity':          0.85,
    }
  },
  {
    selector: 'node.blocked',
    style: {
      'background-color': _C.blocked,
      'border-color':     'rgba(255,152,0,0.70)',
    }
  },
  {
    selector: 'node.errored',
    style: {
      'background-color': _C.errored,
      'border-color':     'rgba(244,67,54,0.70)',
    }
  },

  /* Hover / selection feedback */
  {
    selector: 'node:selected',
    style: {
      'border-color':   _C.accent,
      'border-width':   3,
      'overlay-color':  _C.accent,
      'overlay-opacity': 0.08,
    }
  },

  /* ─── Working node animated halo (Cytoscape keyframe via animate API)
   *   app.js calls cy.animate() on .working nodes; the class below
   *   provides the base styling so it looks right before animation fires.
   * ─────────────────────────────────────────────────────────────────── */
  {
    selector: 'node.working-pulse',
    style: {
      'border-width':   6,
      'border-opacity': 0.15,
      'border-color':   _C.working,
    }
  },

  /* ─── Compound/parent phase nodes (swim-lane containers) ─────────────── */
  {
    selector: 'node.phase-container',
    style: {
      'shape':            'rectangle',
      'background-color': 'rgba(255,255,255,0.015)',
      'border-width':     1,
      'border-color':     'rgba(255,255,255,0.06)',
      'border-style':     'solid',
      'label':            'data(label)',
      'text-valign':      'top',
      'text-halign':      'right',
      'color':            _C.textDim,
      'font-size':        10,
      'text-margin-y':    8,
      'text-margin-x':    -8,
      'padding':          '24px',
      'z-index':          1,
    }
  },

  /* ─── Global edge defaults ───────────────────────────────────────────── */
  {
    selector: 'edge',
    style: {
      'width':               1.5,
      'line-color':          _C.textDim,
      'target-arrow-color':  _C.textDim,
      'target-arrow-shape':  'triangle',
      'arrow-scale':         0.8,
      'curve-style':         'bezier',
      'opacity':             0.55,
    }
  },

  /* ─── Dispatch edges (inferred, dashed) ──────────────────────────────── */
  {
    selector: 'edge.dispatch',
    style: {
      'line-style':          'dashed',
      'line-dash-pattern':   [6, 4],
      'line-color':          _C.dispatching,
      'target-arrow-color':  _C.dispatching,
      'opacity':             0.50,
    }
  },

  /* ─── Active dispatch edge (ripple animation via line-dash-offset) ───── */
  {
    selector: 'edge.dispatch.active',
    style: {
      'line-color':         _C.working,
      'target-arrow-color': _C.working,
      'opacity':            0.80,
      /* app.js drives the dash-offset animation with cy.animate() */
    }
  },

  /* ─── Dependency edges (declared beads, solid) ───────────────────────── */
  {
    selector: 'edge.dependency',
    style: {
      'line-style':          'solid',
      'line-color':          _C.accent,
      'target-arrow-color':  _C.accent,
      'arrow-scale':         0.9,
      'opacity':             0.65,
    }
  },

  /* Edge hover */
  {
    selector: 'edge:selected',
    style: {
      'width':   2.5,
      'opacity': 1,
      'overlay-color':   _C.accent,
      'overlay-opacity': 0.08,
    }
  },
];
