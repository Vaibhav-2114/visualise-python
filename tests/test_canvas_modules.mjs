/**
 * Unit Test Runner for Milestone 2: Canvas, Drag Mechanics & Dynamic SVG Pointers
 * Run with: node tests/test_canvas_modules.mjs
 */

import { PositionStore } from '../frontend/js/position_store.js';
import { ArrowRenderer } from '../frontend/js/arrows.js';
import { DragManager } from '../frontend/js/drag.js';
import { CanvasManager } from '../frontend/js/canvas.js';

// Minimal Test Runner Infrastructure
let passedTests = 0;
let failedTests = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, error: err });
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
}

function assert(condition, message = 'Assertion failed') {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? message + ': ' : ''}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertApprox(actual, expected, tolerance = 0.001, message = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message ? message + ': ' : ''}Expected ~${expected}, got ${actual} (diff: ${Math.abs(actual - expected)})`);
  }
}

// Lightweight DOM Mock for Node testing of DOM methods
function createMockDomEnvironment() {
  const elements = new Map();

  class MockElement {
    constructor(tagName, id = '', className = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this._classes = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
      const self = this;
      this.classList = {
        add(cls) { self._classes.add(cls); },
        remove(cls) { self._classes.delete(cls); },
        has(cls) { return self._classes.has(cls); },
        contains(cls) { return self._classes.has(cls); },
        toggle(cls) {
          if (self._classes.has(cls)) self._classes.delete(cls);
          else self._classes.add(cls);
        }
      };
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.innerHTML = '';
      this.offsetWidth = 180;
      this.offsetHeight = 120;
      this.offsetLeft = 0;
      this.offsetTop = 0;
      this.eventListeners = new Map();
    }

    get className() {
      return Array.from(this._classes).join(' ');
    }

    set className(val) {
      this._classes = new Set(String(val).split(/\s+/).filter(Boolean));
    }

    setAttribute(key, val) {
      this.attributes.set(key, String(val));
      if (key === 'id') this.id = String(val);
      if (key === 'class') {
        this.className = String(val);
      }
    }

    getAttribute(key) {
      return this.attributes.get(key) || null;
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (child.id) elements.set(child.id, child);
      return child;
    }

    prepend(child) {
      child.parentElement = this;
      this.children.unshift(child);
      if (child.id) elements.set(child.id, child);
      return child;
    }

    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1) this.parentElement.children.splice(idx, 1);
      }
      if (this.id) elements.delete(this.id);
    }

    querySelector(selector) {
      if (selector.startsWith('#')) {
        const id = selector.slice(1);
        return this._findChild((c) => c.id === id);
      }
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return this._findChild((c) => c.classList.contains(cls));
      }
      return this._findChild((c) => c.tagName.toLowerCase() === selector.toLowerCase());
    }

    querySelectorAll(selector) {
      const results = [];
      this._findChildrenAll(selector, results);
      return results;
    }

    _findChild(predicate) {
      for (const child of this.children) {
        if (predicate(child)) return child;
        const found = child._findChild(predicate);
        if (found) return found;
      }
      return null;
    }

    _findChildrenAll(selector, results) {
      const isClass = selector.startsWith('.');
      const isId = selector.startsWith('#');
      const target = isClass || isId ? selector.slice(1) : selector.toLowerCase();

      for (const child of this.children) {
        if (isClass && child.classList.contains(target)) results.push(child);
        else if (isId && child.id === target) results.push(child);
        else if (!isClass && !isId && child.tagName.toLowerCase() === target) results.push(child);
        child._findChildrenAll(selector, results);
      }
    }

    closest(selector) {
      let curr = this;
      const isClass = selector.startsWith('.');
      const cls = isClass ? selector.slice(1) : '';
      while (curr) {
        if (isClass && curr.classList.contains(cls)) return curr;
        curr = curr.parentElement;
      }
      return null;
    }

    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600
      };
    }

    setPointerCapture(pointerId) {
      this._capturedPointerId = pointerId;
    }

    releasePointerCapture(pointerId) {
      this._capturedPointerId = null;
    }

    addEventListener(event, handler) {
      if (!this.eventListeners.has(event)) {
        this.eventListeners.set(event, []);
      }
      this.eventListeners.get(event).push(handler);
    }

    removeEventListener(event, handler) {
      if (this.eventListeners.has(event)) {
        const list = this.eventListeners.get(event);
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    }
  }

  // Setup globals for node environment
  globalThis.document = {
    createElement(tag) { return new MockElement(tag); },
    createElementNS(ns, tag) { return new MockElement(tag); },
    getElementById(id) { return elements.get(id) || null; },
    querySelector(sel) { return null; }
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {}
  };

  const viewport = new MockElement('div', 'canvas-viewport');
  const world = new MockElement('div', 'canvas-world');
  const connectionsLayer = new MockElement('svg', 'connections-layer');
  const nodesLayer = new MockElement('div', 'nodes-layer');

  world.appendChild(connectionsLayer);
  world.appendChild(nodesLayer);
  viewport.appendChild(world);

  return { viewport, world, connectionsLayer, nodesLayer, MockElement };
}

console.log('\n======================================================');
console.log('--- Milestone 2: Canvas & Dynamic Pointer Modules ---');
console.log('======================================================\n');

// ---------------------------------------------------------
// 1. PositionStore Tests
// ---------------------------------------------------------
console.log('[1/5] Testing PositionStore...');

test('PositionStore basic CRUD & retrieval', () => {
  const store = new PositionStore();
  assertEqual(store.has('node1'), false);

  store.set('node1', 120.4, 250.8, false);
  assertEqual(store.has('node1'), true);

  const pos = store.get('node1');
  assertEqual(pos.x, 120);
  assertEqual(pos.y, 251);
  assertEqual(pos.isUserMoved, false);

  store.remove('node1');
  assertEqual(store.has('node1'), false);
  assertEqual(store.get('node1'), undefined);
});

test('PositionStore user manual move flag persistence', () => {
  const store = new PositionStore();
  store.set('node1', 300, 400, true);
  assertEqual(store.get('node1').isUserMoved, true);

  const all = store.getAll();
  assertEqual(all['node1'].isUserMoved, true);
  assertEqual(all['node1'].x, 300);
});

test('PositionStore linked list chain detection', () => {
  const store = new PositionStore();
  const heap = {
    '101': {
      id: '101',
      type: 'instance',
      class_name: 'ListNode',
      attrs: { val: 1, next: { kind: 'ref', target: '102' } }
    },
    '102': {
      id: '102',
      type: 'instance',
      class_name: 'ListNode',
      attrs: { val: 2, next: { kind: 'ref', target: '103' } }
    },
    '103': {
      id: '103',
      type: 'instance',
      class_name: 'ListNode',
      attrs: { val: 3, next: null }
    }
  };

  const chains = store.detectChains(heap);
  assertEqual(chains.length, 1);
  assertEqual(chains[0].length, 3);
  assertEqual(chains[0][0], '101');
  assertEqual(chains[0][1], '102');
  assertEqual(chains[0][2], '103');
});

test('PositionStore chain auto-layout horizontal sequencing', () => {
  const store = new PositionStore();
  const stepData = {
    stack: [
      { frame_id: '0', func_name: 'swapPairs', lineno: 10, variables: {} }
    ],
    heap: {
      'nodeA': {
        id: 'nodeA',
        type: 'instance',
        attrs: { next: { kind: 'ref', target: 'nodeB' } }
      },
      'nodeB': {
        id: 'nodeB',
        type: 'instance',
        attrs: { next: { kind: 'ref', target: 'nodeC' } }
      },
      'nodeC': {
        id: 'nodeC',
        type: 'instance',
        attrs: { next: null }
      }
    }
  };

  store.applyLayout(stepData);

  // Stack frame in left column
  const framePos = store.get('frame-0');
  assert(framePos !== undefined, 'frame-0 should have a position');
  assertEqual(framePos.x, 50);

  // Linked list chain horizontal layout
  const posA = store.get('obj-nodeA');
  const posB = store.get('obj-nodeB');
  const posC = store.get('obj-nodeC');

  assert(posA && posB && posC, 'Chain nodes should be positioned');
  assertEqual(posA.x, 360);
  assertEqual(posB.x, 560);
  assertEqual(posC.x, 760);
  assertEqual(posA.y, 100);
  assertEqual(posB.y, 100);
  assertEqual(posC.y, 100);
});

test('PositionStore preserves manual drag overrides across layout steps', () => {
  const store = new PositionStore();
  const step1 = {
    stack: [],
    heap: {
      '1': { id: '1', attrs: { next: { kind: 'ref', target: '2' } } },
      '2': { id: '2', attrs: { next: null } }
    }
  };
  store.applyLayout(step1);

  // User manually drags node 1 to custom position
  store.set('obj-1', 450, 220, true);

  // Step 2 arrives with an additional node
  const step2 = {
    stack: [],
    heap: {
      '1': { id: '1', attrs: { next: { kind: 'ref', target: '2' } } },
      '2': { id: '2', attrs: { next: { kind: 'ref', target: '3' } } },
      '3': { id: '3', attrs: { next: null } }
    }
  };
  store.applyLayout(step2, false);

  // User position MUST be preserved!
  const pos1 = store.get('obj-1');
  assertEqual(pos1.x, 450, 'User drag X must be preserved');
  assertEqual(pos1.y, 220, 'User drag Y must be preserved');
  assertEqual(pos1.isUserMoved, true);

  // Newly added node 3 receives clean layout
  assert(store.has('obj-3'), 'New node must be laid out');
});

// ---------------------------------------------------------
// 2. ArrowRenderer Tests
// ---------------------------------------------------------
console.log('\n[2/5] Testing ArrowRenderer Dynamic Geometries...');

test('ArrowRenderer forward cubic Bezier curve math', () => {
  const renderer = new ArrowRenderer();
  const path = renderer.generateForwardPath(100, 150, 300, 150);

  assert(path.startsWith('M 100 150 C'), 'Must begin with move to Sx Sy and cubic Bezier command');
  assert(path.endsWith('300 150'), 'Must terminate at Tx Ty');

  // Verify control points dx = 200, half dx = 100 -> C1x = 200, C2x = 200
  assertEqual(path, 'M 100 150 C 200 150, 200 150, 300 150');
});

test('ArrowRenderer backward arch curve for swapped pointers', () => {
  const renderer = new ArrowRenderer();
  const targetRect = { x: 100, y: 150, width: 180, height: 120 };
  const Sx = 500;
  const Sy = 200;

  const path = renderer.generateBackwardArchPath(Sx, Sy, targetRect);

  // Tx should be targetRect.x + width = 280
  // Ty should be targetRect.y + 60 = 210
  // Yarch = min(200, 210) - 60 = 140
  assert(path.startsWith('M 500 200 C 550 140, 330 140, 280 210'), `Backward arch should route overhead: got ${path}`);
});

test('ArrowRenderer self-loop path upward curve', () => {
  const renderer = new ArrowRenderer();
  const nodeRect = { x: 300, y: 200, width: 180, height: 120 };
  const Sx = 480;
  const Sy = 250;

  const path = renderer.generateSelfLoopPath(nodeRect, Sx, Sy);
  assert(path.startsWith('M 480 250 C'), 'Self loop must start at port');
  assert(path.includes('390 200'), 'Self loop must terminate at top edge center (300 + 90 = 390, 200)');
});

test('ArrowRenderer bidirectional cycle separation (NodeA <-> NodeB)', () => {
  const renderer = new ArrowRenderer();
  const edges = [
    { id: 'e1', sourceNodeId: 'A', targetNodeId: 'B' },
    { id: 'e2', sourceNodeId: 'B', targetNodeId: 'A' }
  ];

  const pairs = renderer.detectBidirectionalPairs(edges);
  assertEqual(pairs.get('e1'), 'forward');
  assertEqual(pairs.get('e2'), 'backward');
});

test('ArrowRenderer multi-inbound port staggering distribution', () => {
  const store = new PositionStore();
  store.set('A', 100, 100);
  store.set('B', 100, 250);
  store.set('C', 100, 400);
  store.set('T', 400, 200); // Target node

  const renderer = new ArrowRenderer({ positionStore: store });

  const path1 = renderer.calculateEdgePath(
    { sourcePortId: 'A:ref', sourceNodeId: 'A', targetNodeId: 'T' },
    { inboundIndex: 0, totalInbound: 3 }
  );

  const path2 = renderer.calculateEdgePath(
    { sourcePortId: 'B:ref', sourceNodeId: 'B', targetNodeId: 'T' },
    { inboundIndex: 1, totalInbound: 3 }
  );

  const path3 = renderer.calculateEdgePath(
    { sourcePortId: 'C:ref', sourceNodeId: 'C', targetNodeId: 'T' },
    { inboundIndex: 2, totalInbound: 3 }
  );

  // Extract landing Ty from path strings (last number in "M ... C ... Tx Ty")
  const getTy = (p) => Number(p.trim().split(/\s+/).pop());
  const ty1 = getTy(path1);
  const ty2 = getTy(path2);
  const ty3 = getTy(path3);

  // All 3 landing points must be distinct and monotonically increasing
  assert(ty1 < ty2 && ty2 < ty3, `Target landing notches must be staggered: ${ty1}, ${ty2}, ${ty3}`);
});

// ---------------------------------------------------------
// 3. CanvasManager Viewport & Geometry Tests
// ---------------------------------------------------------
console.log('\n[3/5] Testing CanvasManager Coordinate Transformations & Zoom Invariants...');

test('CanvasManager panBy delta accumulation', () => {
  const { viewport, world } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world });

  assertEqual(manager.panX, 0);
  assertEqual(manager.panY, 0);

  manager.panBy(45, -80);
  assertEqual(manager.panX, 45);
  assertEqual(manager.panY, -80);
});

test('CanvasManager scale clamping [0.25, 2.5]', () => {
  const { viewport, world } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world });

  manager.zoomAt(400, 300, 5.0);
  assertEqual(manager.scale, 2.5, 'Must clamp to maximum scale 2.5');

  manager.zoomAt(400, 300, 0.05);
  assertEqual(manager.scale, 0.25, 'Must clamp to minimum scale 0.25');
});

test('CanvasManager cursor-centered zoom invariant point math', () => {
  const { viewport, world } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world });

  // Initial state: pan=(0,0), scale=1.0
  const cursorX = 400;
  const cursorY = 300;

  // World point before zoom
  const worldBefore = manager.screenToWorld(cursorX, cursorY);
  assertEqual(worldBefore.worldX, 400);
  assertEqual(worldBefore.worldY, 300);

  // Zoom in to 1.75x centered at cursor
  manager.zoomAt(cursorX, cursorY, 1.75);

  // World point after zoom MUST be identical
  const worldAfter = manager.screenToWorld(cursorX, cursorY);
  assertApprox(worldAfter.worldX, worldBefore.worldX, 0.001, 'Cursor worldX invariant');
  assertApprox(worldAfter.worldY, worldBefore.worldY, 0.001, 'Cursor worldY invariant');
});

test('CanvasManager screenToWorld & worldToScreen bidirectionality', () => {
  const { viewport, world } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world });
  manager.panX = 120;
  manager.panY = -60;
  manager.scale = 1.4;

  const originalScreen = { x: 532, y: 318 };
  const worldCoords = manager.screenToWorld(originalScreen.x, originalScreen.y);
  const backToScreen = manager.worldToScreen(worldCoords.worldX, worldCoords.worldY);

  assertApprox(backToScreen.screenX, originalScreen.x, 0.001);
  assertApprox(backToScreen.screenY, originalScreen.y, 0.001);
});

test('CanvasManager fitToView calculates enclosing scale and centered pan', () => {
  const { viewport, world } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world });

  const boxes = [
    { x: 50, y: 50, width: 180, height: 120 },
    { x: 360, y: 100, width: 180, height: 120 },
    { x: 560, y: 100, width: 180, height: 120 }
  ];

  manager.fitToView(boxes);
  assert(manager.scale > 0.25 && manager.scale <= 1.5, `Fitted scale ${manager.scale} in valid range`);
});

// ---------------------------------------------------------
// 4. DragManager Mechanics Tests
// ---------------------------------------------------------
console.log('\n[4/5] Testing DragManager Delta Scaling & Coordinate Mechanics...');

test('DragManager world delta division by scale factor', () => {
  // Scale = 1.0 -> 1:1
  const d1 = DragManager.calculateWorldDelta(100, 50, 1.0);
  assertEqual(d1.deltaX, 100);
  assertEqual(d1.deltaY, 50);

  // Scale = 2.0 (zoomed in) -> movements in world space are halved
  const d2 = DragManager.calculateWorldDelta(100, 50, 2.0);
  assertEqual(d2.deltaX, 50);
  assertEqual(d2.deltaY, 25);

  // Scale = 0.5 (zoomed out) -> movements in world space are doubled
  const d3 = DragManager.calculateWorldDelta(100, 50, 0.5);
  assertEqual(d3.deltaX, 200);
  assertEqual(d3.deltaY, 100);
});

test('DragManager computeNewPosition with scale math', () => {
  const initial = { x: 360, y: 100 };
  const clientDelta = { x: 60, y: -30 };
  const scale = 1.5;

  const newPos = DragManager.computeNewPosition(initial.x, initial.y, clientDelta.x, clientDelta.y, scale);
  // deltaX = 60 / 1.5 = 40 -> 360 + 40 = 400
  // deltaY = -30 / 1.5 = -20 -> 100 - 20 = 80
  assertEqual(newPos.x, 400);
  assertEqual(newPos.y, 80);
});

test('DragManager pointerdown, pointermove, pointerup lifecycle', () => {
  const { nodesLayer, world } = createMockDomEnvironment();
  const store = new PositionStore();
  store.set('node-1', 100, 100);

  let arrowUpdatedNode = null;
  const mockArrowRenderer = {
    updateConnectedArrows(id) { arrowUpdatedNode = id; }
  };

  const nodeEl = document.createElement('div');
  nodeEl.className = 'canvas-node';
  nodeEl.id = 'node-1';
  nodesLayer.appendChild(nodeEl);

  const dragManager = new DragManager({
    canvasManager: { scale: 1.0 },
    positionStore: store,
    arrowRenderer: mockArrowRenderer,
    nodesContainer: nodesLayer
  });

  // 1. Pointer Down
  dragManager.onPointerDown({
    button: 0,
    target: nodeEl,
    clientX: 120,
    clientY: 110,
    pointerId: 1,
    stopPropagation() {}
  });

  assertEqual(dragManager.state.active, true);
  assertEqual(nodeEl.classList.contains('is-dragging'), true);

  // 2. Pointer Move
  dragManager.onPointerMove({
    clientX: 170, // +50px
    clientY: 130  // +20px
  });

  assertEqual(store.get('node-1').x, 150);
  assertEqual(store.get('node-1').y, 120);
  assertEqual(store.get('node-1').isUserMoved, true);
  assertEqual(arrowUpdatedNode, 'node-1', 'Must immediately trigger arrow updates');

  // 3. Pointer Up
  dragManager.onPointerUp({});
  assertEqual(dragManager.state.active, false);
  assertEqual(nodeEl.classList.contains('is-dragging'), false);
});

// ---------------------------------------------------------
// 5. DOM Step Diffing & Structure Tests
// ---------------------------------------------------------
console.log('\n[5/5] Testing DOM Node Diffing, Data Attributes & Pulse Animations...');

test('DOM stack frame node structure & port sockets', () => {
  const { viewport, world, connectionsLayer, nodesLayer } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world, connectionsLayer, nodesLayer });

  const stepData = {
    stack: [
      {
        frame_id: '0',
        func_name: 'swapPairs',
        lineno: 14,
        variables: {
          head: { kind: 'ref', target: 'obj_1' },
          k: { kind: 'primitive', type: 'int', value: 2 }
        }
      }
    ],
    heap: {
      'obj_1': {
        id: 'obj_1',
        class_name: 'ListNode',
        attrs: { val: 1, next: null }
      }
    }
  };

  manager.renderStep(stepData);

  const frameEl = nodesLayer.querySelector('#frame-0');
  assert(frameEl !== null, 'Stack frame element #frame-0 must exist');
  assert(frameEl.classList.contains('canvas-node'), 'Frame must have .canvas-node');
  assert(frameEl.classList.contains('stack-frame'), 'Frame must have .stack-frame');

  // Verify variable table content
  assert(frameEl.innerHTML.includes('head'), 'Frame must contain variable head');
  assert(frameEl.innerHTML.includes('data-port-id="frame-0:head"'), 'Port socket must have data-port-id');
  assert(frameEl.innerHTML.includes('val-none') || frameEl.innerHTML.includes('primitive-val'), 'Primitive values rendered');
});

test('DOM heap object styling and class tagging', () => {
  const { viewport, world, connectionsLayer, nodesLayer } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world, connectionsLayer, nodesLayer });

  const stepData = {
    stack: [],
    heap: {
      '1': { id: '1', class_name: 'ListNode', attrs: { val: 10, next: null } },
      '2': { id: '2', type: 'list', items: [1, 2, 3] }
    }
  };

  manager.renderStep(stepData);

  const listNodeEl = nodesLayer.querySelector('#obj-1');
  assert(listNodeEl !== null, 'ListNode element #obj-1 must exist');
  assert(listNodeEl.classList.contains('class-listnode'), 'ListNode must have .class-listnode');

  const listEl = nodesLayer.querySelector('#obj-2');
  assert(listEl !== null, 'List element #obj-2 must exist');
  assert(listEl.classList.contains('class-list'), 'List must have .class-list');
});

test('DOM step diffing detects value updates and cleans up dead frames', () => {
  const { viewport, world, connectionsLayer, nodesLayer } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world, connectionsLayer, nodesLayer });

  // Step 1: two frames active
  manager.renderStep({
    stack: [
      { frame_id: '0', func_name: '<module>', lineno: 1, variables: { count: 0 } },
      { frame_id: '1', func_name: 'helper', lineno: 5, variables: { x: 10 } }
    ],
    heap: {}
  });

  assert(nodesLayer.querySelector('#frame-0') !== null);
  assert(nodesLayer.querySelector('#frame-1') !== null);

  // Step 2: helper returned, frame 1 gone, count updated to 1
  manager.renderStep({
    stack: [
      { frame_id: '0', func_name: '<module>', lineno: 2, variables: { count: 1 } }
    ],
    heap: {}
  });

  // Dead frame 1 must be removed
  assertEqual(nodesLayer.querySelector('#frame-1'), null, 'Returned frame must be removed');

  // Value change should trigger pulse-change class
  const frame0 = nodesLayer.querySelector('#frame-0');
  assert(frame0.innerHTML.includes('pulse-change'), 'Updated variable must receive pulse-change animation');
});

// ---------------------------------------------------------
// 6. Extended Edge Case & Adversarial Tests
// ---------------------------------------------------------
console.log('\n[6/6] Testing Extended Edge Cases & Graph Topologies...');

test('PositionStore handles multiple disjoint chains', () => {
  const store = new PositionStore();
  const heap = {
    // Chain 1: A -> B
    'A': { id: 'A', attrs: { next: { kind: 'ref', target: 'B' } } },
    'B': { id: 'B', attrs: { next: null } },
    // Chain 2: C -> D -> E
    'C': { id: 'C', attrs: { next: { kind: 'ref', target: 'D' } } },
    'D': { id: 'D', attrs: { next: { kind: 'ref', target: 'E' } } },
    'E': { id: 'E', attrs: { next: null } }
  };

  const chains = store.detectChains(heap);
  assertEqual(chains.length, 2, 'Must detect 2 separate chains');

  store.applyLayout({ stack: [], heap });

  // Chain 1 on row Y=100
  assertEqual(store.get('obj-A').y, 100);
  assertEqual(store.get('obj-B').y, 100);

  // Chain 2 on row Y=250
  assertEqual(store.get('obj-C').y, 250);
  assertEqual(store.get('obj-D').y, 250);
  assertEqual(store.get('obj-E').y, 250);
});

test('PositionStore handles circular linked list safely', () => {
  const store = new PositionStore();
  const heap = {
    '1': { id: '1', attrs: { next: { kind: 'ref', target: '2' } } },
    '2': { id: '2', attrs: { next: { kind: 'ref', target: '3' } } },
    '3': { id: '3', attrs: { next: { kind: 'ref', target: '1' } } } // Cycle back to 1!
  };

  // Must not enter infinite loop
  const chains = store.detectChains(heap);
  assert(chains.length >= 1, 'Should safely extract chain');
  assertEqual(chains[0].length, 3, 'All 3 nodes visited once');
});

test('ArrowRenderer SVG markers initialization', () => {
  const { connectionsLayer } = createMockDomEnvironment();
  const renderer = new ArrowRenderer({ svgContainer: connectionsLayer });

  const defs = connectionsLayer.querySelector('defs');
  assert(defs !== null, '<defs> element must be created');
  assert(defs.querySelector('#arrowhead') !== null, '#arrowhead marker must exist');
  assert(defs.querySelector('#arrowhead-highlight') !== null, '#arrowhead-highlight marker must exist');
  assert(defs.querySelector('#arrowhead-return') !== null, '#arrowhead-return marker must exist');
});

test('ArrowRenderer updateConnectedArrows fast-path only updates connected edges', () => {
  const { connectionsLayer, nodesLayer } = createMockDomEnvironment();
  const store = new PositionStore();
  store.set('A', 100, 100);
  store.set('B', 300, 100);
  store.set('C', 500, 100);
  store.set('D', 700, 100);

  const renderer = new ArrowRenderer({
    svgContainer: connectionsLayer,
    nodesContainer: nodesLayer,
    positionStore: store
  });

  const edges = [
    { id: 'edge-A->B', sourcePortId: 'A:next', sourceNodeId: 'A', targetNodeId: 'B' },
    { id: 'edge-C->D', sourcePortId: 'C:next', sourceNodeId: 'C', targetNodeId: 'D' }
  ];

  renderer.renderEdges(edges);

  const groupAB = connectionsLayer.querySelector('#edge-A->B');
  const groupCD = connectionsLayer.querySelector('#edge-C->D');
  assert(groupAB !== null);
  assert(groupCD !== null);

  const initialD_AB = groupAB.querySelector('.pointer-line').getAttribute('d');
  const initialD_CD = groupCD.querySelector('.pointer-line').getAttribute('d');

  // Move node A to (150, 120)
  store.set('A', 150, 120, true);
  renderer.updateConnectedArrows('A');

  const updatedD_AB = groupAB.querySelector('.pointer-line').getAttribute('d');
  const updatedD_CD = groupCD.querySelector('.pointer-line').getAttribute('d');

  assert(updatedD_AB !== initialD_AB, 'Edge A->B path should update when connected node moves');
  assertEqual(updatedD_CD, initialD_CD, 'Unconnected edge C->D path must NOT change');
});

test('CanvasManager handles empty step data gracefully', () => {
  const { viewport, world, connectionsLayer, nodesLayer } = createMockDomEnvironment();
  const manager = new CanvasManager({ viewport, world, connectionsLayer, nodesLayer });

  // Render null / empty step
  manager.renderStep(null);
  manager.renderStep({});
  manager.renderStep({ stack: [], heap: {} });

  assertEqual(nodesLayer.children.length, 0);
  assertEqual(manager.arrowRenderer.edges.length, 0);
});

console.log('\n======================================================');
console.log(`Results: ${passedTests} passed, ${failedTests} failed.`);
console.log('======================================================\n');

if (failedTests > 0) {
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED SUCCESSFULLY (Exit Code 0).\n');
  process.exit(0);
}
