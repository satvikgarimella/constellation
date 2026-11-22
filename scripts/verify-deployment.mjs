import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// Explicit target only. This creates one empty room, opens two sockets, and
// closes them. It never starts a render or calls a paid AI service.
const root = new URL('../', import.meta.url);
const artifact = new URL('artifacts/deployment-verification.json', root);
const timeoutMs = 12000;
const sockets = new Set();
const report = {
  checkedAt: new Date().toISOString(),
  status: 'running',
  checks: [],
  limitations: [
    'HTTP and WebSocket checks do not verify physical phones or GPU rendering.',
    'Asset fingerprints identify browser code; the server does not expose a build identifier.',
    'Integration configuration flags do not prove Gemini requests or database writes succeed.',
    'One empty verification room remains until the server expires it.',
  ],
};

class VerificationError extends Error {}
const requireCondition = (condition, message) => {
  if (!condition) throw new VerificationError(message);
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function check(name, run) {
  const started = performance.now();
  try {
    const details = await run();
    report.checks.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started), ...details });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', durationMs: Math.round(performance.now() - started) });
    throw error;
  }
}

function target() {
  requireCondition(process.env.BASE_URL, 'Set BASE_URL to the explicitly chosen deployment origin.');
  let url;
  try { url = new URL(process.env.BASE_URL); }
  catch { throw new VerificationError('BASE_URL must be a valid HTTP or HTTPS origin.'); }
  requireCondition(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'BASE_URL must contain only an origin, without credentials, a path, query, or fragment.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireCondition(url.protocol === 'https:' || (loopback && url.protocol === 'http:'),
    'Remote deployment verification requires HTTPS. HTTP is allowed only on loopback.');
  return { url, loopback };
}

async function request(base, path, { method = 'GET', status = 200, json = true } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, base), {
      method,
      headers: { Origin: base.origin },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    throw new VerificationError(`${method} ${path.split('?')[0]} failed to connect, timed out, or redirected.`);
  }
  requireCondition(response.status === status,
    `${method} ${path.split('?')[0]} returned HTTP ${response.status}; expected ${status}.`);
  let text;
  try { text = await response.text(); }
  catch { throw new VerificationError(`${method} ${path.split('?')[0]} response could not be read.`); }
  if (!json) return { text, contentType: response.headers.get('content-type') || '' };
  requireCondition((response.headers.get('content-type') || '').includes('application/json'),
    `${method} ${path.split('?')[0]} did not return JSON.`);
  try { return JSON.parse(text); }
  catch { throw new VerificationError(`${method} ${path.split('?')[0]} returned invalid JSON.`); }
}

function hello(base, room, host) {
  const endpoint = new URL('/ws', base);
  endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      origin: base.origin,
      handshakeTimeout: timeoutMs,
      maxPayload: 1024 * 1024,
    });
    sockets.add(socket);
    let settled = false;
    const finish = (error, welcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ socket, welcome });
    };
    const timer = setTimeout(() => finish(new VerificationError('WebSocket welcome timed out.')), timeoutMs);
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'hello', roomId: room.roomId,
      ...(host ? { token: room.hostToken } : {}),
      label: host ? 'Deployment verification host' : 'Deployment verification guest',
    })));
    socket.on('message', (data, binary) => {
      if (settled || binary) return;
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { finish(new VerificationError('WebSocket returned invalid JSON.')); return; }
      if (message.type === 'error') {
        finish(new VerificationError('WebSocket rejected the verification handshake.'));
      } else if (message.type === 'welcome') {
        try {
          requireCondition(message.isHost === host, 'WebSocket assigned the wrong host/guest role.');
          requireCondition(message.state?.roomId === room.roomId, 'WebSocket joined the wrong room.');
          requireCondition(!JSON.stringify(message).includes(room.hostToken), 'WebSocket state exposed the host token.');
          finish(null, message);
        } catch (error) { finish(error); }
      }
    });
    socket.on('error', () => finish(new VerificationError('WebSocket connection failed.')));
    socket.on('close', () => finish(new VerificationError('WebSocket closed before the welcome message.')));
  });
}

async function closeSockets() {
  await Promise.all([...sockets].map(socket => new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
    const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    else socket.terminate();
  })));
}

try {
  const { url, loopback } = target();
  report.baseUrl = url.origin;
  await check('Health', async () => {
    const health = await request(url, '/healthz');
    requireCondition(health.ok === true, 'Health endpoint did not report ok.');
  });
  await check('Configuration', async () => {
    const config = await request(url, '/api/config');
    requireCondition(['gemini', 'tigerData', 'databaseReady'].every(key => typeof config[key] === 'boolean'),
      'Configuration endpoint is missing expected boolean fields.');
    if (!loopback) {
      requireCondition(config.publicUrl === url.origin, 'PUBLIC_URL does not match the deployed HTTPS origin.');
    }
    if (process.env.REQUIRE_GEMINI === '1') requireCondition(config.gemini, 'Gemini is not configured.');
    if (process.env.REQUIRE_TIGER_DATA === '1') {
      requireCondition(config.tigerData && config.databaseReady, 'Tiger Data is not configured and ready.');
    }
    return { geminiConfigured: config.gemini, tigerDataConfigured: config.tigerData, databaseReady: config.databaseReady };
  });
  await check('Application and renderer assets', async () => {
    const page = await request(url, '/', { json: false });
    requireCondition(page.contentType.includes('text/html') && page.text.includes('<title>Constellation') && page.text.includes('/app.js'),
      'The deployment is not serving the Constellation application.');
    const assets = ['app.js', 'render-worker.js', 'raytracer.js', 'scene.js', 'trace.wgsl', 'styles.css'];
    const hashes = {};
    const matchLocal = process.env.MATCH_LOCAL_ASSETS === '1';
    for (const name of assets) {
      const asset = await request(url, `/${name}`, { json: false });
      requireCondition(asset.text.length > 0 && !asset.contentType.includes('text/html'), `Asset ${name} is empty or returned HTML.`);
      hashes[name] = sha256(asset.text);
      if (matchLocal) {
        let local;
        try { local = await readFile(new URL(`public/${name}`, root), 'utf8'); }
        catch { throw new VerificationError(`Local asset ${name} could not be read.`); }
        requireCondition(hashes[name] === sha256(local), `Deployed asset ${name} differs from this checkout.`);
      }
    }
    return { sha256: hashes, matchesLocalCheckout: matchLocal ? true : null };
  });
  let room;
  await check('Room creation', async () => {
    room = await request(url, '/api/rooms', { method: 'POST', status: 201 });
    requireCondition(/^[A-F0-9]{6}$/.test(room.roomId) && typeof room.hostToken === 'string' && room.hostToken.length >= 32,
      'Room creation returned invalid identifiers.');
    return { roomId: room.roomId };
  });
  await check('Share page and QR code', async () => {
    const page = await request(url, `/join/${room.roomId}`, { json: false });
    requireCondition(page.contentType.includes('text/html') && page.text.includes('/app.js'), 'Join page did not serve the application.');
    const query = new URLSearchParams({ room: room.roomId, base: url.origin });
    const qr = await request(url, `/api/qr?${query}`, { json: false });
    requireCondition(qr.contentType.includes('image/svg+xml') && qr.text.includes('<svg'), 'QR endpoint did not return an SVG.');
  });
  await check('Host and guest WebSocket handshakes', async () => {
    const host = await hello(url, room, true);
    const guest = await hello(url, room, false);
    requireCondition(host.socket.readyState === WebSocket.OPEN && guest.socket.readyState === WebSocket.OPEN,
      'Both verification sockets must stay connected.');
    const state = await request(url, `/api/rooms/${room.roomId}`);
    requireCondition(state.roomId === room.roomId && Array.isArray(state.clients) && state.clients.length === 2,
      'Public room state did not contain both connected clients.');
    requireCondition(!JSON.stringify(state).includes(room.hostToken), 'Public room state exposed the host token.');
    return { connectedClients: state.clients.length, hostAuthenticated: true, guestUnprivileged: true };
  });
  report.status = 'passed';
} catch (error) {
  // Avoid printing raw HTTP bodies, socket errors, stack traces, or credentials.
  report.status = 'failed';
  report.error = error instanceof VerificationError ? error.message : 'Unexpected verification failure; no server response or credentials were logged.';
  console.error(`FAIL ${report.error}`);
  process.exitCode = 1;
} finally {
  await closeSockets();
  try {
    await mkdir(new URL('artifacts/', root), { recursive: true });
    await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`Report: ${fileURLToPath(artifact)}`);
  } catch {
    console.error('FAIL Could not write the sanitized verification report.');
    process.exitCode = 1;
  }
}
