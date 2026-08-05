import dns from 'node:dns/promises';
import tls from 'node:tls';

const timeoutResult = error => ({
  ok: false,
  checks: { dns: false, tcp: false, tls: false, hostSni: false, websocket101: false },
  latencyMs: 0,
  error
});

export async function probeEdgeHandshake(probe) {
  const started = Date.now();
  let dnsOk = false;
  try {
    await dns.lookup(probe.address);
    dnsOk = true;
  } catch { return timeoutResult('dns_failed'); }
  return new Promise(resolve => {
    let settled = false;
    let response = '';
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };
    const socket = tls.connect({
      host: probe.address,
      port: probe.port,
      servername: probe.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1']
    });
    const timer = setTimeout(() => finish({
      ok: false,
      checks: { dns: dnsOk, tcp: socket.connecting === false, tls: socket.authorized === true, hostSni: socket.authorized === true, websocket101: false },
      error: 'probe_timeout'
    }), 10_000);
    socket.once('secureConnect', () => {
      const host = probe.port === 443 ? probe.hostname : `${probe.hostname}:${probe.port}`;
      socket.write(`GET ${probe.path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    socket.on('data', chunk => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n')) return;
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = response.slice(0, headerEnd).split('\r\n');
      const status101 = /^HTTP\/1\.[01] 101\b/.test(headers[0] || '');
      const upgrade = headers.some(line => /^upgrade\s*:\s*websocket\s*$/i.test(line));
      const connection = headers.some(line => /^connection\s*:\s*.*\bupgrade\b/i.test(line));
      const websocket101 = status101 && upgrade && connection;
      finish({
        ok: websocket101,
        checks: { dns: true, tcp: true, tls: socket.authorized === true, hostSni: socket.authorized === true, websocket101 },
        error: websocket101 ? '' : 'websocket_upgrade_failed'
      });
    });
    socket.once('error', error => finish({
      ok: false,
      checks: { dns: dnsOk, tcp: socket.connecting === false, tls: false, hostSni: false, websocket101: false },
      error: error.code === 'CERT_HAS_EXPIRED' || /certificate|hostname/i.test(error.message || '') ? 'tls_verification_failed' : 'connection_failed'
    }));
  });
}
