import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targetFields = ['accountId', 'projectName', 'projectSubdomain', 'kvBinding', 'kvNamespaceId', 'd1Binding', 'd1DatabaseId', 'd1DatabaseName'];

function validateTarget(target) {
  const normalized = Object.fromEntries(targetFields.map(field => [field, String(target?.[field] || '').trim()]));
  const missing = targetFields.filter(field => !normalized[field]);
  if (missing.length) {
    throw new Error(`Pages production target is incomplete (${missing.join(', ')}). Configure scripts/pages-production-target.local.json or TSUB_PAGES_* environment variables`);
  }
  return normalized;
}

export function pagesTargetFromEnv(env = process.env) {
  return validateTarget({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    projectName: env.TSUB_PAGES_PROJECT_NAME,
    projectSubdomain: env.TSUB_PAGES_PROJECT_SUBDOMAIN,
    kvBinding: env.TSUB_KV_BINDING || 'TSUB_KV',
    kvNamespaceId: env.TSUB_KV_NAMESPACE_ID,
    d1Binding: env.TSUB_D1_BINDING || 'TSUB_DB',
    d1DatabaseId: env.TSUB_D1_DATABASE_ID,
    d1DatabaseName: env.TSUB_D1_DATABASE_NAME
  });
}

export async function loadPagesTarget({ rootDir = root, env = process.env, read = readFile } = {}) {
  const configuredPath = String(env.TSUB_PAGES_TARGET_FILE || '').trim();
  const targetPath = configuredPath
    ? path.resolve(rootDir, configuredPath)
    : path.join(rootDir, 'scripts', 'pages-production-target.local.json');
  try {
    return validateTarget(JSON.parse(await read(targetPath, 'utf8')));
  } catch (error) {
    if (configuredPath || error?.code !== 'ENOENT') {
      throw new Error(`Unable to load Pages production target from ${targetPath}: ${error.message}`);
    }
    return pagesTargetFromEnv(env);
  }
}

function directJsonRequest(url, token) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, response => collectResponse(response, resolve, reject));
    request.once('error', reject);
    request.end();
  });
}

function collectResponse(response, resolve, reject) {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { body += chunk; });
  response.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return reject(new Error(`Cloudflare API returned invalid JSON (${response.statusCode})`)); }
    if (response.statusCode < 200 || response.statusCode >= 300 || parsed.success === false) return reject(new Error(`Cloudflare API request failed (${response.statusCode})`));
    resolve(parsed.result);
  });
}

function proxiedJsonRequest(url, token, proxyValue) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyValue);
    const connector = proxy.protocol === 'https:' ? https : http;
    const headers = { Host: `${url.hostname}:443` };
    if (proxy.username || proxy.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    const connect = connector.request({ hostname: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)), method: 'CONNECT', path: `${url.hostname}:443`, headers });
    connect.once('connect', (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`HTTPS proxy CONNECT failed (${response.statusCode})`)); return; }
      const secureSocket = tls.connect({ socket, servername: url.hostname });
      secureSocket.once('secureConnect', () => {
        const request = https.request({ hostname: url.hostname, path: `${url.pathname}${url.search}`, method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, agent: false, createConnection: () => secureSocket }, response2 => collectResponse(response2, resolve, reject));
        request.once('error', reject);
        request.end();
      });
      secureSocket.once('error', reject);
    });
    connect.once('error', reject);
    connect.end();
  });
}

export function cloudflareJson(pathname, token, proxyValue = '') {
  const url = new URL(`https://api.cloudflare.com/client/v4${pathname}`);
  return proxyValue ? proxiedJsonRequest(url, token, proxyValue) : directJsonRequest(url, token);
}

export function wranglerDeployCommand(rootDir = root, execPath = process.execPath) {
  return {
    command: execPath,
    args: [path.join(rootDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'pages', 'deploy', 'dist']
  };
}

function bindingId(project, group, binding) {
  const value = project?.deployment_configs?.production?.[group]?.[binding];
  return value?.namespace_id || value?.id || value?.database_id || '';
}

export async function verifyPagesTarget({ target, accountId, token, proxy = '', request = cloudflareJson }) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  if (accountId !== target.accountId) throw new Error('Cloudflare Account ID does not match the reviewed production target');
  const base = `/accounts/${target.accountId}`;
  const [project, kv, d1] = await Promise.all([
    request(`${base}/pages/projects/${encodeURIComponent(target.projectName)}`, token, proxy),
    request(`${base}/storage/kv/namespaces/${target.kvNamespaceId}`, token, proxy),
    request(`${base}/d1/database/${target.d1DatabaseId}`, token, proxy)
  ]);
  const subdomain = String(project?.subdomain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (subdomain !== target.projectSubdomain) throw new Error('Pages project subdomain does not match the reviewed production target');
  if (String(kv?.id || '') !== target.kvNamespaceId) throw new Error('KV namespace does not belong to the reviewed production account');
  if (String(d1?.uuid || d1?.id || '') !== target.d1DatabaseId || String(d1?.name || '') !== target.d1DatabaseName) throw new Error('D1 database does not match the reviewed production target');
  const projectKv = bindingId(project, 'kv_namespaces', target.kvBinding);
  const projectD1 = bindingId(project, 'd1_databases', target.d1Binding);
  if (projectKv !== target.kvNamespaceId) throw new Error('Pages production KV binding is missing or points to a different namespace');
  if (projectD1 !== target.d1DatabaseId) throw new Error('Pages production D1 binding is missing or points to a different database');
  return { accountId, projectName: target.projectName, subdomain, kvNamespaceId: target.kvNamespaceId, d1DatabaseId: target.d1DatabaseId };
}

async function main() {
  const target = await loadPagesTarget();
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const proxy = String(process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
  const verified = await verifyPagesTarget({ target, accountId, token, proxy });
  process.stdout.write(`Pages target verified: ${verified.projectName} (${verified.subdomain})\n`);
  if (!process.argv.includes('--deploy')) return;
  const deploy = wranglerDeployCommand();
  await new Promise((resolve, reject) => {
    const child = spawn(deploy.command, [...deploy.args, '--project-name', target.projectName], { cwd: root, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Wrangler exited with code ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Pages deployment blocked: ${error.message}\n`); process.exitCode = 1; });
}
