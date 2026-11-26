/**
 * PositionStore manages canvas node coordinates and persistent manual drag overrides.
 * Includes dynamic-height stack alignment, topological heap layering, linked-list grouping,
 * and bounding-box collision avoidance around user-moved nodes.
 */

export function normalizeNodeId(raw, prefix) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim();
  while (s.startsWith(`${prefix}-`) || s.startsWith(`${prefix}_`)) s = s.slice(prefix.length + 1);
  return `${prefix}-${s}`;
}

export class PositionStore {
  constructor() {
    this.positions = new Map();
  }

  get(id) {
    if (this.positions.has(id)) return { ...this.positions.get(id) };
    const objNorm = normalizeNodeId(id, 'obj');
    if (this.positions.has(objNorm)) return { ...this.positions.get(objNorm) };
    const frameNorm = normalizeNodeId(id, 'frame');
    if (this.positions.has(frameNorm)) return { ...this.positions.get(frameNorm) };
    return undefined;
  }

  set(id, x, y, isUserMoved = false) {
    this.positions.set(id, { x: Math.round(x), y: Math.round(y), isUserMoved: Boolean(isUserMoved) });
  }

  has(id) {
    return this.positions.has(id) || this.positions.has(normalizeNodeId(id, 'obj')) ||
      this.positions.has(normalizeNodeId(id, 'frame'));
  }

  remove(id) {
    return this.positions.delete(id);
  }

  clear() {
    this.positions.clear();
  }

  getAll() {
    const result = {};
    for (const [key, value] of this.positions.entries()) result[key] = { ...value };
    return result;
  }

  isChainLikeObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.class_name === 'ListNode') return true;
    const attrs = obj.attrs || obj.fields || {};
    return Object.prototype.hasOwnProperty.call(attrs, 'next');
  }

  extractHeapOutgoingRefs(obj, objIds, findHeapKey) {
    const targets = [];
    if (!obj || typeof obj !== 'object') return targets;
    const collectRef = (val) => {
      if (val && (val.kind === 'ref' || val.type === 'ref')) {
        const rawTarget = val.target || val.value;
        if (rawTarget) {
          const resolved = findHeapKey(rawTarget);
          if (resolved) targets.push(resolved);
        }
      }
    };
    if ((obj.type === 'list' || obj.type === 'tuple' || obj.type === 'set') && Array.isArray(obj.items)) {
      obj.items.forEach(collectRef);
    } else if (obj.type === 'dict' && Array.isArray(obj.entries)) {
      obj.entries.forEach((entry) => collectRef(entry?.value));
    } else {
      Object.values(obj.attrs || obj.fields || {}).forEach(collectRef);
    }
    return targets;
  }

  detectChains(heap) {
    if (!heap || typeof heap !== 'object') return [];
    const objIds = Object.keys(heap);
    if (objIds.length === 0) return [];
    const nextMap = new Map();
    const inDegree = new Map(objIds.map((id) => [id, 0]));
    const findHeapKey = (targetId) => {
      if (heap[targetId]) return targetId;
      const targetNorm = normalizeNodeId(targetId, 'obj');
      return objIds.find((id) => normalizeNodeId(id, 'obj') === targetNorm) || null;
    };
    for (const [id, obj] of Object.entries(heap)) {
      if (!obj) continue;
      const nextRef = (obj.attrs || obj.fields || {}).next;
      if (nextRef && (nextRef.kind === 'ref' || nextRef.type === 'ref')) {
        const target = findHeapKey(nextRef.target || nextRef.value);
        if (target && target !== id) {
          nextMap.set(id, target);
          inDegree.set(target, (inDegree.get(target) || 0) + 1);
        }
      }
    }
    const visited = new Set();
    const chains = [];
    for (const id of objIds) {
      if (inDegree.get(id) !== 0 || !nextMap.has(id) || visited.has(id)) continue;
      const chain = [];
      let curr = id;
      while (curr && !visited.has(curr) && heap[curr]) {
        visited.add(curr);
        chain.push(curr);
        curr = nextMap.get(curr);
      }
      if (chain.length) chains.push(chain);
    }
    for (const id of objIds) {
      if (visited.has(id) || !nextMap.has(id)) continue;
      const chain = [];
      let curr = id;
      while (curr && !visited.has(curr) && heap[curr]) {
        visited.add(curr);
        chain.push(curr);
        curr = nextMap.get(curr);
      }
      if (chain.length) chains.push(chain);
    }
    return chains;
  }

  rectsOverlap(a, b, pad = 28) {
    return !(a.x + a.width + pad <= b.x || b.x + b.width + pad <= a.x ||
      a.y + a.height + pad <= b.y || b.y + b.height + pad <= a.y);
  }

  resolveCollisionDown(candX, candY, width, height, placedRects, pad = 30) {
    let x = Math.round(candX);
    let y = Math.round(candY);
    for (let attempt = 0; attempt < 60; attempt++) {
      const blocker = placedRects.find((r) => this.rectsOverlap({ x, y, width, height }, r, pad));
      if (!blocker) break;
      y = Math.round(blocker.y + blocker.height + pad);
    }
    return { x, y };
  }

  applyLayout(stepData, resetAll = false, sizeMap = null) {
    if (resetAll) this.clear();
    const stack = stepData && Array.isArray(stepData.stack) ? stepData.stack : [];
    const heap = stepData && typeof stepData.heap === 'object' && stepData.heap ? stepData.heap : {};
    const getSize = (key, isFrame = false) => {
      const measured = sizeMap?.get(key);
      if (measured && measured.width > 0 && measured.height > 0) return measured;
      return isFrame ? { width: 220, height: 120 } : { width: 175, height: 105 };
    };
    const isLocked = (key) => !resetAll && Boolean(this.get(key)?.isUserMoved);
    const placed = [];
    const frames = [];
    stack.forEach((frame, idx) => {
      if (!frame) return;
      const rawId = frame.frame_id !== undefined && frame.frame_id !== null && frame.frame_id !== '' ? frame.frame_id : idx;
      const key = normalizeNodeId(rawId, 'frame');
      frames.push({ key, frame });
      if (isLocked(key)) {
        const pos = this.get(key), size = getSize(key, true);
        placed.push({ id: key, x: pos.x, y: pos.y, ...size });
      }
    });

    const objIds = Object.keys(heap).filter((id) => heap[id]);
    for (const rawId of objIds) {
      const key = normalizeNodeId(rawId, 'obj');
      if (isLocked(key)) {
        const pos = this.get(key), size = getSize(key);
        placed.push({ id: key, x: pos.x, y: pos.y, ...size });
      }
    }

    let frameY = 40;
    let maxStackRight = 260;
    for (const { key } of frames) {
      const size = getSize(key, true);
      if (isLocked(key)) continue;
      const pos = this.resolveCollisionDown(40, frameY, size.width, size.height, placed, 36);
      this.set(key, pos.x, pos.y);
      placed.push({ id: key, ...pos, ...size });
      frameY = pos.y + size.height + 36;
      maxStackRight = Math.max(maxStackRight, pos.x + size.width);
    }
    if (!objIds.length) return this.positions;

    const findHeapKey = (targetId) => {
      if (heap[targetId]) return targetId;
      const normalized = normalizeNodeId(targetId, 'obj');
      return objIds.find((id) => normalizeNodeId(id, 'obj') === normalized) || null;
    };
    const chains = this.detectChains(heap);
    const inChains = new Set(chains.flat());
    const chainGroups = chains.map((nodes) => ({ className: heap[nodes[0]]?.class_name || 'ListNode', nodes: [...nodes] }));
    for (const id of objIds) {
      if (inChains.has(id) || !this.isChainLikeObject(heap[id])) continue;
      const className = heap[id]?.class_name || 'ListNode';
      const group = chainGroups.find((candidate) => candidate.className === className);
      if (group) group.nodes.push(id);
      else chainGroups.push({ className, nodes: [id] });
      inChains.add(id);
    }
    const nonChainIds = objIds.filter((id) => !inChains.has(id));
    const depth = new Map();
    const parent = new Map();
    const queue = [];
    for (const { frame } of frames) {
      for (const val of Object.values(frame.variables || {})) {
        if (val && (val.kind === 'ref' || val.type === 'ref')) {
          const target = findHeapKey(val.target || val.value);
          if (target && !inChains.has(target) && !depth.has(target)) { depth.set(target, 0); queue.push(target); }
        }
      }
      const ret = frame.return_value;
      if (ret && (ret.kind === 'ref' || ret.type === 'ref')) {
        const target = findHeapKey(ret.target || ret.value);
        if (target && !inChains.has(target) && !depth.has(target)) { depth.set(target, 0); queue.push(target); }
      }
    }
    for (const id of nonChainIds) {
      if (!depth.has(id)) { depth.set(id, 0); queue.push(id); }
    }
    while (queue.length) {
      const current = queue.shift();
      const currentDepth = depth.get(current) || 0;
      for (const target of this.extractHeapOutgoingRefs(heap[current], objIds, findHeapKey)) {
        if (inChains.has(target)) continue;
        if ((!depth.has(target) || depth.get(target) < currentDepth + 1) && currentDepth + 1 <= nonChainIds.length) {
          depth.set(target, currentDepth + 1);
          if (!parent.has(target)) parent.set(target, current);
          queue.push(target);
        }
      }
    }

    const heapStartX = Math.max(360, maxStackRight + 115);
    const colGapX = 95;
    const rowGapY = 44;
    const columns = new Map();
    for (const id of nonChainIds) {
      const d = depth.get(id) || 0;
      if (!columns.has(d)) columns.set(d, []);
      columns.get(d).push(id);
    }
    const placedNonChains = new Map();
    let x = heapStartX;
    let maxNonChainRight = heapStartX;
    for (const d of [...columns.keys()].sort((a, b) => a - b)) {
      let y = 40;
      let colRight = x + 170;
      for (const rawId of columns.get(d)) {
        const key = normalizeNodeId(rawId, 'obj'), size = getSize(key);
        if (isLocked(key)) {
          const pos = this.get(key);
          placedNonChains.set(rawId, { x: pos.x, y: pos.y, ...size });
          continue;
        }
        const parentId = parent.get(rawId);
        const preferredY = parentId && placedNonChains.has(parentId)
          ? Math.max(y, placedNonChains.get(parentId).y) : y;
        const pos = this.resolveCollisionDown(x, preferredY, size.width, size.height, placed, rowGapY);
        this.set(key, pos.x, pos.y);
        const rect = { id: key, ...pos, ...size };
        placed.push(rect);
        placedNonChains.set(rawId, rect);
        y = pos.y + size.height + rowGapY;
        colRight = Math.max(colRight, pos.x + size.width);
      }
      maxNonChainRight = Math.max(maxNonChainRight, colRight);
      x = colRight + colGapX;
    }

    if (chainGroups.length) {
      const chainGapX = 85;
      const chainStartX = nonChainIds.length ? maxNonChainRight + colGapX : heapStartX;
      const ownerY = (headId) => {
        for (const id of nonChainIds) {
          if (this.extractHeapOutgoingRefs(heap[id], objIds, findHeapKey).includes(headId) && placedNonChains.has(id)) {
            return placedNonChains.get(id).y;
          }
        }
        return null;
      };
      let rowY = 60;
      for (const group of chainGroups) {
        const owner = group.nodes.length ? ownerY(group.nodes[0]) : null;
        const baseY = owner === null ? rowY : Math.max(40, owner);
        let cursorX = chainStartX;
        let bottom = baseY + 100;
        for (const rawId of group.nodes) {
          const key = normalizeNodeId(rawId, 'obj'), size = getSize(key);
          if (isLocked(key)) {
            const pos = this.get(key);
            if (Math.abs(pos.y - baseY) < 80) cursorX = Math.max(cursorX, pos.x + size.width + chainGapX);
            continue;
          }
          const pos = this.resolveCollisionDown(cursorX, baseY, size.width, size.height, placed, 36);
          this.set(key, pos.x, pos.y);
          placed.push({ id: key, ...pos, ...size });
          cursorX = pos.x + size.width + chainGapX;
          bottom = Math.max(bottom, pos.y + size.height);
        }
        rowY = bottom + 75;
      }
    }
    return this.positions;
  }

  hasCollision(x, y, excludeId) {
    for (const [id, pos] of this.positions.entries()) {
      if (id === excludeId) continue;
      if (Math.abs(pos.x - x) < 180 && Math.abs(pos.y - y) < 130) return true;
    }
    return false;
  }
}
