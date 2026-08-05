import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PROTOCOL_CAPABILITIES } from '../shared/deployment-capabilities.js';

const file = 'public/proxy/v2/tsub-proxy.sh';
const runtime = await readFile(file);
const source = runtime.toString('utf8');
const bytes = runtime.byteLength;
const sha256 = createHash('sha256').update(runtime).digest('hex');
const manifest = JSON.parse(await readFile('public/proxy/v2/manifest.json', 'utf8'));
if (bytes > 512 * 1024) throw new Error(`Runtime exceeds 512KiB: ${bytes}`);
if (manifest.runtime?.sha256 !== sha256 || manifest.runtime?.bytes !== bytes) throw new Error('Public Runtime manifest does not match the script');
for (const core of ['xray', 'sing-box', 'naive']) {
  const entries = Object.entries(PROTOCOL_CAPABILITIES).filter(([, capability]) => capability.cores.includes(core));
  const protocols = entries.map(([protocol]) => protocol);
  const transports = [...new Set(entries.flatMap(([, capability]) => capability.transports[core] || []))];
  if (JSON.stringify(manifest.providers?.[core]?.protocols) !== JSON.stringify(protocols)
    || JSON.stringify(manifest.providers?.[core]?.transports) !== JSON.stringify(transports)) {
    throw new Error(`Runtime provider ${core} capabilities do not match the shared protocol matrix`);
  }
}
for (const forbidden of [/\b(?:bash|python|node|jq)\b[^\n]*(?:required|dependency)/i, /^\s*function\s+/m, /^\s*\[\[/m]) {
  if (forbidden.test(source)) throw new Error(`Runtime contains non-POSIX construct: ${forbidden}`);
}
if (process.argv.includes('--dist')) {
  const distRuntime = await readFile('dist/proxy/v2/tsub-proxy.sh');
  const distManifest = JSON.parse(await readFile('dist/proxy/v2/manifest.json', 'utf8'));
  const distSha256 = createHash('sha256').update(distRuntime).digest('hex');
  if (distSha256 !== sha256 || distManifest.runtime?.sha256 !== sha256 || distManifest.runtime?.bytes !== bytes) {
    throw new Error('Production dist Runtime does not match the generated manifest');
  }
}
console.log(`TSub Proxy contract OK: ${bytes} bytes`);
