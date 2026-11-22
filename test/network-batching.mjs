// Start the app on localhost:3211 first. Run after other GPU tests have finished.
// Optional: UPSTREAM_URL, BATCH_LATENCY_MS (default 40), PLAYWRIGHT_MODULE, GPU_ARGS.
// This is a simulated-latency benchmark on one computer, not a phone benchmark.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';

const upstream = new URL(process.env.UPSTREAM_URL || 'http://127.0.0.1:3211');
assert.ok(upstream.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname), 'Use a local HTTP coordinator for controlled latency.');
assert.ok(!upstream.username && !upstream.password && !upstream.search && !upstream.hash && upstream.pathname === '/', 'UPSTREAM_URL must be a plain local origin.');
const latencyMs = Number(process.env.BATCH_LATENCY_MS ?? 40);
assert.ok(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 2000, 'BATCH_LATENCY_MS must be between 0 and 2000.');
const settings = { width: 256, height: 256, samples: 32, bounces: 4 };
const expectedTiles = 64;
const directory = new URL('../artifacts/', import.meta.url);
const report = {
  status: 'running', checkedAt: new Date().toISOString(), upstream: upstream.origin,
  label: 'Simulated WebSocket latency; one computer and one hardware GPU',
  network: {
    addedOneWayLatencyMs: latencyMs, addedRoundTripLatencyMs: latencyMs * 2,
    scope: 'Application WebSocket messages only. HTTP, handshake, ping/pong, bandwidth, packet loss and jitter are not simulated.',
  },
  workload: { scene: 'Orbit', ...settings, tiles: expectedTiles },
  method: 'One Chromium process, two pages on the same GPU, one active render at a time. One warmup per mode, then three alternating measured runs per mode.',
  metric: 'Coordinator elapsed time from render start to receipt of the final tile; browser setup, downloads and warmup are excluded.',
  warmups: [], runs: [], errors: [],
};
const measurements = new Map();
const timers = new Set(), sockets = new Set();
const observedDelay = { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
let shuttingDown = false, browser;

const proxy = http.createServer((req, res) => {
  // Preserve Host and Origin together so the app's normal same-origin check runs.
  const outgoing = http.request(new URL(req.url, upstream), { method: req.method, headers: req.headers }, incoming => {
    res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
  });
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Local upstream unavailable.'); });
  req.on('aborted', () => outgoing.destroy());
  req.pipe(outgoing);
});
const websocketProxy = new WebSocketServer({ noServer: true });
function counters(roomId, runId) {
  const key = `${roomId}:${runId}`;
  if (!measurements.has(key)) measurements.set(key, {
    jobAssignmentMessages: 0, assignedTiles: 0, assignmentBytes: 0,
    tileResultMessages: 0, tileResultBytes: 0,
  });
  return measurements.get(key);
}
function countFrame(connection, direction, data, binary) {
  if (binary) {
    if (direction === 'up' && connection.roomId && data.length >= 16) {
      const run = counters(connection.roomId, data.readUInt32LE(0));
      run.tileResultMessages++; run.tileResultBytes += data.length;
    }
    return;
  }
  let message;
  try { message = JSON.parse(data.toString()); } catch { return; }
  // Never retain or log the hello token or any full message payload.
  if (direction === 'up' && message.type === 'hello') connection.roomId = message.roomId;
  if (direction === 'down' && connection.roomId && ['job', 'jobs'].includes(message.type)) {
    const jobs = message.jobs || [message.job], run = counters(connection.roomId, jobs[0].runId);
    run.jobAssignmentMessages++; run.assignedTiles += jobs.length; run.assignmentBytes += data.length;
  }
}
function delayFrame(connection, target, direction, data, binary) {
  countFrame(connection, direction, data, binary);
  const receivedAt = performance.now();
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (target.readyState !== WebSocket.OPEN) return;
    const actual = performance.now() - receivedAt;
    observedDelay.count++; observedDelay.totalMs += actual;
    observedDelay.minMs = Math.min(observedDelay.minMs, actual);
    observedDelay.maxMs = Math.max(observedDelay.maxMs, actual);
    target.send(data, { binary }, error => { if (error && !shuttingDown) report.errors.push('Proxy frame delivery failed.'); });
  }, latencyMs);
  timers.add(timer);
}
proxy.on('upgrade', (req, rawSocket, head) => {
  if (req.url !== '/ws') { rawSocket.destroy(); return; }
  const endpoint = new URL('/ws', upstream); endpoint.protocol = 'ws:';
  const serverSocket = new WebSocket(endpoint, {
    headers: { Host: req.headers.host }, origin: req.headers.origin, handshakeTimeout: 10000,
  });
  sockets.add(serverSocket);
  rawSocket.on('error', () => {});
  serverSocket.on('error', () => { if (!shuttingDown) report.errors.push('Proxy upstream WebSocket failed.'); rawSocket.destroy(); });
  serverSocket.once('open', () => {
    if (rawSocket.destroyed) { serverSocket.terminate(); return; }
    websocketProxy.handleUpgrade(req, rawSocket, head, clientSocket => {
      sockets.add(clientSocket);
      const connection = { roomId: null };
      clientSocket.on('message', (data, binary) => delayFrame(connection, serverSocket, 'up', data, binary));
      serverSocket.on('message', (data, binary) => delayFrame(connection, clientSocket, 'down', data, binary));
      clientSocket.on('error', () => { if (!shuttingDown) report.errors.push('Proxy browser WebSocket failed.'); });
      clientSocket.on('close', () => { sockets.delete(clientSocket); serverSocket.terminate(); });
      serverSocket.on('close', () => { sockets.delete(serverSocket); clientSocket.terminate(); });
    });
  });
});

async function until(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for benchmark state.');
}
async function state(roomId) {
  const response = await fetch(new URL(`/api/rooms/${roomId}`, upstream), { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, 'Room state must remain available.');
  return response.json();
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  const health = await fetch(new URL('/healthz', upstream), { signal: AbortSignal.timeout(10000) });
  assert.ok(health.ok, 'Start the app on UPSTREAM_URL before running this benchmark.');
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, args: JSON.parse(process.env.GPU_ARGS || '[]') });
  report.chromiumVersion = browser.version();
  const modes = [];
  for (const batchSize of [1, 4]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
    await page.goto(`${base}/${batchSize === 1 ? '?batch=1' : ''}`);
    await page.waitForFunction(() => document.querySelector('#connection')?.textContent === 'Live connection');
    const roomId = (await page.locator('#room-code').textContent()).trim();
    const adapter = await page.evaluate(async () => {
      const gpu = await navigator.gpu?.requestAdapter();
      return gpu ? {
        vendor: gpu.info.vendor, architecture: gpu.info.architecture,
        device: gpu.info.device, description: gpu.info.description,
        isFallbackAdapter: gpu.info.isFallbackAdapter ?? gpu.isFallbackAdapter ?? null,
      } : null;
    });
    assert.ok(adapter, 'This benchmark requires an actual WebGPU adapter.');
    assert.equal(adapter.isFallbackAdapter, false, 'Fallback/software adapters cannot establish hardware GPU timing.');
    assert.doesNotMatch(JSON.stringify(adapter), /swiftshader|llvmpipe|lavapipe|software/i, 'A software GPU cannot establish hardware timing.');
    if (report.adapter) assert.deepEqual(adapter, report.adapter, 'Both pages must use the same GPU.');
    else report.adapter = adapter;
    await page.locator('[data-preset=orbit]').click();
    await page.selectOption('#resolution', String(settings.width));
    await page.selectOption('#samples', String(settings.samples));
    await page.locator('#device-name').fill(`Batch ${batchSize} GPU`);
    await page.locator('#contribute-button').click();
    await page.waitForFunction(() => document.querySelector('#backend-tag')?.textContent === 'WEBGPU');
    await until(async () => {
      const room = await state(roomId), worker = room.clients.find(client => client.enabled);
      return worker?.backend === 'webgpu' && worker.batchSize === batchSize;
    });
    modes.push({ batchSize, page, roomId });
  }

  async function render(mode, phase, iteration) {
    const { page, roomId, batchSize } = mode;
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelector('#backend-tag')?.textContent === 'WEBGPU');
    const before = await until(async () => {
      const room = await state(roomId);
      return room.clients.filter(client => client.enabled && client.backend === 'webgpu').length === 1 && room;
    });
    await page.locator('#render-button').click();
    await page.waitForFunction(() => document.querySelector('#render-status')?.textContent === 'RENDERING');
    await page.waitForFunction(() => document.querySelector('#render-status')?.textContent === 'COMPLETE', null, { timeout: 120000 });
    const complete = await state(roomId), run = complete.history[0];
    assert.equal(run.runId, (before.run?.id || 0) + 1);
    assert.equal(complete.run.status, 'complete');
    assert.deepEqual(complete.run.settings, settings);
    assert.equal(run.backends, 'webgpu');
    assert.equal(await page.locator('#backend-tag').textContent(), 'WEBGPU');
    assert.equal(run.workers, 1); assert.equal(run.tiles, expectedTiles); assert.equal(run.retries, 0);
    const pixels = await page.locator('#render-canvas').evaluate(async canvas => {
      const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { width: canvas.width, height: canvas.height, uniqueValues: new Set(bytes).size, sha256: Array.from(hash, value => value.toString(16).padStart(2, '0')).join('') };
    });
    assert.ok(pixels.uniqueValues > 100, 'The GPU image must contain varied pixels.');
    assert.equal(pixels.width, settings.width); assert.equal(pixels.height, settings.height);
    if (report.imageSha256) assert.equal(pixels.sha256, report.imageSha256, 'All runs must produce identical raw pixels.');
    else report.imageSha256 = pixels.sha256;
    if (report.workloadFingerprint) assert.equal(run.fingerprint, report.workloadFingerprint, 'Scene/settings must remain identical.');
    else report.workloadFingerprint = run.fingerprint;
    const traffic = measurements.get(`${roomId}:${run.runId}`);
    assert.ok(traffic, 'Proxy must observe real job and result traffic.');
    assert.equal(traffic.assignedTiles, expectedTiles);
    assert.equal(traffic.tileResultMessages, expectedTiles);
    assert.equal(traffic.jobAssignmentMessages, Math.ceil(expectedTiles / batchSize));
    assert.deepEqual(report.errors, []);
    const result = { batchSize, iteration, roomId, runId: run.runId, seconds: run.seconds, ...traffic };
    report[phase === 'warmup' ? 'warmups' : 'runs'].push(result);
    console.log(`${phase} batch=${batchSize} ${iteration}: ${run.seconds.toFixed(3)} s, ${traffic.jobAssignmentMessages} assignments, ${traffic.tileResultMessages} tile results`);
  }
  for (const mode of modes) await render(mode, 'warmup', 0);
  for (let iteration = 1; iteration <= 3; iteration++) {
    for (const mode of modes) await render(mode, 'measured', iteration);
  }
  const summary = batchSize => {
    const runs = report.runs.filter(run => run.batchSize === batchSize);
    return {
      measuredRuns: runs.length, medianSeconds: median(runs.map(run => run.seconds)),
      jobAssignmentMessagesPerRun: runs[0].jobAssignmentMessages,
      tileResultMessagesPerRun: runs[0].tileResultMessages,
    };
  };
  const old = summary(1), batched = summary(4);
  const assignmentReduction = 1 - batched.jobAssignmentMessagesPerRun / old.jobAssignmentMessagesPerRun;
  assert.ok(assignmentReduction >= 0.7, 'Batching should materially reduce job-assignment messages.');
  report.comparison = {
    batch1: old, defaultBatch4: batched,
    medianSpeedup: old.medianSeconds / batched.medianSeconds,
    assignmentMessageReductionPercent: assignmentReduction * 100,
    note: 'No speedup threshold is asserted. Tile-result messages remain one per tile; the reduction applies to job-assignment messages, not all network traffic.',
  };
  report.status = 'passed';
  console.log(JSON.stringify({ label: report.label, network: report.network, adapter: report.adapter, comparison: report.comparison }, null, 2));
} catch (error) {
  report.status = 'failed'; report.failure = error.message; process.exitCode = 1;
  console.error(error.message);
} finally {
  shuttingDown = true;
  await browser?.close();
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.terminate();
  websocketProxy.close();
  if (proxy.listening) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  report.network.observedProxyDelayMs = {
    messages: observedDelay.count,
    mean: observedDelay.count ? observedDelay.totalMs / observedDelay.count : null,
    min: observedDelay.count ? observedDelay.minMs : null, max: observedDelay.count ? observedDelay.maxMs : null,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('network-batching-report.json', directory), `${JSON.stringify(report, null, 2)}\n`);
}
