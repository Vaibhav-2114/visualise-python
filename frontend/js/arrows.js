/**
 * ArrowRenderer computes dynamic SVG cubic Bezier pointer connections between
 * stack frame/heap object ports and target heap objects.
 * Handles self-loops, backward arch curves, bidirectional cycle separation,
 * and multi-inbound port staggering.
 */
export class ArrowRenderer {
  /**
   * @param {Object} options
   * @param {SVGElement} [options.svgContainer] The <svg id="connections-layer"> element
   * @param {HTMLElement} [options.nodesContainer] The <div id="nodes-layer"> element
   * @param {import('./position_store.js').PositionStore} [options.positionStore]
   * @param {() => number} [options.getScale] Returns the current canvas scale factor
   */
  constructor(options = {}) {
    this.svgContainer = options.svgContainer || null;
    this.nodesContainer = options.nodesContainer || null;
    this.positionStore = options.positionStore || null;
    this.getScale = options.getScale || (() => 1.0);

    /** @type {Array<any>} Active edges list */
    this.edges = [];

    /** @type {Map<string, SVGElement>} Map of edge ID to SVG <g> element */
    this.edgeElements = new Map();

    /** @type {Map<string, Set<string>>} Map of nodeId to Set of connected edge IDs */
    this.nodeEdgeIndex = new Map();

    this.ensureMarkers();
  }

  /**
   * Escapes a string for safe inclusion in a CSS attribute/ID selector.
   * @param {string} value
   * @returns {string}
   */
  escapeSelector(value) {
    const str = String(value);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(str);
    }
    return str.replace(/[^a-zA-Z0-9_-]/g, (char) => String.fromCharCode(92) + char);
  }

  /**
   * Clears all rendered edges, indexes, and SVG path groups while preserving markers.
   */
  clear() {
    this.edges = [];
    this.edgeElements.clear();
    this.nodeEdgeIndex.clear();
    if (this.svgContainer) {
      this.svgContainer.innerHTML = '';
      this.ensureMarkers();
    }
  }

  /**
   * Ensure SVG <defs> contains arrowhead markers.
   */
  ensureMarkers() {
    if (!this.svgContainer) return;

    let defs = this.svgContainer.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      this.svgContainer.prepend(defs);
    }

    // Standard marker
    if (!defs.querySelector('#arrowhead')) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrowhead');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 1.5 L 8 5 L 0 8.5 z');
      path.setAttribute('fill', '#6366f1');
      marker.appendChild(path);
      defs.appendChild(marker);
    }

    // Highlight marker
    if (!defs.querySelector('#arrowhead-highlight')) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrowhead-highlight');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 1.5 L 8 5 L 0 8.5 z');
      path.setAttribute('fill', '#f59e0b');
      marker.appendChild(path);
      defs.appendChild(marker);
    }

    // Return marker
    if (!defs.querySelector('#arrowhead-return')) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrowhead-return');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 1.5 L 8 5 L 0 8.5 z');
      path.setAttribute('fill', '#10b981');
      marker.appendChild(path);
      defs.appendChild(marker);
    }
  }

  /**
   * Sets active edges and renders them to SVG.
   * @param {Array<{ id?: string, sourcePortId: string, sourceNodeId: string, targetNodeId: string, isHighlighted?: boolean, isReturn?: boolean }>} edges
   */
  renderEdges(edges = []) {
    this.edges = edges.map((e) => {
      const edgeId = e.id || `edge-${e.sourcePortId}->${e.targetNodeId}`;
      return { ...e, id: edgeId };
    });

    // Rebuild index
    this.nodeEdgeIndex.clear();
    for (const edge of this.edges) {
      if (!this.nodeEdgeIndex.has(edge.sourceNodeId)) {
        this.nodeEdgeIndex.set(edge.sourceNodeId, new Set());
      }
      this.nodeEdgeIndex.get(edge.sourceNodeId).add(edge.id);

      if (!this.nodeEdgeIndex.has(edge.targetNodeId)) {
        this.nodeEdgeIndex.set(edge.targetNodeId, new Set());
      }
      this.nodeEdgeIndex.get(edge.targetNodeId).add(edge.id);
    }

    if (!this.svgContainer) return;

    this.ensureMarkers();

    // Remove obsolete edge DOM elements
    const activeEdgeIds = new Set(this.edges.map((e) => e.id));
    for (const [id, el] of this.edgeElements.entries()) {
      if (!activeEdgeIds.has(id) || el.isConnected === false) {
        if (typeof el.remove === 'function') el.remove();
        this.edgeElements.delete(id);
      }
    }

    // Stagger map: count incoming edges per targetNodeId
    const inboundCounts = new Map();
    const inboundIndices = new Map();
    for (const edge of this.edges) {
      const count = inboundCounts.get(edge.targetNodeId) || 0;
      inboundCounts.set(edge.targetNodeId, count + 1);
    }

    // Check for bidirectional cycle pairs: NodeA -> NodeB and NodeB -> NodeA
    const bidirectionalPairs = this.detectBidirectionalPairs(this.edges);

    // Create / update SVG elements
    for (const edge of this.edges) {
      const totalInbound = inboundCounts.get(edge.targetNodeId) || 1;
      const inboundIndex = inboundIndices.get(edge.targetNodeId) || 0;
      inboundIndices.set(edge.targetNodeId, inboundIndex + 1);

      const isBiDir = bidirectionalPairs.has(edge.id);
      const isReversePair = bidirectionalPairs.get(edge.id) === 'backward';

      const pathData = this.calculateEdgePath(edge, {
        inboundIndex,
        totalInbound,
        isBidirectional: isBiDir,
        isReversePair
      });

      let groupEl = this.edgeElements.get(edge.id);
      if (!groupEl || groupEl.isConnected === false) {
        groupEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        groupEl.setAttribute('class', 'pointer-group');
        groupEl.setAttribute('id', edge.id);

        const hitarea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitarea.setAttribute('class', 'pointer-hitarea');

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('class', 'pointer-line');

        groupEl.appendChild(hitarea);
        groupEl.appendChild(line);
        this.svgContainer.appendChild(groupEl);
        this.edgeElements.set(edge.id, groupEl);
      }

      // Update classes and marker
      const line = groupEl.querySelector('.pointer-line');
      const hitarea = groupEl.querySelector('.pointer-hitarea');

      let lineClass = 'pointer-line';
      if (edge.isHighlighted) {
        lineClass += ' highlight';
      } else if (edge.isReturn) {
        lineClass += ' return';
      }
      line.setAttribute('class', lineClass);

      hitarea.setAttribute('d', pathData);
      line.setAttribute('d', pathData);
    }
  }

  /**
   * Redraws every active edge after a layout transition.
   */
  updateAllArrows() {
    this.renderEdges(this.edges);
  }

  /**
   * Fast redraw of only connected edges for a dragged node.
   * Modifies existing SVG path 'd' attributes directly for 60fps performance.
   * @param {string} nodeId
   */
  updateConnectedArrows(nodeId) {
    const connectedEdgeIds = this.nodeEdgeIndex.get(nodeId);
    if (!connectedEdgeIds || connectedEdgeIds.size === 0) return;

    // Recalculate inbound groupings for affected targets
    const inboundCounts = new Map();
    const inboundIndices = new Map();
    for (const edge of this.edges) {
      const count = inboundCounts.get(edge.targetNodeId) || 0;
      inboundCounts.set(edge.targetNodeId, count + 1);
    }

    const bidirectionalPairs = this.detectBidirectionalPairs(this.edges);

    for (const edge of this.edges) {
      const totalInbound = inboundCounts.get(edge.targetNodeId) || 1;
      const inboundIndex = inboundIndices.get(edge.targetNodeId) || 0;
      inboundIndices.set(edge.targetNodeId, inboundIndex + 1);

      if (!connectedEdgeIds.has(edge.id)) continue;

      const groupEl = this.edgeElements.get(edge.id);
      if (!groupEl) continue;

      const isBiDir = bidirectionalPairs.has(edge.id);
      const isReversePair = bidirectionalPairs.get(edge.id) === 'backward';

      const pathData = this.calculateEdgePath(edge, {
        inboundIndex,
        totalInbound,
        isBidirectional: isBiDir,
        isReversePair
      });

      const hitarea = groupEl.querySelector('.pointer-hitarea');
      const line = groupEl.querySelector('.pointer-line');
      if (hitarea) hitarea.setAttribute('d', pathData);
      if (line) line.setAttribute('d', pathData);
    }
  }

  /**
   * Detects bidirectional pairs between nodes (Node A -> Node B and Node B -> Node A).
   * @param {Array<any>} edges
   * @returns {Map<string, 'forward' | 'backward'>} Edge ID to direction label
   */
  detectBidirectionalPairs(edges) {
    const pairMap = new Map();
    const seenPairs = new Set();

    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const e1 = edges[i];
        const e2 = edges[j];
        if (
          e1.sourceNodeId === e2.targetNodeId &&
          e1.targetNodeId === e2.sourceNodeId &&
          e1.sourceNodeId !== e1.targetNodeId
        ) {
          pairMap.set(e1.id, 'forward');
          pairMap.set(e2.id, 'backward');
        }
      }
    }
    return pairMap;
  }

  /**
   * Calculates anchor points and cubic Bezier curve for an edge.
   * @param {Object} edge
   * @param {Object} [options]
   * @param {number} [options.inboundIndex=0]
   * @param {number} [options.totalInbound=1]
   * @param {boolean} [options.isBidirectional=false]
   * @param {boolean} [options.isReversePair=false]
   * @returns {string} SVG path 'd' string
   */
  calculateEdgePath(edge, options = {}) {
    const {
      inboundIndex = 0,
      totalInbound = 1,
      isBidirectional = false,
      isReversePair = false
    } = options;

    const sourceRect = this.getNodeRect(edge.sourceNodeId);
    const targetRect = this.getNodeRect(edge.targetNodeId);
    const portRect = this.getPortRect(edge.sourcePortId, sourceRect);

    // Anchor directly at the exact center of the blue .port-socket dot
    const Sx = portRect.x + (portRect.width * 0.5);
    const Sy = portRect.y + (portRect.height * 0.5);

    // Self-loop (sourceNode === targetNode)
    if (edge.sourceNodeId === edge.targetNodeId) {
      return this.generateSelfLoopPath(sourceRect, Sx, Sy);
    }

    // Dynamic Target Anchor (Tx, Ty)
    let Tx, Ty;
    const targetCenterX = targetRect.x + (targetRect.width * 0.5);

    // Stagger landing along target left edge if multiple inbound
    let landingY = targetRect.y + (targetRect.height * 0.5);
    if (totalInbound > 1) {
      const margin = Math.min(18, targetRect.height * 0.2);
      const usableHeight = Math.max(10, targetRect.height - margin * 2);
      landingY = targetRect.y + margin + ((inboundIndex + 0.5) / totalInbound) * usableHeight;
    }

    // Bidirectional cycle offset
    let yOffset = 0;
    if (isBidirectional) {
      yOffset = isReversePair ? -15 : 15;
    }

    if (targetCenterX < Sx - 20) {
      // Route backward references overhead so they clear both card headers.
      return this.generateBackwardArchPath(Sx, Sy, targetRect, yOffset, landingY, sourceRect, inboundIndex);
    } else {
      // Case: Forward Reference (Target to the right or aligned)
      Tx = targetRect.x;
      Ty = landingY + yOffset;
      return this.generateForwardPath(Sx, Sy, Tx, Ty, yOffset);
    }
  }

  /**
   * Standard Forward Cubic Bezier Path (Left to Right)
   */
  generateForwardPath(Sx, Sy, Tx, Ty, yOffset = 0) {
    const dx = Math.abs(Tx - Sx);
    const controlDist = Math.max(40, dx * 0.5);

    const C1x = Math.round(Sx + controlDist);
    const C1y = Math.round(Sy + yOffset);
    const C2x = Math.round(Tx - controlDist);
    const C2y = Math.round(Ty + yOffset);

    return `M ${Math.round(Sx)} ${Math.round(Sy)} C ${C1x} ${C1y}, ${C2x} ${C2y}, ${Math.round(Tx)} ${Math.round(Ty)}`;
  }

  /**
   * Routes backward pointers above both source and target cards.
   * @param {number} Sx
   * @param {number} Sy
   * @param {{ x: number, y: number, width: number, height: number }} targetRect
   * @param {number} [yOffset=0]
   * @param {number | null} [landingY=null]
   * @param {{ x: number, y: number, width: number, height: number } | null} [sourceRect=null]
   * @param {number} [staggerIndex=0]
   * @returns {string} SVG path string
   */
  generateBackwardArchPath(Sx, Sy, targetRect, yOffset = 0, landingY = null, sourceRect = null, staggerIndex = 0) {
    const Tx = Math.round(targetRect.x + targetRect.width);
    const resolvedLandingY = (landingY !== null && landingY !== undefined && Number.isFinite(landingY))
      ? landingY + yOffset
      : (targetRect.y + (targetRect.height * 0.5) + yOffset);
    const Ty = Math.round(Math.max(targetRect.y + 12, Math.min(targetRect.y + targetRect.height - 12, resolvedLandingY)));
    const topMost = sourceRect ? Math.min(sourceRect.y, targetRect.y) : Math.min(Sy, Ty) - 20;
    const Yarch = Math.round(topMost - 42 - (staggerIndex * 14) + Math.min(0, yOffset));
    const C1x = Math.round(Sx + 46);
    const C2x = Math.round(Tx + 46);
    return `M ${Math.round(Sx)} ${Math.round(Sy)} C ${C1x} ${Yarch}, ${C2x} ${Yarch}, ${Tx} ${Ty}`;
  }

  /**
   * Self-Loop Path (node pointing to itself)
   */
  generateSelfLoopPath(nodeRect, Sx, Sy) {
    const Tx = Math.round(nodeRect.x + (nodeRect.width * 0.5));
    const Ty = Math.round(nodeRect.y);

    const C1x = Math.round(Sx + 45);
    const C1y = Math.round(Sy - 45);
    const C2x = Math.round(Tx + 35);
    const C2y = Math.round(Ty - 50);

    return `M ${Math.round(Sx)} ${Math.round(Sy)} C ${C1x} ${C1y}, ${C2x} ${C2y}, ${Tx} ${Ty}`;
  }

  /**
   * Resolve bounding rect for a node in world space.
   * @param {string} nodeId
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  getNodeRect(nodeId) {
    // If DOM element exists and layout is available
    if (this.nodesContainer && typeof document !== 'undefined') {
      const escapedId = this.escapeSelector(nodeId);
      const el = this.nodesContainer.querySelector(`#${escapedId}`) || document.getElementById(nodeId);
      if (el) {
        // Try positionStore first for crisp coordinates
        const stored = this.positionStore?.get(nodeId);
        const w = el.offsetWidth || 180;
        const h = el.offsetHeight || 120;
        if (stored) {
          return { x: stored.x, y: stored.y, width: w, height: h };
        }
        return {
          x: el.offsetLeft || 0,
          y: el.offsetTop || 0,
          width: w,
          height: h
        };
      }
    }

    // Fallback to positionStore
    if (this.positionStore?.has(nodeId)) {
      const pos = this.positionStore.get(nodeId);
      return { x: pos.x, y: pos.y, width: 180, height: 120 };
    }

    return { x: 0, y: 0, width: 180, height: 120 };
  }

  /**
   * Resolve bounding rect for a port socket.
   * Uses getBoundingClientRect for precise positioning, then divides the
   * screen-space offset by the canvas scale to convert to world coordinates.
   * @param {string} portId
   * @param {{ x: number, y: number, width: number, height: number }} nodeRect
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  getPortRect(portId, nodeRect) {
    if (this.nodesContainer && typeof document !== 'undefined') {
      const escapedPort = this.escapeSelector(portId);
      const selector = `[data-port-id="${escapedPort}"]`;
      const el = this.nodesContainer.querySelector(selector) || document.querySelector(selector);
      if (el) {
        const nodeEl = el.closest('.canvas-node');
        if (nodeEl) {
          const elRect = el.getBoundingClientRect();
          const nodeBounding = nodeEl.getBoundingClientRect();
          // getBoundingClientRect returns screen-space coords (includes CSS scale transform).
          // Divide by scale to convert to world-space offsets within the node.
          const scale = (typeof this.getScale === 'function' ? this.getScale() : 1.0) || 1.0;
          const relX = (elRect.left - nodeBounding.left) / scale;
          const relY = (elRect.top - nodeBounding.top) / scale;
          const w = (elRect.width) / scale;
          const h = (elRect.height) / scale;
          return {
            x: nodeRect.x + relX,
            y: nodeRect.y + relY,
            width: w || 12,
            height: h || 12
          };
        }
      }
    }

    // Default port position: right edge at 45% height
    return {
      x: nodeRect.x + nodeRect.width - 16,
      y: nodeRect.y + (nodeRect.height * 0.45),
      width: 12,
      height: 12
    };
  }
}
