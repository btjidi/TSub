import http from 'node:http';
import { createReadStream, existsSync, readFileSync, unlinkSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { onRequest } from '../functions/[[path]].js';
import { ensureD1Schema, SettingsCache } from '../functions/storage-adapter.js';
import { createServerDatabaseManager } from './database.mjs';
import { startInternalScheduler } from './scheduler.mjs';
import { probeEdgeHandshake } from './edge-probe.mjs';

process.umask(0o077);

const DATA_DIR = process.env.TSUB_DATA_DIR || '/var/lib/tsub-controller';
const STATIC_DIR = path.resolve(process.env.TSUB_STATIC_DIR || 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const SOCKET_PATH = process.env.TSUB_LOCAL_EXECUTOR_SOCKET || '';
const EXECUTOR_CONFIG_PATH = process.env.TSUB_LOCAL_EXECUTOR_CONFIG || '/run/tsub/executor.conf';

function acquireSingleInstanceLock(storageType) {
  if (storageType === 'postgres') return () => {};
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const lockPath = path.join(DATA_DIR, 'controller.pid');
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      try {
        if (pid > 0) process.kill(pid, 0);
        throw new Error(`SQLite controller is already running (PID ${pid})`);
      } catch (processError) {
        if (processError.code !== 'ESRCH') throw processError;
        unlinkSync(lockPath);
      }
    }
  }
  chmodSync(lockPath, 0o600);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (Number(readFileSync(lockPath, 'utf8')) === process.pid) unlinkSync(lockPath); } catch {}
  };
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.sh':'text/x-shellscript; charset=utf-8' })[ext] || 'application/octet-stream';
}

function normalizeAddress(value) {
  return String(value || '').replace(/^::ffff:/, '').toLowerCase();
}

function isPrivateAddress(value) {
  const address = normalizeAddress(value);
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function isTrustedProxy(remoteAddress) {
  if (!remoteAddress) return true;
  const address = normalizeAddress(remoteAddress);
  if (address === '127.0.0.1' || address === '::1') return true;
  const configured = String(process.env.TSUB_TRUST_PROXY || 'loopback').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return configured.includes(address) || (configured.includes('private') && isPrivateAddress(address));
}

function forwardedValue(value) { return String(value || '').split(',', 1)[0].trim(); }
function forwardedClientAddress(value) {
  const address = normalizeAddress(String(value || '').split(',').at(-1)?.trim());
  return /^[0-9a-f:.]+$/.test(address) ? address : '';
}

async function staticResponse(request) {
  const url = new URL(request.url);
  const decoded = decodeURIComponent(url.pathname);
  const candidate = path.resolve(STATIC_DIR, `.${decoded}`);
  const safeCandidate = candidate.startsWith(`${STATIC_DIR}${path.sep}`) ? candidate : '';
  const file = safeCandidate && existsSync(safeCandidate) && (await stat(safeCandidate)).isFile()
    ? safeCandidate
    : path.join(STATIC_DIR, 'index.html');
  if (!existsSync(file)) return new Response('Not Found', { status: 404 });
  return new Response(Readable.toWeb(createReadStream(file)), { headers: { 'Content-Type': contentType(file) } });
}

function requestOrigin(req) {
  if (process.env.TSUB_PUBLIC_URL) return new URL(process.env.TSUB_PUBLIC_URL).origin;
  const trustedProxy = isTrustedProxy(req.socket.remoteAddress);
  const forwardedProtocol = trustedProxy ? forwardedValue(req.headers['x-forwarded-proto']) : '';
  const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
  const forwardedHost = trustedProxy ? forwardedValue(req.headers['x-forwarded-host']) : '';
  const host = /^[A-Za-z0-9.:[\]-]+(?::\d+)?$/.test(forwardedHost) ? forwardedHost : req.headers.host || `${HOST}:${PORT}`;
  return `${protocol}://${host}`;
}

function toWebRequest(req) {
  const headers = new Headers(req.headers);
  if (isTrustedProxy(req.socket.remoteAddress)) {
    const clientAddress = forwardedClientAddress(req.headers['x-forwarded-for']) || normalizeAddress(req.socket.remoteAddress);
    if (clientAddress) headers.set('CF-Connecting-IP', clientAddress);
  } else {
    headers.set('CF-Connecting-IP', normalizeAddress(req.socket.remoteAddress));
  }
  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method)) { init.body = Readable.toWeb(req); init.duplex = 'half'; }
  return new Request(new URL(req.url, requestOrigin(req)), init);
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

const database = await createServerDatabaseManager({
  type: process.env.TSUB_STORAGE_TYPE,
  postgresUrl: process.env.TSUB_POSTGRES_URL || process.env.TSUB_DATABASE_URL,
  sqlitePath: process.env.TSUB_SQLITE_PATH,
  dataDir: DATA_DIR,
  poolSize: process.env.TSUB_DATABASE_POOL_SIZE
});
let releaseSqliteLock = acquireSingleInstanceLock(database.type);
process.on('exit', () => releaseSqliteLock());
for (const binding of Object.values(database.databases)) await ensureD1Schema(binding);

const env = {
  ...process.env,
  TSUB_PLATFORM: 'server',
  TSUB_STORAGE_TYPE: database.type,
  TSUB_SQL_DB: database.binding,
  TSUB_SERVER_DATABASES: database.databases,
  TSUB_SWITCH_SERVER_STORAGE: async target => {
    const previous = database.type;
    let acquired = null;
    if (target === 'sqlite' && previous !== 'sqlite') acquired = acquireSingleInstanceLock('sqlite');
    try {
      await database.switchStorage(target);
    } catch (error) {
      acquired?.();
      throw error;
    }
    if (previous === 'sqlite' && target !== 'sqlite') releaseSqliteLock();
    if (acquired) releaseSqliteLock = acquired;
    env.TSUB_STORAGE_TYPE = database.type;
    env.TSUB_SQL_DB = database.binding;
    SettingsCache.clear();
  },
  TSUB_PROVISION_LOCAL_EXECUTOR: ({ deploymentId, token }) => {
    if (!SOCKET_PATH || !deploymentId || !token) throw new Error('Local executor is not configured');
    mkdirSync(path.dirname(EXECUTOR_CONFIG_PATH), { recursive: true, mode: 0o770 });
    const temporary = `${EXECUTOR_CONFIG_PATH}.${process.pid}.tmp`;
    const encoded = Buffer.from(token, 'utf8').toString('base64');
    writeFileSync(temporary, `agent_deployment_id=${deploymentId}\nagent_token_b64=${encoded}\n`, { mode: 0o600 });
    renameSync(temporary, EXECUTOR_CONFIG_PATH);
    chmodSync(EXECUTOR_CONFIG_PATH, 0o600);
  },
  TSUB_LOCAL_EXECUTOR_SOCKET: SOCKET_PATH,
  TSUB_EDGE_PROBE: probeEdgeHandshake,
  ASSETS: { fetch: staticResponse }
};
SettingsCache.clear();
const stopScheduler = startInternalScheduler(env);

const handler = async (req, res) => {
  try {
    const request = toWebRequest(req);
    const response = await onRequest({ request, env, next: () => staticResponse(request) });
    await sendWebResponse(res, response);
  } catch (error) {
    console.error('[Server]', error?.stack || error);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
};

const server = http.createServer(handler);
server.listen(PORT, HOST, () => console.log(`TSub Controller listening on http://${HOST}:${PORT}`));

let socketServer = null;
if (SOCKET_PATH && process.platform !== 'win32') {
  mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o770 });
  try { unlinkSync(SOCKET_PATH); } catch {}
  socketServer = http.createServer(handler);
  socketServer.listen(SOCKET_PATH, () => { chmodSync(SOCKET_PATH, 0o660); console.log(`Local executor socket: ${SOCKET_PATH}`); });
}

async function shutdown() {
  stopScheduler();
  server.close();
  socketServer?.close();
  await database.close();
  releaseSqliteLock();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
