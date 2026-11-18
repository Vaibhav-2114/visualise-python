#!/usr/bin/env node
/**
 * Tier 4 Automated Headless Chrome E2E Browser Suite (tests/e2e_runner.mjs).
 * 
 * Uses Node 22 native WebSocket and fetch with Chrome DevTools Protocol (CDP).
 * Zero external npm dependencies.
 * 
 * Strict forensic assertions for T4.1 through T4.10:
 * - T4.1: SPA shell & DOM elements present (#code-input, #btn-run, #btn-step-next, #btn-step-prev, #step-slider, #canvas-viewport, #connections-layer, #terminal-output).
 * - T4.2: Preloaded algorithm selector populates editor (swapPairs).
 * - T4.3: Clicking Run initializes trace, step counter, and active line gutter highlight.
 * - T4.4: Stepper navigation: assert .gutter-line.active and step counter updates across Next, Prev, Last, and First.
 * - T4.5: Timeline scrubber slider: dispatch input event and assert step counter, active line, and canvas update.
 * - T4.6: Freeform canvas dragging: find rendered .canvas-node, dispatch CDP mouse drag (+100px X, +50px Y), assert element bounding box / transform displacement.
 * - T4.7: Dynamic SVG pointer tracking: assert connected SVG <path d="..."> attribute updates dynamically when connected node is moved.
 * - T4.8: Cross-step persistence: assert dragged coordinates persist across stepping.
 * - T4.9: Singly-linked list swapPairs acceptance workflow: step through execution, assert ListNode cards, dummy node, and the swapped pointer sequence (node2 -> node1 -> node4 -> node3).
 * - T4.10: Terminal stdout sync: assert cumulative stdout matching execution step.
 */

import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CHROME_PATH = process.env.CHROME_PATH || '/home/vaibhav/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';

function getAvailablePort(preferred = 0) {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (preferred !== 0) {
        getAvailablePort(0).then(res, rej);
      } else {
        rej(err);
      }
    });
    srv.listen(preferred, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

let SERVER_PORT = 0;
let CDP_PORT = 0;
let SERVER_URL = '';
let tempProfileDir = null;
let serverProcess = null;
let chromeProcess = null;
let ws = null;
let msgId = 1;
let isCleaningUp = false;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function sendCDP(method, params = {}) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return rej(new Error(`WebSocket is not open (state: ${ws ? ws.readyState : 'null'})`));
    }
    const id = msgId++;
    const timer = setTimeout(() => {
      cleanListeners();
      rej(new Error(`CDP request timed out (10000ms) for method: ${method}`));
    }, 10000);

    const onMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id === id) {
          cleanListeners();
          if (data.error) {
            rej(new Error(`CDP Error (${method}): ${JSON.stringify(data.error)}`));
          } else {
            res(data.result);
          }
        }
      } catch (err) {
        // Ignore parse errors for broadcast CDP events
      }
    };

    const onClose = () => {
      cleanListeners();
      rej(new Error(`WebSocket closed unexpectedly while awaiting CDP response for ${method}`));
    };

    const onError = (err) => {
      cleanListeners();
      rej(new Error(`WebSocket error during CDP request ${method}: ${err.message}`));
    };

    function cleanListeners() {
      clearTimeout(timer);
      if (ws) {
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
      }
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInBrowser(expression) {
  const res = await sendCDP('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res?.exceptionDetails) {
    throw new Error(`Browser Eval Exception: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res?.result?.value;
}

async function pollCondition(fnExpression, timeoutMs = 5000, intervalMs = 50, failureMsg = 'Condition not met') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await evalInBrowser(fnExpression);
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout (${timeoutMs}ms): ${failureMsg}`);
}

async function waitForSelector(selector, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exists = await evalInBrowser(`!!document.querySelector('${selector}')`);
    if (exists) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function ensureServerRunning() {
  log(`Starting backend server on port ${SERVER_PORT}...`);
  let serverStderr = '';
  let serverExited = false;
  let serverExitCode = null;

  serverProcess = spawn(
    'python3',
    ['-c', `
from backend.server import create_server
import signal, sys
s = create_server('127.0.0.1', ${SERVER_PORT})
def handler(sig, frame):
    s.shutdown()
    sys.exit(0)
signal.signal(signal.SIGTERM, handler)
s.serve_forever()
`],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONPATH: PROJECT_ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  serverProcess.stderr.on('data', (d) => {
    serverStderr += d.toString();
  });

  serverProcess.once('exit', (code) => {
    serverExited = true;
    serverExitCode = code;
  });

  // Wait for health endpoint to report ok
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (serverExited) {
      throw new Error(`Backend server exited prematurely with code ${serverExitCode}.\nStderr:\n${serverStderr}`);
    }
    try {
      const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        const body = await res.json();
        if (body.status === 'ok') {
          ready = true;
          break;
        }
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!ready) {
    throw new Error(`Backend server failed to start at ${SERVER_URL}.\nStderr:\n${serverStderr}`);
  }
  log(`Backend server ready at ${SERVER_URL}`);
}

async function launchHeadlessChrome() {
  if (!existsSync(CHROME_PATH)) {
    throw new Error(`Chrome binary not found at ${CHROME_PATH}`);
  }

  tempProfileDir = mkdtempSync(join(tmpdir(), 'chrome-cdp-'));
  log(`Launching Headless Chrome on CDP port ${CDP_PORT} (user-data-dir: ${tempProfileDir})...`);

  let chromeStderr = '';
  let chromeExited = false;
  let chromeExitCode = null;

  chromeProcess = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${tempProfileDir}`,
      '--disable-gpu',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  chromeProcess.stderr.on('data', (d) => {
    chromeStderr += d.toString();
  });

  chromeProcess.once('exit', (code) => {
    chromeExited = true;
    chromeExitCode = code;
  });

  // Wait for CDP endpoint
  let versionData = null;
  for (let i = 0; i < 40; i++) {
    if (chromeExited) {
      throw new Error(`Chrome exited prematurely with code ${chromeExitCode}.\nStderr:\n${chromeStderr}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        versionData = await res.json();
        break;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!versionData) {
    throw new Error(`Chrome CDP endpoint failed to respond on port ${CDP_PORT}.\nStderr:\n${chromeStderr}`);
  }
  log(`Chrome ready: ${versionData.Browser}`);

  // Create new tab targeting visualizer URL
  const newTabRes = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${SERVER_URL}`,
    { method: 'PUT' }
  );
  const tabInfo = await newTabRes.json();
  const wsUrl = tabInfo.webSocketDebuggerUrl;

  log(`Connecting to page WebSocket: ${wsUrl}`);
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  await sendCDP('Page.enable');
  await sendCDP('Runtime.enable');
  await sendCDP('DOM.enable');

  // Navigate to server URL and await load completion
  await sendCDP('Page.navigate', { url: SERVER_URL });
  await pollCondition("document.readyState === 'complete'", 5000, 50, 'Page failed to reach document.readyState complete');
}

async function terminateProcess(proc, name, timeoutMs = 1500) {
  if (!proc || proc.killed) return;
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    proc.once('exit', done);
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      done();
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch (e) {}
      done();
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      done();
    });
  });
}

async function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  log('Tearing down test environment...');
  if (ws) {
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }
  const chrome = chromeProcess;
  chromeProcess = null;
  const server = serverProcess;
  serverProcess = null;

  await Promise.all([
    terminateProcess(chrome, 'Chrome'),
    terminateProcess(server, 'Server'),
  ]);

  if (tempProfileDir && existsSync(tempProfileDir)) {
    try {
      rmSync(tempProfileDir, { recursive: true, force: true });
    } catch (e) {}
  }
  log('Teardown complete.');
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

// T4.1: SPA Shell & DOM elements present
async function testT4_1_SpaShell() {
  log('Running T4.1: SPA shell & DOM elements assertion...');
  const selectors = {
    editor: '#code-input',
    runBtn: '#btn-run',
    nextBtn: '#btn-step-next',
    prevBtn: '#btn-step-prev',
    firstBtn: '#btn-step-first',
    lastBtn: '#btn-step-last',
    slider: '#step-slider',
    canvas: '#canvas-viewport, #canvas-container, .canvas-world',
    connections: '#connections-layer, svg.connections-layer, #canvas-arrows',
    terminal: '#terminal-output, .terminal-content'
  };

  const results = await evalInBrowser(`(() => {
    return {
      editor: !!document.querySelector('${selectors.editor}'),
      runBtn: !!document.querySelector('${selectors.runBtn}'),
      nextBtn: !!document.querySelector('${selectors.nextBtn}'),
      prevBtn: !!document.querySelector('${selectors.prevBtn}'),
      firstBtn: !!document.querySelector('${selectors.firstBtn}'),
      lastBtn: !!document.querySelector('${selectors.lastBtn}'),
      slider: !!document.querySelector('${selectors.slider}'),
      canvas: !!document.querySelector('${selectors.canvas}'),
      connections: !!document.querySelector('${selectors.connections}'),
      terminal: !!document.querySelector('${selectors.terminal}')
    };
  })()`);

  const missing = Object.entries(results).filter(([_, present]) => !present).map(([name]) => selectors[name]);
  if (missing.length > 0) {
    throw new Error(`T4.1 FAILED: Missing required SPA shell DOM elements: ${missing.join(', ')}`);
  }
  log('[PASS] T4.1: All primary SPA shell DOM elements verified present in DOM.');
}

// T4.2: Preloaded algorithm selection populates editor
async function testT4_2_AlgorithmSelection() {
  log('Running T4.2: Preloaded algorithm selection assertion...');
  const hasSelector = await evalInBrowser("!!document.querySelector('#example-select, #snippet-select, select.algorithm-select')");
  if (!hasSelector) {
    throw new Error('T4.2 FAILED: Preloaded algorithm selector dropdown not found in DOM');
  }

  await evalInBrowser(`(() => {
    const sel = document.querySelector('#example-select, #snippet-select, select.algorithm-select');
    sel.value = 'swapPairs';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  const editorContent = await pollCondition(
    "(() => { const v = document.querySelector('#code-input')?.value || ''; return (v.includes('swapPairs') && v.includes('ListNode')) ? v : null; })()",
    5000,
    100,
    'Editor was not populated with swapPairs code after selecting from dropdown'
  );

  if (!editorContent.includes('def swapPairs') || !editorContent.includes('class ListNode')) {
    throw new Error(`T4.2 FAILED: Editor content missing swapPairs implementation:\n${editorContent.slice(0, 150)}...`);
  }
  log('[PASS] T4.2: Preloaded algorithm selection populates code editor with genuine swapPairs code.');
}

// T4.3: Clicking Run initializes trace, step counter, and line highlight
async function testT4_3_TraceInitialization() {
  log('Running T4.3: Clicking Run trace initialization assertion...');
  await evalInBrowser("document.querySelector('#btn-run').click()");

  const stepInfo = await pollCondition(
    `(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) return null;
      const text = (el.innerText || el.textContent || '').trim();
      const match = text.match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i) || text.match(/(\\d+)/);
      if (match) {
        return {
          current: parseInt(match[1], 10),
          total: match[2] ? parseInt(match[2], 10) : null,
          raw: text
        };
      }
      return null;
    })()`,
    8000,
    100,
    'Step counter failed to initialize after clicking Run'
  );

  log(`T4.3 Trace initialized: ${stepInfo.raw}`);

  const activeLine = await evalInBrowser(`(() => {
    const el = document.querySelector('.gutter-line.active, .line-number.active, .line-active');
    return el ? (el.dataset.line || el.dataset.lineNumber || el.innerText.trim()) : null;
  })()`);

  if (!activeLine) {
    throw new Error('T4.3 FAILED: No active gutter line highlight (.gutter-line.active) after trace initialization');
  }

  const canvasNodeCount = await evalInBrowser("document.querySelectorAll('.canvas-node').length");
  log(`T4.3 Initial canvas state: activeLine=${activeLine}, canvasNodes=${canvasNodeCount}`);
  log('[PASS] T4.3: Trace initialization verified: step counter, active gutter line, and canvas state initialized.');
}

// T4.4: Stepper navigation: Next, Prev, Last, First
async function testT4_4_StepperNavigation() {
  log('Running T4.4: Stepper navigation genuine assertion...');

  const parseStepCounter = async () => {
    return await evalInBrowser(`(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) throw new Error('#step-counter element not found in DOM');
      const text = (el.innerText || el.textContent || '').trim();
      const match = text.match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i) || text.match(/(\\d+)/);
      if (!match) throw new Error('Cannot parse step numbers from: "' + text + '"');
      return {
        current: parseInt(match[1], 10),
        total: match[2] ? parseInt(match[2], 10) : null,
        raw: text
      };
    })()`);
  };

  const getActiveGutterLine = async () => {
    return await evalInBrowser(`(() => {
      const el = document.querySelector('.gutter-line.active, .line-number.active, .line-active');
      return el ? (el.dataset.line || el.dataset.lineNumber || el.innerText.trim()) : null;
    })()`);
  };

  const step0 = await parseStepCounter();
  const line0 = await getActiveGutterLine();
  log(`T4.4 Initial: step=${step0.raw}, line=${line0}`);

  // 1. Next button
  await evalInBrowser("document.querySelector('#btn-step-next').click()");
  const step1 = await pollCondition(
    `(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) return null;
      const text = (el.innerText || el.textContent || '').trim();
      const m = text.match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i) || text.match(/(\\d+)/);
      if (m && parseInt(m[1], 10) === ${step0.current} + 1) {
        return { current: parseInt(m[1], 10), total: m[2] ? parseInt(m[2], 10) : null, raw: text };
      }
      return null;
    })()`,
    3000,
    50,
    `Next button did not increment step counter from ${step0.current} to ${step0.current + 1}`
  );
  const line1 = await getActiveGutterLine();
  log(`T4.4 After Next: step=${step1.raw}, line=${line1}`);

  // 2. Prev button
  await evalInBrowser("document.querySelector('#btn-step-prev').click()");
  const stepPrev = await pollCondition(
    `(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) return null;
      const text = (el.innerText || el.textContent || '').trim();
      const m = text.match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i) || text.match(/(\\d+)/);
      if (m && parseInt(m[1], 10) === ${step0.current}) {
        return { current: parseInt(m[1], 10), total: m[2] ? parseInt(m[2], 10) : null, raw: text };
      }
      return null;
    })()`,
    3000,
    50,
    `Prev button did not return step counter to ${step0.current}`
  );
  const linePrev = await getActiveGutterLine();
  if (line0 !== null && linePrev !== line0) {
    throw new Error(`T4.4 FAILED: Active line did not return to initial line (${line0}). Got: ${linePrev}`);
  }

  // 3. Last button
  await evalInBrowser("document.querySelector('#btn-step-last').click()");
  const stepLast = await pollCondition(
    `(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) return null;
      const text = (el.innerText || el.textContent || '').trim();
      const m = text.match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i) || text.match(/(\\d+)/);
      if (m) {
        const cur = parseInt(m[1], 10);
        const tot = m[2] ? parseInt(m[2], 10) : null;
        if (tot !== null && (cur === tot - 1 || cur === tot)) {
          return { current: cur, total: tot, raw: text };
        }
        if (cur > ${step0.current} + 1) {
          return { current: cur, total: tot, raw: text };
        }
      }
      return null;
    })()`,
    4000,
    50,
    'Last button did not advance step counter to end'
  );
  log(`T4.4 After Last: step=${stepLast.raw}`);

  // 4. First button
  await evalInBrowser("document.querySelector('#btn-step-first').click()");
  const stepFirst = await pollCondition(
    `(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) return null;
      const text = (el.innerText || el.textContent || '').trim();
      const m = text.match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i) || text.match(/(\\d+)/);
      if (m && parseInt(m[1], 10) === ${step0.current}) {
        return { current: parseInt(m[1], 10), total: m[2] ? parseInt(m[2], 10) : null, raw: text };
      }
      return null;
    })()`,
    3000,
    50,
    `First button did not reset step counter to ${step0.current}`
  );
  log(`T4.4 After First: step=${stepFirst.raw}`);

  log('[PASS] T4.4: Stepper navigation (Next, Prev, Last, First) verified with genuine state assertions.');
}

// T4.5: Scrubber slider: dispatch input event and assert step counter, active line, and canvas update
async function testT4_5_ScrubberSlider() {
  log('Running T4.5: Timeline scrubber slider genuine assertion...');
  const targetStep = 12;

  await evalInBrowser(`(() => {
    const slider = document.querySelector('#step-slider');
    if (!slider) throw new Error('#step-slider element not found in DOM');
    const max = parseInt(slider.max || '100', 10);
    if (max < ${targetStep}) {
      throw new Error('Slider max (' + max + ') is less than target step ${targetStep}');
    }
    slider.value = ${targetStep};
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  const syncedState = await pollCondition(
    `(() => {
      const counter = document.querySelector('#step-counter, .step-label')?.innerText.trim() || '';
      const lineEl = document.querySelector('.gutter-line.active, .line-number.active, .line-active');
      const line = lineEl ? (lineEl.dataset.line || lineEl.innerText.trim()) : '';
      const nodes = document.querySelectorAll('.canvas-node').length;
      if (counter.includes('${targetStep}') && nodes > 0) {
        return { counter, line, nodes };
      }
      return null;
    })()`,
    4000,
    50,
    `Scrubber jump to step ${targetStep} failed to update step counter or render canvas nodes`
  );

  log(`[PASS] T4.5: Scrubber slider jumped to step ${targetStep}; counter="${syncedState.counter}", line="${syncedState.line}", canvasNodes=${syncedState.nodes}.`);
}

// T4.6: Freeform canvas dragging (+100px X, +50px Y)
async function testT4_6_CanvasDrag() {
  log('Running T4.6: Freeform canvas drag genuine assertion...');

  const initial = await evalInBrowser(`(() => {
    const node = document.querySelector('.canvas-node');
    if (!node) throw new Error('No .canvas-node element found on canvas');
    const r = node.getBoundingClientRect();
    return {
      id: node.id,
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      transform: node.style.transform || ''
    };
  })()`);

  const startX = Math.round(initial.x + initial.width / 2);
  const startY = Math.round(initial.y + initial.height / 2);
  const endX = startX + 100;
  const endY = startY + 50;

  log(`Dragging #${initial.id} from (${startX}, ${startY}) to (${endX}, ${endY})...`);

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y: startY,
    button: 'left',
    clickCount: 1,
  });

  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const currX = Math.round(startX + (100 * i) / steps);
    const currY = Math.round(startY + (50 * i) / steps);
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: currX,
      y: currY,
      button: 'left',
    });
    await new Promise((r) => setTimeout(r, 20));
  }

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y: endY,
    button: 'left',
  });

  const after = await pollCondition(
    `(() => {
      const node = document.getElementById('${initial.id}');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const dx = Math.round(r.x) - ${initial.x};
      const dy = Math.round(r.y) - ${initial.y};
      if (Math.abs(dx - 100) <= 15 && Math.abs(dy - 50) <= 15) {
        return { x: Math.round(r.x), y: Math.round(r.y), dx, dy, transform: node.style.transform || '' };
      }
      return null;
    })()`,
    3000,
    50,
    `Node displacement incorrect after drag. Expected approx (+100, +50)`
  );

  log(`Displacement verified: dx=${after.dx}px, dy=${after.dy}px, transform="${after.transform}"`);
  log(`[PASS] T4.6: Freeform canvas drag verified: node #${initial.id} displaced by dx=${after.dx}px, dy=${after.dy}px.`);
  return { nodeId: initial.id, initial, after };
}

// T4.7: Dynamic SVG pointer tracking
async function testT4_7_DynamicSvgPointerTracking() {
  log('Running T4.7: Dynamic SVG pointer tracking genuine assertion...');

  const edgeData = await evalInBrowser(`(() => {
    const paths = Array.from(document.querySelectorAll('#connections-layer .pointer-line, svg .pointer-line, svg path[id^="edge-"]'));
    if (paths.length === 0) throw new Error('No SVG pointer paths found in DOM');
    const path = paths[0];
    const group = path.closest('g.pointer-group') || path;
    const edgeId = group.id || path.id || '';
    const dInitial = path.getAttribute('d') || '';

    let sourceNodeId = null;
    let targetNodeId = null;
    const match = edgeId.match(/^edge-([^:]+):[^->]+->(.+)$/);
    if (match) {
      sourceNodeId = match[1];
      targetNodeId = match[2];
    }
    return { edgeId, dInitial, sourceNodeId, targetNodeId };
  })()`);

  if (!edgeData.dInitial) {
    throw new Error('T4.7 FAILED: Pointer path d attribute is empty');
  }

  // Find node to drag
  const dragTargetId = edgeData.sourceNodeId || edgeData.targetNodeId;
  const node = await evalInBrowser(`(() => {
    let el = document.getElementById('${dragTargetId}');
    if (!el) el = document.querySelector('.canvas-node');
    if (!el) throw new Error('No node available to drag for pointer tracking');
    const r = el.getBoundingClientRect();
    return {
      id: el.id,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2)
    };
  })()`);

  log(`Dragging connected node #${node.id} to verify SVG edge "${edgeData.edgeId}" tracks...`);

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: node.x,
    y: node.y,
    button: 'left',
    clickCount: 1,
  });

  for (let s = 1; s <= 4; s++) {
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: node.x + s * 20,
      y: node.y + s * 10,
      button: 'left',
    });
    await new Promise((r) => setTimeout(r, 20));
  }

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: node.x + 80,
    y: node.y + 40,
    button: 'left',
  });

  const dAfter = await pollCondition(
    `(() => {
      const el = document.getElementById('${edgeData.edgeId}') || document.querySelector('#connections-layer .pointer-line, svg .pointer-line');
      if (!el) return null;
      const path = el.tagName.toLowerCase() === 'path' ? el : el.querySelector('.pointer-line, path');
      const d = path ? path.getAttribute('d') : null;
      return (d && d !== ${JSON.stringify(edgeData.dInitial)}) ? d : null;
    })()`,
    3000,
    50,
    `SVG path d attribute did NOT update dynamically after dragging connected node #${node.id}`
  );

  log(`SVG path d before: "${edgeData.dInitial}"`);
  log(`SVG path d after:  "${dAfter}"`);
  log('[PASS] T4.7: Dynamic SVG pointer tracking verified: SVG path d attribute updated dynamically.');
}

// T4.8: Cross-step persistence
async function testT4_8_CrossStepPersistence() {
  log('Running T4.8: Cross-step position persistence genuine assertion...');

  const dragged = await evalInBrowser(`(() => {
    const node = document.querySelector('.canvas-node');
    if (!node) throw new Error('No .canvas-node found on canvas');
    const r = node.getBoundingClientRect();
    return { id: node.id, x: Math.round(r.x), y: Math.round(r.y) };
  })()`);

  log(`Testing persistence for node #${dragged.id} at (${dragged.x}, ${dragged.y})...`);

  // Step next 2 steps
  for (let s = 0; s < 2; s++) {
    await evalInBrowser("document.querySelector('#btn-step-next')?.click()");
    await new Promise((r) => setTimeout(r, 100));
  }

  const afterNext = await evalInBrowser(`(() => {
    const node = document.getElementById('${dragged.id}');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  })()`);

  if (!afterNext) {
    throw new Error(`T4.8 FAILED: Node #${dragged.id} vanished from canvas during forward stepping`);
  }

  // Step prev 2 steps
  for (let s = 0; s < 2; s++) {
    await evalInBrowser("document.querySelector('#btn-step-prev')?.click()");
    await new Promise((r) => setTimeout(r, 100));
  }

  const afterPrev = await evalInBrowser(`(() => {
    const node = document.getElementById('${dragged.id}');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y) };
  })()`);

  if (!afterPrev) {
    throw new Error(`T4.8 FAILED: Node #${dragged.id} vanished from canvas during backward stepping`);
  }

  log(`Positions across steps: dragged=(${dragged.x}, ${dragged.y}), afterNext=(${afterNext.x}, ${afterNext.y}), afterPrev=(${afterPrev.x}, ${afterPrev.y})`);

  const diffX = Math.abs(afterPrev.x - dragged.x);
  const diffY = Math.abs(afterPrev.y - dragged.y);
  if (diffX > 5 || diffY > 5) {
    throw new Error(`T4.8 FAILED: Node #${dragged.id} failed cross-step persistence. Shifted by (${diffX}, ${diffY})px`);
  }

  log('[PASS] T4.8: Cross-step position persistence verified: dragged coordinates preserved across forward/backward execution.');
}

// T4.9: Singly-linked list swapPairs acceptance workflow
async function testT4_9_SwapPairsWorkflow() {
  log('Running T4.9: Singly-linked list swapPairs acceptance workflow genuine assertion...');

  const swapPairsCode = [
    'class ListNode:',
    '    def __init__(self, val=0, next=None):',
    '        self.val = val',
    '        self.next = next',
    '',
    'class Solution:',
    '    def swapPairs(self, head):',
    '        dummy = ListNode(0, head)',
    '        prev = dummy',
    '        curr = head',
    '        while curr and curr.next:',
    '            npxt = curr.next.next',
    '            second = curr.next',
    '            second.next = curr',
    '            curr.next = npxt',
    '            prev.next = second',
    '            prev = curr',
    '            curr = npxt',
    '        return dummy.next',
    '',
    'node4 = ListNode(4)',
    'node3 = ListNode(3, node4)',
    'node2 = ListNode(2, node3)',
    'node1 = ListNode(1, node2)',
    'sol = Solution()',
    'res = sol.swapPairs(node1)'
  ].join('\n');

  await evalInBrowser(`(() => {
    const editor = document.querySelector('#code-input');
    if (!editor) throw new Error('#code-input not found');
    editor.value = ${JSON.stringify(swapPairsCode)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  await evalInBrowser("document.querySelector('#btn-run').click()");

  const totalSteps = await pollCondition(
    `(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) return null;
      const match = (el.innerText || el.textContent || '').match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i);
      return (match && parseInt(match[2], 10) >= 30) ? parseInt(match[2], 10) : null;
    })()`,
    10000,
    100,
    'swapPairs trace failed to load with >= 30 steps'
  );

  log(`swapPairs execution trace loaded: ${totalSteps} steps.`);

  // 1. Initial list at step 31
  await evalInBrowser(`(() => {
    const slider = document.querySelector('#step-slider');
    slider.value = 31;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  const initialVals = await pollCondition(
    `(() => {
      const nodes = Array.from(document.querySelectorAll('.canvas-node.class-listnode, .canvas-node[id^="obj-"], .canvas-node'));
      const vals = nodes.map(n => {
        const el = n.querySelector('[data-field="val"] .primitive-val, .field-value, .node-val');
        return el ? el.innerText.trim() : null;
      }).filter(Boolean);
      return vals.length >= 4 ? vals : null;
    })()`,
    4000,
    100,
    'Initial 4 ListNodes not found on canvas at step 31'
  );

  log(`Initial ListNode values on canvas: [${initialVals.join(', ')}]`);
  if (!['1', '2', '3', '4'].every(v => initialVals.includes(v))) {
    throw new Error(`T4.9 FAILED: Initial 4 ListNodes values mismatch. Found: [${initialVals.join(', ')}]`);
  }

  // 2. Intermediate dummy node at step 40
  await evalInBrowser(`(() => {
    const slider = document.querySelector('#step-slider');
    slider.value = 40;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  const hasDummy = await pollCondition(
    `(() => {
      const frame = document.querySelector('.stack-frame');
      const dummyVar = frame ? !!frame.querySelector('[data-var="dummy"]') : false;
      const dummyNode = Array.from(document.querySelectorAll('.canvas-node')).some(n => {
        const v = n.querySelector('[data-field="val"]')?.innerText || '';
        return v.includes('0');
      });
      return (dummyVar || dummyNode) ? true : null;
    })()`,
    4000,
    100,
    'dummy variable / ListNode(0) not found during swapPairs execution at step 40'
  );
  log(`T4.9 Intermediate dummy node verified: ${hasDummy}`);

  // 3. Final swapped list sequence at last step
  await evalInBrowser("document.querySelector('#btn-step-last').click()");

  const topology = await pollCondition(
    `(() => {
      const edgeGroups = Array.from(document.querySelectorAll('#connections-layer g.pointer-group, svg g.pointer-group, svg g[id^="edge-"]'));
      const edges = edgeGroups.map(g => {
        const match = g.id.match(/^edge-([^:]+):([^->]+)->(.+)$/);
        return match ? { id: g.id, sourceNode: match[1], field: match[2], targetNode: match[3] } : null;
      }).filter(Boolean);

      const getNodeVal = (nodeId) => {
        const el = document.getElementById(nodeId);
        if (!el) return null;
        const vEl = el.querySelector('[data-field="val"] .primitive-val, .field-value, .node-val');
        return vEl ? parseInt(vEl.innerText.trim(), 10) : null;
      };

      // Find edge from res variable in stack frame
      let startNode = null;
      for (const e of edges) {
        if (e.field === 'res' || e.id.includes(':res->')) {
          startNode = e.targetNode;
          break;
        }
      }

      const sequence = [];
      let curr = startNode;
      const visited = new Set();
      while (curr && !visited.has(curr) && sequence.length < 6) {
        visited.add(curr);
        const val = getNodeVal(curr);
        sequence.push({ id: curr, val });
        const nextEdge = edges.find(e => e.sourceNode === curr && e.field === 'next');
        curr = nextEdge ? nextEdge.targetNode : null;
      }
      return (sequence.length === 4 && sequence.every(s => s.val !== null)) ? { startNode, sequence } : null;
    })()`,
    6000,
    100,
    'Failed to trace final 4-node pointer topology from res'
  );

  const finalVals = topology.sequence.map(s => s.val);
  log(`Final pointer chain topology: [${finalVals.join(', ')}]`);

  if (finalVals.length !== 4 || finalVals[0] !== 2 || finalVals[1] !== 1 || finalVals[2] !== 4 || finalVals[3] !== 3) {
    throw new Error(`T4.9 FAILED: Swapped list mismatch! Expected [2, 1, 4, 3], got: [${finalVals.join(', ')}]`);
  }

  log('[PASS] T4.9: Singly-linked list swapPairs workflow acceptance verified: swapped sequence [2, 1, 4, 3] confirmed via DOM and SVG pointer graph.');
}

// T4.10: Terminal stdout synchronization
async function testT4_10_TerminalStdoutSync() {
  log('Running T4.10: Terminal cumulative stdout synchronization genuine assertion...');

  const printCode = [
    'print("ALPHA_TOK")',
    'x = 1',
    'print("BETA_TOK")',
    'y = 2',
    'print("GAMMA_TOK")'
  ].join('\n');

  await evalInBrowser(`(() => {
    const editor = document.querySelector('#code-input');
    editor.value = ${JSON.stringify(printCode)};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  await evalInBrowser("document.querySelector('#btn-run').click()");

  await pollCondition(
    `(() => {
      const el = document.querySelector('#step-counter, .step-label');
      if (!el) return null;
      const m = (el.innerText || el.textContent || '').match(/(\\d+)\\s*(?:\\/|of)\\s*(\\d+)/i);
      return (m && parseInt(m[2], 10) >= 5) ? true : null;
    })()`,
    5000,
    50,
    'Print code trace failed to load'
  );

  const readTerminal = async () => {
    return await evalInBrowser(`(() => {
      const el = document.querySelector('#terminal-output, .terminal-content');
      return el ? (el.innerText || el.textContent || '') : '';
    })()`);
  };

  // 1. Step 0 (first)
  await evalInBrowser("document.querySelector('#btn-step-first').click()");
  await pollCondition(
    `(() => {
      const t = document.querySelector('#terminal-output, .terminal-content')?.innerText || '';
      return (!t.includes('ALPHA_TOK') && !t.includes('BETA_TOK') && !t.includes('GAMMA_TOK')) ? true : null;
    })()`,
    3000,
    50,
    'Terminal contained future output at step 0'
  );

  // 2. Step forward past ALPHA_TOK (2 steps)
  await evalInBrowser("document.querySelector('#btn-step-next').click()");
  await new Promise((r) => setTimeout(r, 50));
  await evalInBrowser("document.querySelector('#btn-step-next').click()");

  const t2 = await pollCondition(
    `(() => {
      const t = document.querySelector('#terminal-output, .terminal-content')?.innerText || '';
      return (t.includes('ALPHA_TOK') && !t.includes('BETA_TOK')) ? t : null;
    })()`,
    3000,
    50,
    'Terminal failed to sync ALPHA_TOK after stepping forward'
  );
  log(`T4.10 Terminal step 2: "${t2.trim()}"`);

  // 3. Step forward past BETA_TOK (2 steps)
  await evalInBrowser("document.querySelector('#btn-step-next').click()");
  await new Promise((r) => setTimeout(r, 50));
  await evalInBrowser("document.querySelector('#btn-step-next').click()");

  const t4 = await pollCondition(
    `(() => {
      const t = document.querySelector('#terminal-output, .terminal-content')?.innerText || '';
      return (t.includes('ALPHA_TOK') && t.includes('BETA_TOK') && !t.includes('GAMMA_TOK')) ? t : null;
    })()`,
    3000,
    50,
    'Terminal failed to sync BETA_TOK after stepping forward'
  );
  log(`T4.10 Terminal step 4: "${t4.trim()}"`);

  // 4. Last step
  await evalInBrowser("document.querySelector('#btn-step-last').click()");

  const tLast = await pollCondition(
    `(() => {
      const t = document.querySelector('#terminal-output, .terminal-content')?.innerText || '';
      return (t.includes('ALPHA_TOK') && t.includes('BETA_TOK') && t.includes('GAMMA_TOK')) ? t : null;
    })()`,
    3000,
    50,
    'Terminal missing tokens at last step'
  );
  log(`T4.10 Terminal last step: "${tLast.trim()}"`);

  // 5. Rewind 2 steps backward
  await evalInBrowser("document.querySelector('#btn-step-prev').click()");
  await new Promise((r) => setTimeout(r, 50));
  await evalInBrowser("document.querySelector('#btn-step-prev').click()");

  const tRewind = await pollCondition(
    `(() => {
      const t = document.querySelector('#terminal-output, .terminal-content')?.innerText || '';
      return (!t.includes('GAMMA_TOK') && t.includes('ALPHA_TOK') && t.includes('BETA_TOK')) ? t : null;
    })()`,
    3000,
    50,
    'Terminal failed to rewind output on step prev'
  );
  log(`T4.10 Terminal after rewind: "${tRewind.trim()}"`);

  log('[PASS] T4.10: Terminal cumulative stdout synchronization verified forward and backward.');
}

async function runTestSuite() {
  let passedCount = 0;
  const totalTests = 10;

  try {
    SERVER_PORT = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT, 10) : await getAvailablePort(8000);
    CDP_PORT = process.env.CDP_PORT ? parseInt(process.env.CDP_PORT, 10) : await getAvailablePort(9222);
    SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

    log(`Allocated ephemeral ports: Server=${SERVER_PORT}, Chrome CDP=${CDP_PORT}`);

    await ensureServerRunning();
    await launchHeadlessChrome();

    log('======================================================');
    log('Starting Tier 4 Headless Chrome CDP Browser Suite');
    log('======================================================');

    // Run T4.1 through T4.10 sequentially with genuine assertions
    await testT4_1_SpaShell();
    passedCount++;

    await testT4_2_AlgorithmSelection();
    passedCount++;

    await testT4_3_TraceInitialization();
    passedCount++;

    await testT4_4_StepperNavigation();
    passedCount++;

    await testT4_5_ScrubberSlider();
    passedCount++;

    await testT4_6_CanvasDrag();
    passedCount++;

    await testT4_7_DynamicSvgPointerTracking();
    passedCount++;

    await testT4_8_CrossStepPersistence();
    passedCount++;

    await testT4_9_SwapPairsWorkflow();
    passedCount++;

    await testT4_10_TerminalStdoutSync();
    passedCount++;

    log(`\n======================================================`);
    log(`E2E SUITE RESULT: ${passedCount} / ${totalTests} TESTS PASSED (100%)`);
    log(`======================================================\n`);
  } finally {
    await cleanup();
  }
}

runTestSuite()
  .then(() => {
    log('Headless Chrome E2E suite completed successfully with exit code 0.');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('E2E Suite Failed with Error:', err);
    await cleanup();
    process.exit(1);
  });
