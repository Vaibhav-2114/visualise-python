/**
 * DragManager handles freeform element dragging using PointerEvents and pointer capture.
 * Converts screen client deltas to world coordinates divided by scale,
 * records manual positions in PositionStore, and updates connected SVG arrows in real time.
 */
export class DragManager {
  /**
   * @param {Object} options
   * @param {import('./canvas.js').CanvasManager} [options.canvasManager]
   * @param {import('./position_store.js').PositionStore} [options.positionStore]
   * @param {import('./arrows.js').ArrowRenderer} [options.arrowRenderer]
   * @param {HTMLElement} [options.nodesContainer]
   */
  constructor(options = {}) {
    this.canvasManager = options.canvasManager || null;
    this.positionStore = options.positionStore || null;
    this.arrowRenderer = options.arrowRenderer || null;
    this.nodesContainer = options.nodesContainer || null;

    /** @type {{ active: boolean, nodeId: string | null, nodeEl: HTMLElement | null, dragStartX: number, dragStartY: number, initialX: number, initialY: number, pointerId: number | null }} */
    this.state = {
      active: false,
      nodeId: null,
      nodeEl: null,
      dragStartX: 0,
      dragStartY: 0,
      initialX: 0,
      initialY: 0,
      pointerId: null
    };

    /** @type {boolean} RAF scheduling flag for 60-144 FPS throttling */
    this.rafPending = false;
    /** @type {{ clientX: number, clientY: number } | null} */
    this.pendingPointerCoords = null;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerCancel.bind(this);

    if (this.nodesContainer) {
      this.init();
    }
  }

  /**
   * Attach delegated pointer events to container.
   */
  init() {
    if (!this.nodesContainer) return;
    this.nodesContainer.addEventListener('pointerdown', this.onPointerDown);
    this.nodesContainer.addEventListener('pointermove', this.onPointerMove);
    this.nodesContainer.addEventListener('pointerup', this.onPointerUp);
    this.nodesContainer.addEventListener('pointercancel', this.onPointerCancel);
  }

  /**
   * Destroy / unbind event listeners.
   */
  destroy() {
    this.finishDrag();
    if (!this.nodesContainer) return;
    this.nodesContainer.removeEventListener('pointerdown', this.onPointerDown);
    this.nodesContainer.removeEventListener('pointermove', this.onPointerMove);
    this.nodesContainer.removeEventListener('pointerup', this.onPointerUp);
    this.nodesContainer.removeEventListener('pointercancel', this.onPointerCancel);
  }

  /**
   * Computes world space delta from client screen delta and canvas scale.
   * @param {number} clientDeltaX
   * @param {number} clientDeltaY
   * @param {number} scale
   * @returns {{ deltaX: number, deltaY: number }}
   */
  static calculateWorldDelta(clientDeltaX, clientDeltaY, scale = 1.0) {
    const s = scale > 0 ? scale : 1.0;
    return {
      deltaX: clientDeltaX / s,
      deltaY: clientDeltaY / s
    };
  }

  /**
   * Computes new world position.
   * @param {number} initialX
   * @param {number} initialY
   * @param {number} clientDeltaX
   * @param {number} clientDeltaY
   * @param {number} scale
   * @returns {{ x: number, y: number }}
   */
  static computeNewPosition(initialX, initialY, clientDeltaX, clientDeltaY, scale = 1.0) {
    const { deltaX, deltaY } = DragManager.calculateWorldDelta(clientDeltaX, clientDeltaY, scale);
    return {
      x: Math.round(initialX + deltaX),
      y: Math.round(initialY + deltaY)
    };
  }

  /**
   * Binds pointer event handlers directly to a node element.
   * @param {HTMLElement} nodeEl
   * @param {string} nodeId
   */
  bindDraggable(nodeEl, nodeId) {
    if (!nodeEl) return;
    nodeEl.dataset.nodeId = nodeId;
  }

  /**
   * Handler for pointerdown event.
   * @param {PointerEvent} e
   */
  onPointerDown(e) {
    // Only handle primary button (left click)
    if (e.button !== 0) return;

    // Ignore interactive sub-elements like buttons or inputs
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('button') || target.closest('input') || target.closest('select')) {
      return;
    }

    const nodeEl = /** @type {HTMLElement} */ (target.closest('.canvas-node'));
    if (!nodeEl) return;

    const nodeId = nodeEl.id || nodeEl.dataset.nodeId;
    if (!nodeId) return;

    // Finish any prior active drag cleanly (e.g. multi-pointer collisions)
    if (this.state.active) {
      this.finishDrag(e);
    }

    // Get current position from positionStore or element style
    let initialX = 0;
    let initialY = 0;
    const stored = this.positionStore?.get(nodeId);
    if (stored) {
      initialX = stored.x;
      initialY = stored.y;
    } else {
      initialX = nodeEl.offsetLeft || 0;
      initialY = nodeEl.offsetTop || 0;
    }

    this.state = {
      active: true,
      nodeId,
      nodeEl,
      dragStartX: e.clientX,
      dragStartY: e.clientY,
      initialX,
      initialY,
      pointerId: e.pointerId
    };

    // Remove animation transition class during active dragging for immediate tracking
    nodeEl.classList.remove('is-animating');
    nodeEl.classList.add('is-dragging');

    // Pointer capture locks mouse movement to this node even outside window
    if (typeof nodeEl.setPointerCapture === 'function') {
      try {
        nodeEl.setPointerCapture(e.pointerId);
      } catch (err) {
        // Fallback for mock environments
      }
    }

    e.stopPropagation();
  }

  /**
   * Handler for pointermove event with RAF throttling.
   * @param {PointerEvent} e
   */
  onPointerMove(e) {
    if (!this.state.active || !this.state.nodeEl) return;

    this.pendingPointerCoords = { clientX: e.clientX, clientY: e.clientY };

    if (typeof requestAnimationFrame === 'function') {
      if (!this.rafPending) {
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.rafPending = false;
          if (!this.state.active || !this.pendingPointerCoords) return;
          this.applyPointerMove(this.pendingPointerCoords.clientX, this.pendingPointerCoords.clientY);
        });
      }
    } else {
      // Direct execution when RAF is not present (e.g. unit test runner)
      this.applyPointerMove(e.clientX, e.clientY);
    }
  }

  /**
   * Apply calculated world delta to active element, position store and arrows.
   * @param {number} clientX
   * @param {number} clientY
   */
  applyPointerMove(clientX, clientY) {
    if (!this.state.active || !this.state.nodeEl) return;

    const scale = this.canvasManager ? this.canvasManager.scale : 1.0;
    const clientDeltaX = clientX - this.state.dragStartX;
    const clientDeltaY = clientY - this.state.dragStartY;

    const { x: newX, y: newY } = DragManager.computeNewPosition(
      this.state.initialX,
      this.state.initialY,
      clientDeltaX,
      clientDeltaY,
      scale
    );

    // Apply transform in world space
    this.state.nodeEl.style.transform = `translate3d(${newX}px, ${newY}px, 0)`;

    // Record position and mark as user manual drag override
    if (this.positionStore && this.state.nodeId) {
      this.positionStore.set(this.state.nodeId, newX, newY, true);
    }

    // Immediately trigger fast redraw of connected SVG arrows
    if (this.arrowRenderer && this.state.nodeId) {
      this.arrowRenderer.updateConnectedArrows(this.state.nodeId);
    }
  }

  /**
   * Handler for pointerup event.
   * @param {PointerEvent} e
   */
  onPointerUp(e) {
    if (!this.state.active) return;
    this.finishDrag(e);
  }

  /**
   * Handler for pointercancel event.
   * @param {PointerEvent} e
   */
  onPointerCancel(e) {
    if (!this.state.active) return;
    this.finishDrag(e);
  }

  /**
   * Cleanup and finalize drag.
   * @param {PointerEvent} [e]
   */
  finishDrag(e) {
    if (this.pendingPointerCoords && this.state.active) {
      this.applyPointerMove(this.pendingPointerCoords.clientX, this.pendingPointerCoords.clientY);
    }
    this.rafPending = false;
    this.pendingPointerCoords = null;

    if (this.state.nodeEl) {
      this.state.nodeEl.classList.remove('is-dragging');

      if (
        this.state.pointerId !== null &&
        typeof this.state.nodeEl.releasePointerCapture === 'function'
      ) {
        try {
          this.state.nodeEl.releasePointerCapture(this.state.pointerId);
        } catch (err) {
          // Fallback
        }
      }
    }

    this.state = {
      active: false,
      nodeId: null,
      nodeEl: null,
      dragStartX: 0,
      dragStartY: 0,
      initialX: 0,
      initialY: 0,
      pointerId: null
    };
  }
}
