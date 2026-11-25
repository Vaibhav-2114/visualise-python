/**
 * CanvasManager handles the 2D pan/zoom viewport coordinate geometry,
 * cursor-centered invariant scaling, fit-to-view calculation,
 * and DOM node diffing and rendering for stack frames and heap objects.
 */
import { PositionStore, normalizeNodeId } from './position_store.js';
import { ArrowRenderer } from './arrows.js';
import { DragManager } from './drag.js';

export class CanvasManager {
  /**
   * @param {Object} options
   * @param {HTMLElement} [options.viewport] Container element (#canvas-viewport)
   * @param {HTMLElement} [options.world] Transformed world element (#canvas-world)
   * @param {SVGElement} [options.connectionsLayer] SVG layer (#connections-layer)
   * @param {HTMLElement} [options.nodesLayer] HTML nodes container (#nodes-layer)
   * @param {PositionStore} [options.positionStore]
   * @param {ArrowRenderer} [options.arrowRenderer]
   * @param {DragManager} [options.dragManager]
   */
  constructor(options = {}) {
    this.viewport = options.viewport || null;
    this.world = options.world || null;
    this.connectionsLayer = options.connectionsLayer || null;
    this.nodesLayer = options.nodesLayer || null;

    // Viewport state
    this.panX = 0;
    this.panY = 0;
    this.scale = 1.0;
    this.minScale = 0.25;
    this.maxScale = 2.5;

    // Associated managers
    this.positionStore = options.positionStore || new PositionStore();
    this.arrowRenderer = options.arrowRenderer || new ArrowRenderer({
      svgContainer: this.connectionsLayer,
      nodesContainer: this.nodesLayer,
      positionStore: this.positionStore,
      getScale: () => this.scale
    });
    this.dragManager = options.dragManager || new DragManager({
      canvasManager: this,
      positionStore: this.positionStore,
      arrowRenderer: this.arrowRenderer,
      nodesContainer: this.nodesLayer
    });

    // Viewport panning state
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.lastPanX = 0;
    this.lastPanY = 0;

    // Step state tracking for diffing
    this.prevStepData = null;
    this.prevValuesMap = new Map();

    // Bind event handlers
    this.onWheel = this.onWheel.bind(this);
    this.onViewportPointerDown = this.onViewportPointerDown.bind(this);
    this.onViewportPointerMove = this.onViewportPointerMove.bind(this);
    this.onViewportPointerUp = this.onViewportPointerUp.bind(this);

    if (this.viewport) {
      this.initEvents();
      this.updateTransform();
    }
  }

  /**
   * Initialize viewport listeners (pan & wheel zoom).
   */
  initEvents() {
    if (!this.viewport) return;
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false });
    this.viewport.addEventListener('pointerdown', this.onViewportPointerDown);
    window.addEventListener('pointermove', this.onViewportPointerMove);
    window.addEventListener('pointerup', this.onViewportPointerUp);
    window.addEventListener('pointercancel', this.onViewportPointerUp);
  }

  /**
   * Destroy and clean up event listeners.
   */
  destroy() {
    if (!this.viewport) return;
    this.viewport.removeEventListener('wheel', this.onWheel);
    this.viewport.removeEventListener('pointerdown', this.onViewportPointerDown);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this.onViewportPointerMove);
      window.removeEventListener('pointerup', this.onViewportPointerUp);
      window.removeEventListener('pointercancel', this.onViewportPointerUp);
    }
  }

  /**
   * Fully resets canvas DOM nodes, SVG edges, stored positions, and zoom/pan.
   */
  clear() {
    if (this.nodesLayer) {
      this.nodesLayer.innerHTML = '';
    }
    if (this.arrowRenderer) {
      this.arrowRenderer.clear();
    } else if (this.connectionsLayer) {
      this.connectionsLayer.innerHTML = '';
    }
    this.positionStore.clear();
    this.prevStepData = null;
    this.prevValuesMap = new Map();
    this.resetZoom();
  }

  /**
   * Apply current panX, panY, and scale to world element via GPU transform.
   */
  updateTransform() {
    if (!this.world) return;
    this.world.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
    if (this.viewport) {
      // Synchronize dot grid background position
      this.viewport.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
    }
  }

  /**
   * Pan viewport by delta (dx, dy).
   * @param {number} dx
   * @param {number} dy
   */
  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.updateTransform();
  }

  /**
   * Cursor-centered zoom invariant scaling.
   * Ensures the world point under (clientX, clientY) remains invariant during zoom.
   * panX = Xs - (Xs - panX) * (newScale / scale)
   * panY = Ys - (Ys - panY) * (newScale / scale)
   * @param {number} clientX
   * @param {number} clientY
   * @param {number} targetScale
   */
  zoomAt(clientX, clientY, targetScale) {
    if (!Number.isFinite(targetScale)) return;
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, targetScale));
    if (newScale === this.scale) return;

    let Xs = clientX;
    let Ys = clientY;
    if (this.viewport && typeof this.viewport.getBoundingClientRect === 'function') {
      const rect = this.viewport.getBoundingClientRect();
      Xs = clientX - rect.left;
      Ys = clientY - rect.top;
    }

    const ratio = newScale / this.scale;
    this.panX = Xs - (Xs - this.panX) * ratio;
    this.panY = Ys - (Ys - this.panY) * ratio;
    this.scale = newScale;

    this.updateTransform();
  }

  /**
   * Reset zoom and pan to defaults.
   */
  resetZoom() {
    this.panX = 0;
    this.panY = 0;
    this.scale = 1.0;
    this.updateTransform();
  }

  /**
   * Convert screen (client) coordinates to canvas world coordinates.
   * worldX = (clientX - rect.left - panX) / scale
   * worldY = (clientY - rect.top - panY) / scale
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ worldX: number, worldY: number }}
   */
  screenToWorld(clientX, clientY) {
    let rectLeft = 0;
    let rectTop = 0;
    if (this.viewport && typeof this.viewport.getBoundingClientRect === 'function') {
      const rect = this.viewport.getBoundingClientRect();
      rectLeft = rect.left;
      rectTop = rect.top;
    }
    const worldX = (clientX - rectLeft - this.panX) / this.scale;
    const worldY = (clientY - rectTop - this.panY) / this.scale;
    return { worldX, worldY };
  }

  /**
   * Convert canvas world coordinates to screen (client) coordinates.
   * screenX = rect.left + panX + (worldX * scale)
   * screenY = rect.top + panY + (worldY * scale)
   * @param {number} worldX
   * @param {number} worldY
   * @returns {{ screenX: number, screenY: number }}
   */
  worldToScreen(worldX, worldY) {
    let rectLeft = 0;
    let rectTop = 0;
    if (this.viewport && typeof this.viewport.getBoundingClientRect === 'function') {
      const rect = this.viewport.getBoundingClientRect();
      rectLeft = rect.left;
      rectTop = rect.top;
    }
    const screenX = rectLeft + this.panX + (worldX * this.scale);
    const screenY = rectTop + this.panY + (worldY * this.scale);
    return { screenX, screenY };
  }

  /**
   * Fits all active nodes cleanly into the viewport.
   * @param {Array<{ x: number, y: number, width?: number, height?: number }>} [customBoxes]
   */
  fitToView(customBoxes = null) {
    let boxes = customBoxes;
    if (!boxes) {
      boxes = [];
      const activeNodes = this.nodesLayer ? this.nodesLayer.querySelectorAll('.canvas-node') : [];
      if (activeNodes.length > 0) {
        activeNodes.forEach((el) => {
          const pos = this.positionStore.get(el.id) || { x: el.offsetLeft || 0, y: el.offsetTop || 0 };
          boxes.push({
            x: pos.x,
            y: pos.y,
            width: el.offsetWidth || 180,
            height: el.offsetHeight || 120
          });
        });
      } else {
        const positions = this.positionStore.getAll();
        for (const [id, pos] of Object.entries(positions)) {
          let width = 180;
          let height = 120;
          if (this.nodesLayer) {
            const el = this.nodesLayer.querySelector(`#${id}`);
            if (el) {
              width = el.offsetWidth || 180;
              height = el.offsetHeight || 120;
            }
          }
          boxes.push({ x: pos.x, y: pos.y, width, height });
        }
      }
    }

    if (!boxes || boxes.length === 0) {
      this.resetZoom();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const b of boxes) {
      const w = b.width || 180;
      const h = b.height || 120;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + w);
      maxY = Math.max(maxY, b.y + h);
    }

    const padding = 60;
    const contentWidth = Math.max(100, maxX - minX + (padding * 2));
    const contentHeight = Math.max(100, maxY - minY + (padding * 2));

    let vpWidth = 800;
    let vpHeight = 600;
    if (this.viewport && typeof this.viewport.getBoundingClientRect === 'function') {
      const rect = this.viewport.getBoundingClientRect();
      vpWidth = rect.width || 800;
      vpHeight = rect.height || 600;
    }

    const scaleX = vpWidth / contentWidth;
    const scaleY = vpHeight / contentHeight;
    const fittedScale = Math.max(this.minScale, Math.min(1.5, Math.min(scaleX, scaleY)));

    const contentCenterX = (minX + maxX) * 0.5;
    const contentCenterY = (minY + maxY) * 0.5;

    this.scale = fittedScale;
    this.panX = (vpWidth * 0.5) - (contentCenterX * fittedScale);
    this.panY = (vpHeight * 0.5) - (contentCenterY * fittedScale);

    this.updateTransform();
  }

  /**
   * Re-aligns tidy layout: resets user moved flags and re-runs auto-layout.
   */
  realignAutoLayout() {
    if (!this.prevStepData) return;

    // Animate transition on all nodes during tidy reset
    if (this.nodesLayer) {
      const nodes = this.nodesLayer.querySelectorAll('.canvas-node');
      nodes.forEach((n) => n.classList.add('is-animating'));
    }

    this.positionStore.applyLayout(this.prevStepData, true);

    // Apply new positions
    if (this.nodesLayer) {
      const positions = this.positionStore.getAll();
      for (const [id, pos] of Object.entries(positions)) {
        const el = this.nodesLayer.querySelector(`#${id}`);
        if (el) {
          el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        }
      }
    }

    // Refresh arrows after the CSS transition settles
    setTimeout(() => {
      if (this.nodesLayer) {
        const nodes = this.nodesLayer.querySelectorAll('.canvas-node');
        nodes.forEach((n) => n.classList.remove('is-animating'));
      }
      this.arrowRenderer?.updateAllArrows();
    }, 420);
  }

  /**
   * Wheel event listener for zooming.
   * @param {WheelEvent} e
   */
  onWheel(e) {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    this.zoomAt(e.clientX, e.clientY, this.scale * zoomFactor);
  }

  /**
   * Viewport pointerdown listener for background panning.
   * @param {PointerEvent} e
   */
  onViewportPointerDown(e) {
    // Only pan if clicking on viewport background, not on a node or button
    const target = /** @type {HTMLElement} */ (e.target);
    if (
      target.closest('.canvas-node') ||
      target.closest('.canvas-toolbar') ||
      target.closest('button')
    ) {
      return;
    }

    this.isPanning = true;
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;
    this.lastPanX = this.panX;
    this.lastPanY = this.panY;
    if (this.viewport) {
      this.viewport.style.cursor = 'grabbing';
    }
  }

  /**
   * Viewport pointermove listener for background panning.
   * @param {PointerEvent} e
   */
  onViewportPointerMove(e) {
    if (!this.isPanning) return;
    const dx = e.clientX - this.panStartX;
    const dy = e.clientY - this.panStartY;
    this.panX = this.lastPanX + dx;
    this.panY = this.lastPanY + dy;
    this.updateTransform();
  }

  /**
   * Viewport pointerup listener.
   * @param {PointerEvent} e
   */
  onViewportPointerUp(e) {
    if (!this.isPanning) return;
    this.isPanning = false;
    if (this.viewport) {
      this.viewport.style.cursor = '';
    }
  }

  /**
   * Formats a non-reference value descriptor into display text, type label, and CSS class.
   * Handles primitive (int, float, bool, str, none), class, function, and other descriptors.
   * @param {any} valDesc
   * @returns {{ typeStr: string, displayText: string, valClass: string }}
   */
  formatValueDisplay(valDesc) {
    if (valDesc && typeof valDesc === 'object') {
      if (valDesc.kind === 'class') {
        return { typeStr: 'class', displayText: `<class ${valDesc.name || 'object'}>`, valClass: 'val-class' };
      }
      if (valDesc.kind === 'function') {
        return { typeStr: 'func', displayText: `${valDesc.name || 'fn'}()`, valClass: 'val-func' };
      }
      if (valDesc.kind === 'other') {
        return { typeStr: 'obj', displayText: String(valDesc.repr ?? ''), valClass: '' };
      }
      if (valDesc.kind === 'primitive' || 'value' in valDesc) {
        const raw = valDesc.value;
        const t = valDesc.type || typeof raw;
        if (t === 'none' || raw === null || raw === undefined) {
          return { typeStr: 'NoneType', displayText: 'None', valClass: 'val-none' };
        }
        if (t === 'bool' || typeof raw === 'boolean') {
          return { typeStr: 'bool', displayText: raw ? 'True' : 'False', valClass: 'val-bool' };
        }
        if (t === 'str' || typeof raw === 'string') {
          return { typeStr: 'str', displayText: JSON.stringify(String(raw)), valClass: 'val-str' };
        }
        return { typeStr: String(t), displayText: String(raw), valClass: '' };
      }
    }

    if (valDesc === null || valDesc === undefined || valDesc === 'None') {
      return { typeStr: 'NoneType', displayText: 'None', valClass: 'val-none' };
    }
    if (typeof valDesc === 'boolean') {
      return { typeStr: 'bool', displayText: valDesc ? 'True' : 'False', valClass: 'val-bool' };
    }
    if (typeof valDesc === 'string') {
      return { typeStr: 'str', displayText: valDesc, valClass: this.getPrimitiveValClass(valDesc) };
    }
    return { typeStr: typeof valDesc, displayText: String(valDesc), valClass: '' };
  }

  /**
   * Renders and diffs an execution step data snapshot on the canvas.
   * @param {{ step?: number, line?: number, func_name?: string, stack?: Array<any>, heap?: Record<string, any> }} stepData
   */
  renderStep(stepData) {
    if (!stepData) return;
    this.prevStepData = stepData;

    // Apply auto-layout for any newly discovered unpositioned nodes
    this.positionStore.applyLayout(stepData, false);

    const stack = Array.isArray(stepData.stack) ? stepData.stack : [];
    const heap = (stepData.heap && typeof stepData.heap === 'object') ? stepData.heap : {};

    const activeNodeIds = new Set();
    const currentValuesMap = new Map();
    const changedKeys = new Set();

    // 1. Render / Update Stack Frames
    stack.forEach((frame, idx) => {
      if (!frame) return;
      const rawId = (frame.frame_id !== undefined && frame.frame_id !== null && frame.frame_id !== '') ? frame.frame_id : idx;
      const frameId = normalizeNodeId(rawId, 'frame');
      activeNodeIds.add(frameId);
      this.renderStackFrameNode(frameId, frame, currentValuesMap, changedKeys);
    });

    // 2. Render / Update Heap Objects
    for (const [rawId, obj] of Object.entries(heap)) {
      if (!obj) continue;
      const objId = normalizeNodeId(rawId, 'obj');
      activeNodeIds.add(objId);
      this.renderHeapObjectNode(objId, obj, currentValuesMap, changedKeys);
    }

    // 3. Diff and remove dead nodes
    if (this.nodesLayer) {
      const existingNodes = this.nodesLayer.querySelectorAll('.canvas-node');
      existingNodes.forEach((nodeEl) => {
        if (!activeNodeIds.has(nodeEl.id)) {
          nodeEl.remove();
        }
      });
    }

    // 4. Update values map for pulse animation diffing on next step
    this.prevValuesMap = currentValuesMap;

    // 5. Render Reference Connection Edges
    this.renderEdgesFromStep(stepData, changedKeys);
  }

  /**
   * Render or update a stack frame DOM card.
   * @param {string} frameId
   * @param {Object} frame
   * @param {Map<string, string>} currentValuesMap
   * @param {Set<string>} [changedKeys]
   */
  renderStackFrameNode(frameId, frame, currentValuesMap, changedKeys = new Set()) {
    if (!this.nodesLayer || typeof document === 'undefined') return;

    let nodeEl = this.nodesLayer.querySelector(`#${frameId}`);
    const pos = this.positionStore.get(frameId) || { x: 50, y: 50 };
    const activeCls = frame.is_active ? ' active-frame' : '';

    if (!nodeEl) {
      nodeEl = document.createElement('div');
      nodeEl.className = `canvas-node stack-frame${activeCls}`;
      nodeEl.id = frameId;
      nodeEl.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      this.nodesLayer.appendChild(nodeEl);
      this.dragManager.bindDraggable(nodeEl, frameId);
    } else {
      nodeEl.className = `canvas-node stack-frame${activeCls}`;
      nodeEl.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    }

    const funcName = frame.func_name || '<module>';
    const lineno = frame.lineno || '';

    // Build header and variable table
    let varsHtml = '';
    const variables = frame.variables || {};

    for (const [varName, varVal] of Object.entries(variables)) {
      const valueKey = `${frameId}:${varName}`;
      const serializedVal = JSON.stringify(varVal);
      currentValuesMap.set(valueKey, serializedVal);

      const hasChanged = this.prevValuesMap.has(valueKey) &&
                         this.prevValuesMap.get(valueKey) !== serializedVal;
      if (hasChanged) changedKeys.add(valueKey);
      const pulseClass = hasChanged ? ' pulse-change' : '';

      if (varVal && (varVal.kind === 'ref' || varVal.type === 'ref')) {
        const rawTarget = varVal.target || varVal.value;
        const targetId = (rawTarget !== null && rawTarget !== undefined) ? String(rawTarget) : '';
        const portId = `${frameId}:${varName}`;
        varsHtml += `
          <tr class="var-row${pulseClass}" data-var="${this.escapeHtml(varName)}">
            <td class="var-name">${this.escapeHtml(varName)}</td>
            <td class="var-type">ref</td>
            <td class="var-value-cell">
              <span class="port-socket" data-port-id="${this.escapeHtml(portId)}" title="Points to #${this.escapeHtml(targetId)}"></span>
            </td>
          </tr>
        `;
      } else {
        const { typeStr, displayText, valClass } = this.formatValueDisplay(varVal);
        varsHtml += `
          <tr class="var-row${pulseClass}" data-var="${this.escapeHtml(varName)}">
            <td class="var-name">${this.escapeHtml(varName)}</td>
            <td class="var-type">${this.escapeHtml(typeStr)}</td>
            <td class="var-value-cell"><span class="primitive-val ${valClass}">${this.escapeHtml(displayText)}</span></td>
          </tr>
        `;
      }
    }

    if (frame.return_value !== null && frame.return_value !== undefined) {
      const retVal = frame.return_value;
      if (retVal && (retVal.kind === 'ref' || retVal.type === 'ref')) {
        const rawTarget = retVal.target || retVal.value;
        const targetId = (rawTarget !== null && rawTarget !== undefined) ? String(rawTarget) : '';
        const portId = `${frameId}:__return__`;
        varsHtml += `
          <tr class="var-row return-row" data-var="__return__">
            <td class="var-name">return</td>
            <td class="var-type">ref</td>
            <td class="var-value-cell">
              <span class="port-socket return-port" data-port-id="${this.escapeHtml(portId)}" title="Returns #${this.escapeHtml(targetId)}"></span>
            </td>
          </tr>
        `;
      } else {
        const { typeStr, displayText, valClass } = this.formatValueDisplay(retVal);
        varsHtml += `
          <tr class="var-row return-row" data-var="__return__">
            <td class="var-name">return</td>
            <td class="var-type">${this.escapeHtml(typeStr)}</td>
            <td class="var-value-cell"><span class="primitive-val ${valClass}">${this.escapeHtml(displayText)}</span></td>
          </tr>
        `;
      }
    }

    nodeEl.innerHTML = `
      <div class="node-header">
        <div class="node-badge frame-badge">Frame</div>
        <span class="node-title">${this.escapeHtml(funcName)}</span>
        <span class="node-line-tag">line ${lineno}</span>
      </div>
      <div class="node-body">
        <table class="var-table">
          ${varsHtml || '<tr><td colspan="3" style="color: #64748b; font-size: 11px;">(empty scope)</td></tr>'}
        </table>
      </div>
    `;
  }

  /**
   * Render or update a heap object DOM card.
   * @param {string} objId
   * @param {Object} obj
   * @param {Map<string, string>} currentValuesMap
   * @param {Set<string>} [changedKeys]
   */
  renderHeapObjectNode(objId, obj, currentValuesMap, changedKeys = new Set()) {
    if (!this.nodesLayer || typeof document === 'undefined') return;

    let nodeEl = this.nodesLayer.querySelector(`#${objId}`);
    const pos = this.positionStore.get(objId) || { x: 360, y: 100 };

    const rawType = obj.type || 'instance';
    const className = obj.class_name || (
      rawType === 'list' ? 'list' :
      rawType === 'dict' ? 'dict' :
      rawType === 'tuple' ? 'tuple' :
      rawType === 'set' ? 'set' :
      'Object'
    );

    let classSpecificClass = 'class-instance';
    let badgeClass = 'class-badge';
    if (className === 'ListNode' || obj.class_name === 'ListNode') {
      classSpecificClass = 'class-listnode';
    } else if (rawType === 'list') {
      classSpecificClass = 'class-list';
      badgeClass = 'list-badge';
    } else if (rawType === 'dict') {
      classSpecificClass = 'class-dict';
      badgeClass = 'dict-badge';
    } else if (rawType === 'tuple') {
      classSpecificClass = 'class-tuple';
      badgeClass = 'list-badge';
    } else if (rawType === 'set') {
      classSpecificClass = 'class-set';
      badgeClass = 'list-badge';
    }

    if (!nodeEl) {
      nodeEl = document.createElement('div');
      nodeEl.className = `canvas-node heap-object ${classSpecificClass}`;
      nodeEl.id = objId;
      nodeEl.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      this.nodesLayer.appendChild(nodeEl);
      this.dragManager.bindDraggable(nodeEl, objId);
    } else {
      nodeEl.className = `canvas-node heap-object ${classSpecificClass}`;
      nodeEl.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    }

    // Body content: attributes or list/tuple/set items or dict pairs
    let bodyHtml = '';

    if ((rawType === 'list' || rawType === 'tuple' || rawType === 'set') && Array.isArray(obj.items)) {
      let cellsHtml = '';
      obj.items.forEach((item, idx) => {
        const itemKey = `${objId}:${idx}`;
        const serialized = JSON.stringify(item);
        currentValuesMap.set(itemKey, serialized);
        const hasChanged = this.prevValuesMap.has(itemKey) && this.prevValuesMap.get(itemKey) !== serialized;
        if (hasChanged) changedKeys.add(itemKey);
        const pulseClass = hasChanged ? ' pulse-change' : '';

        if (item && (item.kind === 'ref' || item.type === 'ref')) {
          const rawTarget = item.target || item.value;
          const targetId = (rawTarget !== null && rawTarget !== undefined) ? String(rawTarget) : '';
          const portId = `${objId}:${idx}`;
          cellsHtml += `
            <div class="list-cell${pulseClass}">
              <div class="cell-index">${idx}</div>
              <div class="cell-val"><span class="port-socket" data-port-id="${this.escapeHtml(portId)}" title="Points to #${this.escapeHtml(targetId)}"></span></div>
            </div>
          `;
        } else {
          const { displayText, valClass } = this.formatValueDisplay(item);
          cellsHtml += `
            <div class="list-cell${pulseClass}">
              <div class="cell-index">${idx}</div>
              <div class="cell-val primitive-val ${valClass}">${this.escapeHtml(displayText)}</div>
            </div>
          `;
        }
      });
      const emptyLabel = rawType === 'tuple' ? '(empty tuple)' : rawType === 'set' ? '(empty set)' : '(empty list)';
      bodyHtml = cellsHtml ? `<div class="list-cells-container">${cellsHtml}</div>` : `<div style="color: #64748b; font-size: 11px; padding: 4px;">${emptyLabel}</div>`;
    } else if (rawType === 'dict' && Array.isArray(obj.entries)) {
      let rowsHtml = '';
      obj.entries.forEach((entry, idx) => {
        const rawKey = (entry && entry.key && entry.key.value !== undefined) ? entry.key.value : (entry?.key ?? idx);
        const keyStr = String(rawKey);
        const val = entry?.value;
        const entryKey = `${objId}:${keyStr}`;
        const serialized = JSON.stringify(val);
        currentValuesMap.set(entryKey, serialized);
        const hasChanged = this.prevValuesMap.has(entryKey) && this.prevValuesMap.get(entryKey) !== serialized;
        if (hasChanged) changedKeys.add(entryKey);
        const pulseClass = hasChanged ? ' pulse-change' : '';

        if (val && (val.kind === 'ref' || val.type === 'ref')) {
          const rawTarget = val.target || val.value;
          const targetId = (rawTarget !== null && rawTarget !== undefined) ? String(rawTarget) : '';
          const portId = `${objId}:${keyStr}`;
          rowsHtml += `
            <div class="field-row${pulseClass}" data-field="${this.escapeHtml(keyStr)}">
              <span class="field-name">${this.escapeHtml(keyStr)}:</span>
              <span class="port-socket" data-port-id="${this.escapeHtml(portId)}" title="Points to #${this.escapeHtml(targetId)}"></span>
            </div>
          `;
        } else {
          const { displayText, valClass } = this.formatValueDisplay(val);
          rowsHtml += `
            <div class="field-row${pulseClass}" data-field="${this.escapeHtml(keyStr)}">
              <span class="field-name">${this.escapeHtml(keyStr)}:</span>
              <span class="field-value primitive-val ${valClass}">${this.escapeHtml(displayText)}</span>
            </div>
          `;
        }
      });
      bodyHtml = rowsHtml || '<div style="color: #64748b; font-size: 11px;">(empty dict)</div>';
    } else {
      // Attributes / fields
      const attrs = obj.attrs || obj.fields || {};
      let rowsHtml = '';
      for (const [attrName, attrVal] of Object.entries(attrs)) {
        const attrKey = `${objId}:${attrName}`;
        const serialized = JSON.stringify(attrVal);
        currentValuesMap.set(attrKey, serialized);
        const hasChanged = this.prevValuesMap.has(attrKey) && this.prevValuesMap.get(attrKey) !== serialized;
        if (hasChanged) changedKeys.add(attrKey);
        const pulseClass = hasChanged ? ' pulse-change' : '';

        if (attrVal && (attrVal.kind === 'ref' || attrVal.type === 'ref')) {
          const rawTarget = attrVal.target || attrVal.value;
          const targetId = (rawTarget !== null && rawTarget !== undefined) ? String(rawTarget) : '';
          const portId = `${objId}:${attrName}`;
          rowsHtml += `
            <div class="field-row${pulseClass}" data-field="${this.escapeHtml(attrName)}">
              <span class="field-name">${this.escapeHtml(attrName)}:</span>
              <span class="port-socket" data-port-id="${this.escapeHtml(portId)}" title="Points to #${this.escapeHtml(targetId)}"></span>
            </div>
          `;
        } else {
          const { displayText, valClass } = this.formatValueDisplay(attrVal);
          rowsHtml += `
            <div class="field-row${pulseClass}" data-field="${this.escapeHtml(attrName)}">
              <span class="field-name">${this.escapeHtml(attrName)}:</span>
              <span class="field-value primitive-val ${valClass}">${this.escapeHtml(displayText)}</span>
            </div>
          `;
        }
      }
      bodyHtml = rowsHtml || '<div style="color: #64748b; font-size: 11px;">(no fields)</div>';
    }

    const displayId = (obj.id ? String(obj.id) : objId).replace(/^obj[-_]/, '');

    nodeEl.innerHTML = `
      <div class="node-header">
        <div class="node-badge ${badgeClass}">${this.escapeHtml(className)}</div>
        <span class="node-id-tag">#${this.escapeHtml(displayId)}</span>
      </div>
      <div class="node-body">
        ${bodyHtml}
      </div>
    `;
  }

  /**
   * Extracts reference edges from stepData and triggers ArrowRenderer.
   * @param {Object} stepData
   * @param {Set<string>} [changedKeys]
   */
  renderEdgesFromStep(stepData, changedKeys = new Set()) {
    if (!stepData || !this.arrowRenderer) return;

    const edges = [];
    const stack = Array.isArray(stepData.stack) ? stepData.stack : [];
    const heap = (stepData.heap && typeof stepData.heap === 'object') ? stepData.heap : {};

    // 1. Stack frame variables pointing to heap
    stack.forEach((frame, idx) => {
      if (!frame) return;
      const rawId = (frame.frame_id !== undefined && frame.frame_id !== null && frame.frame_id !== '') ? frame.frame_id : idx;
      const frameId = normalizeNodeId(rawId, 'frame');
      const vars = frame.variables || {};
      for (const [varName, varVal] of Object.entries(vars)) {
        if (varVal && (varVal.kind === 'ref' || varVal.type === 'ref')) {
          const rawTarget = varVal.target || varVal.value;
          if (!rawTarget || rawTarget === 'None' || rawTarget === 'null' || rawTarget === 'undefined') continue;
          const targetNodeId = normalizeNodeId(rawTarget, 'obj');
          const sourcePortId = `${frameId}:${varName}`;
          edges.push({
            id: `edge-${sourcePortId}->${targetNodeId}`,
            sourcePortId,
            sourceNodeId: frameId,
            targetNodeId,
            isHighlighted: changedKeys.has(sourcePortId)
          });
        }
      }
      if (frame.return_value && (frame.return_value.kind === 'ref' || frame.return_value.type === 'ref')) {
        const rawTarget = frame.return_value.target || frame.return_value.value;
        if (rawTarget && rawTarget !== 'None' && rawTarget !== 'null' && rawTarget !== 'undefined') {
          const targetNodeId = normalizeNodeId(rawTarget, 'obj');
          const sourcePortId = `${frameId}:__return__`;
          edges.push({
            id: `edge-${sourcePortId}->${targetNodeId}`,
            sourcePortId,
            sourceNodeId: frameId,
            targetNodeId,
            isHighlighted: false,
            isReturn: true
          });
        }
      }
    });

    // 2. Heap object attributes, entries, and collection items pointing to heap
    for (const [rawId, obj] of Object.entries(heap)) {
      if (!obj) continue;
      const objId = normalizeNodeId(rawId, 'obj');

      if ((obj.type === 'list' || obj.type === 'tuple' || obj.type === 'set') && Array.isArray(obj.items)) {
        obj.items.forEach((item, idx) => {
          if (item && (item.kind === 'ref' || item.type === 'ref')) {
            const rawTarget = item.target || item.value;
            if (!rawTarget || rawTarget === 'None' || rawTarget === 'null' || rawTarget === 'undefined') return;
            const targetNodeId = normalizeNodeId(rawTarget, 'obj');
            const sourcePortId = `${objId}:${idx}`;
            edges.push({
              id: `edge-${sourcePortId}->${targetNodeId}`,
              sourcePortId,
              sourceNodeId: objId,
              targetNodeId,
              isHighlighted: changedKeys.has(sourcePortId)
            });
          }
        });
      } else if (obj.type === 'dict' && Array.isArray(obj.entries)) {
        obj.entries.forEach((entry, idx) => {
          const rawKey = (entry && entry.key && entry.key.value !== undefined) ? entry.key.value : (entry?.key ?? idx);
          const keyStr = String(rawKey);
          const val = entry?.value;
          if (val && (val.kind === 'ref' || val.type === 'ref')) {
            const rawTarget = val.target || val.value;
            if (!rawTarget || rawTarget === 'None' || rawTarget === 'null' || rawTarget === 'undefined') return;
            const targetNodeId = normalizeNodeId(rawTarget, 'obj');
            const sourcePortId = `${objId}:${keyStr}`;
            edges.push({
              id: `edge-${sourcePortId}->${targetNodeId}`,
              sourcePortId,
              sourceNodeId: objId,
              targetNodeId,
              isHighlighted: changedKeys.has(sourcePortId)
            });
          }
        });
      } else {
        const attrs = obj.attrs || obj.fields || {};
        for (const [attrName, attrVal] of Object.entries(attrs)) {
          if (attrVal && (attrVal.kind === 'ref' || attrVal.type === 'ref')) {
            const rawTarget = attrVal.target || attrVal.value;
            if (!rawTarget || rawTarget === 'None' || rawTarget === 'null' || rawTarget === 'undefined') continue;
            const targetNodeId = normalizeNodeId(rawTarget, 'obj');
            const sourcePortId = `${objId}:${attrName}`;
            edges.push({
              id: `edge-${sourcePortId}->${targetNodeId}`,
              sourcePortId,
              sourceNodeId: objId,
              targetNodeId,
              isHighlighted: changedKeys.has(sourcePortId)
            });
          }
        }
      }
    }

    this.arrowRenderer.renderEdges(edges);
  }

  /**
   * Helper to return CSS class for primitive values.
   * @param {any} val
   * @returns {string}
   */
  getPrimitiveValClass(val) {
    if (val === null || val === undefined || val === 'None') return 'val-none';
    if (typeof val === 'string' && val.startsWith('"')) return 'val-str';
    if (typeof val === 'boolean' || val === 'True' || val === 'False') return 'val-bool';
    return '';
  }

  /**
   * HTML escape helper.
   * @param {string} str
   * @returns {string}
   */
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
