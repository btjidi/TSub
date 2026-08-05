import { beforeEach, describe, expect, it } from 'vitest';
import { handleLogin } from '../../functions/modules/auth-middleware.js';
import { handleGuestbookPost } from '../../functions/modules/handlers/guestbook-handler.js';
import { handleErrorReportRequest } from '../../functions/modules/handlers/error-report-handler.js';
import { createErrorResponse } from '../../functions/modules/utils.js';
import { SettingsCache } from '../../functions/storage-adapter.js';

function createKv(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    async get(key) { return data.get(key) ?? null; },
    async put(key, value) { data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) { return { keys: [...data.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })) }; },
    keys() { return [...data.keys()]; },
    value(key) { return data.get(key); }
  };
}

function jsonRequest(url, body, ip = '198.51.100.9') {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body)
  });
}

describe('persistent security rate limits', () => {
  beforeEach(() => SettingsCache.clear());

  it('locks login after five failures without storing the raw IP or username in the key', async () => {
    const kv = createKv();
    const env = { TSUB_KV: kv, ADMIN_PASSWORD: 'correct-password', COOKIE_SECRET: 'rate-limit-cookie-secret' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await handleLogin(jsonRequest('https://example.com/api/login', { username: 'admin', password: 'wrong-password' }), env)).status).toBe(401);
    }
    const blocked = await handleLogin(jsonRequest('https://example.com/api/login', { username: 'admin', password: 'correct-password' }), env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const key = kv.keys().find(item => item.startsWith('tsub_rate_limit_v1:login:'));
    expect(key).toBeTruthy();
    expect(key).not.toContain('198.51.100.9');
    expect(key).not.toContain('admin');
  });

  it('limits public guestbook submissions per Cloudflare client IP', async () => {
    const kv = createKv({ worker_settings_v1: { guestbook: { enabled: true, requireAudit: true } } });
    const env = { TSUB_KV: kv, COOKIE_SECRET: 'rate-limit-cookie-secret' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await handleGuestbookPost(jsonRequest('https://example.com/api/public/guestbook', { content: `message-${attempt}` }), env)).status).toBe(200);
    }
    expect((await handleGuestbookPost(jsonRequest('https://example.com/api/public/guestbook', { content: 'blocked' }), env)).status).toBe(429);
  });

  it('limits error reports and stores only a one-way client key', async () => {
    const kv = createKv();
    const env = { TSUB_KV: kv, COOKIE_SECRET: 'rate-limit-cookie-secret' };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await handleErrorReportRequest(jsonRequest('https://example.com/api/error-report', { message: `failure-${attempt}` }), env);
    }
    expect((await handleErrorReportRequest(jsonRequest('https://example.com/api/error-report', { message: 'blocked' }), env)).status).toBe(429);
    const reports = JSON.parse(kv.value('tsub_error_reports'));
    expect(reports[0].clientKey).toMatch(/^[a-f0-9]{24}$/);
    expect(reports[0].ip).toBeUndefined();
  });

  it('redacts unexpected 5xx messages and includes a request identifier', async () => {
    const response = createErrorResponse(new Error('database path and secret value'), 500);
    const body = await response.json();
    expect(body.error).toBe('Internal Server Error');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toContain('database path');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
