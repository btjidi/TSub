// @vitest-environment node

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), connect: vi.fn() }));
vi.mock('node:dns/promises', () => ({ default: { lookup: mocks.lookup } }));
vi.mock('node:tls', () => ({ default: { connect: mocks.connect } }));

import { probeEdgeHandshake } from '../../server/edge-probe.mjs';

function socketWithResponse(response, authorized = true) {
  const socket = new EventEmitter();
  socket.authorized = authorized; socket.connecting = false;
  socket.destroy = vi.fn();
  socket.write = vi.fn(() => queueMicrotask(() => socket.emit('data', Buffer.from(response, 'latin1'))));
  return socket;
}

function connectSocket(socket) {
  mocks.connect.mockImplementationOnce(() => { queueMicrotask(() => socket.emit('secureConnect')); return socket; });
}

describe('server edge handshake probe', () => {
  beforeEach(() => { mocks.lookup.mockReset(); mocks.connect.mockReset(); mocks.lookup.mockResolvedValue({ address: '203.0.113.8' }); });

  it('requires TLS hostname validation and complete WebSocket upgrade headers', async () => {
    const socket = socketWithResponse('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n\r\n');
    connectSocket(socket);
    const result = await probeEdgeHandshake({ hostname: 'cdn.example.com', address: '203.0.113.8', port: 443, path: '/ws' });
    expect(result).toMatchObject({ ok: true, checks: { dns: true, tcp: true, tls: true, hostSni: true, websocket101: true } });
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '203.0.113.8', servername: 'cdn.example.com', rejectUnauthorized: true }));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('Host: cdn.example.com'));
  });

  it('rejects a bare 101 response without Upgrade headers', async () => {
    connectSocket(socketWithResponse('HTTP/1.1 101 Switching Protocols\r\nServer: test\r\n\r\n'));
    await expect(probeEdgeHandshake({ hostname: 'cdn.example.com', address: 'edge.example.net', port: 8443, path: '/ws' }))
      .resolves.toMatchObject({ ok: false, checks: { websocket101: false }, error: 'websocket_upgrade_failed' });
  });

  it('reports DNS and certificate failures without exposing the target', async () => {
    mocks.lookup.mockRejectedValueOnce(new Error('private resolver details'));
    await expect(probeEdgeHandshake({ hostname: 'cdn.example.com', address: 'bad.example', port: 443, path: '/' }))
      .resolves.toEqual({ ok: false, checks: { dns: false, tcp: false, tls: false, hostSni: false, websocket101: false }, latencyMs: 0, error: 'dns_failed' });

    const socket = new EventEmitter(); socket.connecting = false; socket.destroy = vi.fn();
    mocks.connect.mockImplementationOnce(() => { queueMicrotask(() => socket.emit('error', Object.assign(new Error('certificate hostname mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))); return socket; });
    await expect(probeEdgeHandshake({ hostname: 'cdn.example.com', address: '203.0.113.8', port: 443, path: '/' }))
      .resolves.toMatchObject({ ok: false, error: 'tls_verification_failed' });
  });
});
