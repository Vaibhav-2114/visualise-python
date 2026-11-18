/**
 * PositionStore manages canvas node coordinates and persistent manual drag overrides.
 * Includes intelligent auto-layout with linked-list chain detection and 2D grid placement.
 */

/**
 * Normalizes an ID to canonical form (e.g. obj_1 -> obj-1, frame_0 -> frame-0).
 * Strips redundant prefixes to avoid double prefixing like obj-obj_1.
 * @param {any} raw
 * @param {'obj' | 'frame'} prefix
 * @returns {string}
 */
export function normalizeNodeId(raw, prefix) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim();
  while (s.startsWith(`${prefix}-`) || s.startsWith(`${prefix}_`)) {
    s = s.slice(prefix.length + 1);
  }
  return `${prefix}-${s}`;
}

export class PositionStore {
  constructor() {
    /** @type {Map<string, { x: number, y: number, isUserMoved: boolean }>} */
    this.positions = new Map();
  }

  /**
   * Get position for a given node ID.
   * @param {string} id
   * @returns {{ x: number, y: number, isUserMoved: boolean } | undefined}
   */
  get(id) {
    if (this.positions.has(id)) {
      return { ...this.positions.get(id) };
    }
    const objNorm = normalizeNodeId(id, 'obj');
    if (this.positions.has(objNorm)) {
      return { ...this.positions.get(objNorm) };
    }
    const frameNorm = normalizeNodeId(id, 'frame');
    if (this.positions.has(frameNorm)) {
      return { ...this.positions.get(frameNorm) };
    }
    return undefined;
  }

  /**
   * Set or update position for a given node ID.
   * @param {string} id
   * @param {number} x
   * @param {number} y
   * @param {boolean} [isUserMoved=false]
   */
  set(id, x, y, isUserMoved = false) {
    this.positions.set(id, {
      x: Math.round(x),
      y: Math.round(y),
      isUserMoved: Boolean(isUserMoved)
    });
  }

  /**
   * Check if a position exists for a given node ID.
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    if (this.positions.has(id)) return true;
    const objNorm = normalizeNodeId(id, 'obj');
    if (this.positions.has(objNorm)) return true;
    const frameNorm = normalizeNodeId(id, 'frame');
    return this.positions.has(frameNorm);
  }

  /**
   * Remove position for a given node ID.
   * @param {string} id
   * @returns {boolean}
   */
  remove(id) {
    return this.positions.delete(id);
  }

  /**
   * Clear all stored positions.
   */
  clear() {
    this.positions.clear();
  }

  /**
   * Export all positions as an object.
   * @returns {Record<string, { x: number, y: number, isUserMoved: boolean }>}
   */
  getAll() {
    const result = {};
    for (const [key, value] of this.positions.entries()) {
      result[key] = { ...value };
    }
    return result;
  }

  /**
   * Detects linked list chains from heap objects.
   * Chains are sequences where an object points to another object of the same type via 'next'.
   * @param {Record<string, any>} heap
   * @returns {Array<string[]>} Array of chains, each being an array of object IDs in sequence
   */
  detectChains(heap) {
    if (!heap || typeof heap !== 'object') return [];

    const objIds = Object.keys(heap);
    if (objIds.length === 0) return [];

    /** @type {Map<string, string>} outgoing next pointer: fromId -> toId */
    const nextMap = new Map();
    /** @type {Map<string, number>} in-degree count of next pointers */
    const inDegree = new Map();

    for (const id of objIds) {
      inDegree.set(id, 0);
    }

    const findHeapKey = (targetId) => {
      if (heap[targetId]) return targetId;
      const targetNorm = normalizeNodeId(targetId, 'obj');
      for (const k of objIds) {
        if (normalizeNodeId(k, 'obj') === targetNorm) return k;
      }
      return null;
    };

    for (const [id, obj] of Object.entries(heap)) {
      if (!obj) continue;
      // Check attributes or fields for 'next'
      const attrs = obj.attrs || obj.fields || {};
      const nextRef = attrs.next;
      if (nextRef && (nextRef.kind === 'ref' || nextRef.type === 'ref')) {
        const rawTargetId = nextRef.target || nextRef.value;
        if (rawTargetId) {
          const resolvedTarget = findHeapKey(rawTargetId);
          if (resolvedTarget) {
            nextMap.set(id, resolvedTarget);
            inDegree.set(resolvedTarget, (inDegree.get(resolvedTarget) || 0) + 1);
          }
        }
      }
    }

    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {Array<string[]>} */
    const chains = [];

    // First, start chains from nodes with in-degree 0 that have an outgoing next pointer
    for (const id of objIds) {
      if ((inDegree.get(id) === 0) && nextMap.has(id) && !visited.has(id)) {
        const chain = [];
        let curr = id;
        while (curr && !visited.has(curr) && heap[curr]) {
          visited.add(curr);
          chain.push(curr);
          curr = nextMap.get(curr);
        }
        if (chain.length > 0) {
          chains.push(chain);
        }
      }
    }

    // Next, handle any cycles or remaining connected chains
    for (const id of objIds) {
      if (!visited.has(id) && nextMap.has(id)) {
        const chain = [];
        let curr = id;
        while (curr && !visited.has(curr) && heap[curr]) {
          visited.add(curr);
          chain.push(curr);
          curr = nextMap.get(curr);
        }
        if (chain.length > 0) {
          chains.push(chain);
        }
      }
    }

    return chains;
  }

  /**
   * Applies auto-layout for step data.
   * If resetAll is false, preserves existing positions (especially user-dragged ones).
   * Only assigns new positions for nodes not yet positioned.
   * @param {{ stack?: Array<any>, heap?: Record<string, any> }} stepData
   * @param {boolean} [resetAll=false]
   * @returns {Map<string, { x: number, y: number, isUserMoved: boolean }>}
   */
  applyLayout(stepData, resetAll = false) {
    if (resetAll) {
      this.clear();
    }

    const stack = (stepData && Array.isArray(stepData.stack)) ? stepData.stack : [];
    const heap = (stepData && typeof stepData.heap === 'object' && stepData.heap) ? stepData.heap : {};

    // 1. Arrange Stack Frames in left column
    // Frame IDs formatted as frame-<frame_id> or frame-<index>
    const frameStartX = 50;
    const frameStartY = 50;
    const frameGapY = 170;

    stack.forEach((frame, idx) => {
      if (!frame) return;
      const rawId = (frame.frame_id !== undefined && frame.frame_id !== null && frame.frame_id !== '') ? frame.frame_id : idx;
      const frameKey = normalizeNodeId(rawId, 'frame');
      if (!this.has(frameKey) || (resetAll && !this.get(frameKey)?.isUserMoved)) {
        const yPos = frameStartY + (idx * frameGapY);
        this.set(frameKey, frameStartX, yPos, false);
      }
    });

    // 2. Detect Linked List chains in Heap
    const chains = this.detectChains(heap);
    const chainedNodeIds = new Set();

    let chainRowY = 100;
    chains.forEach((chain) => {
      chain.forEach((nodeId, k) => {
        const objKey = normalizeNodeId(nodeId, 'obj');
        chainedNodeIds.add(objKey);
        if (!this.has(objKey) || (resetAll && !this.get(objKey)?.isUserMoved)) {
          const xPos = 360 + (k * 200);
          this.set(objKey, xPos, chainRowY, false);
        }
      });
      chainRowY += 150;
    });

    // 3. 2D Grid Layout for remaining Heap Objects
    const remainingObjIds = Object.keys(heap).filter((id) => !chainedNodeIds.has(normalizeNodeId(id, 'obj')));
    const gridStartX = 360;
    const gridStartY = Math.max(280, chainRowY);
    const gridColWidth = 240;
    const gridRowHeight = 180;
    const maxCols = 3;

    let gridIndex = 0;
    remainingObjIds.forEach((id) => {
      const objKey = normalizeNodeId(id, 'obj');
      if (!this.has(objKey) || (resetAll && !this.get(objKey)?.isUserMoved)) {
        // Find next non-colliding cell
        let col = gridIndex % maxCols;
        let row = Math.floor(gridIndex / maxCols);
        let candX = gridStartX + (col * gridColWidth);
        let candY = gridStartY + (row * gridRowHeight);

        // Check simple collision with already placed nodes
        while (this.hasCollision(candX, candY, objKey)) {
          gridIndex++;
          col = gridIndex % maxCols;
          row = Math.floor(gridIndex / maxCols);
          candX = gridStartX + (col * gridColWidth);
          candY = gridStartY + (row * gridRowHeight);
        }

        this.set(objKey, candX, candY, false);
        gridIndex++;
      }
    });

    return this.positions;
  }

  /**
   * Helper to detect overlapping nodes in auto-layout.
   * @param {number} x
   * @param {number} y
   * @param {string} excludeId
   * @returns {boolean}
   */
  hasCollision(x, y, excludeId) {
    for (const [id, pos] of this.positions.entries()) {
      if (id === excludeId) continue;
      if (Math.abs(pos.x - x) < 180 && Math.abs(pos.y - y) < 130) {
        return true;
      }
    }
    return false;
  }
}
