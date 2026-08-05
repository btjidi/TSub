import { describe, expect, it } from 'vitest';
import { handleLogin, getAuthSessionDiagnostic } from '../../functions/modules/auth-middleware.js';
import { handleAdminCredentials } from '../../functions/modules/api-handler.js';
import {
  getAdminCredentialMetadata,
  resetAdminCredentials,
  saveAdminCredentials,
  verifyAdminCredentials
} from '../../functions/modules/utils.js';

function createKv(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    dump(key) { return values.get(key); }
  };
}

function loginRequest(body) {
  return new Request('https://example.com/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

async function legacyVerifier(password) {
  const salt = new Uint8Array(16).fill(7);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
  const encode = bytes => btoa(String.fromCharCode(...bytes));
  return { algorithm: 'PBKDF2-SHA256', iterations: 100000, salt: encode(salt), hash: encode(bits) };
}

describe('administrator username and password credentials', () => {
  it('requires a username and normalizes it case-insensitively', async () => {
    const env = { TSUB_KV: createKv(), ADMIN_USERNAME: 'Root.User', ADMIN_PASSWORD: 'secret-password', COOKIE_SECRET: 'cookie-secret' };
    expect(await verifyAdminCredentials(env, ' ROOT.USER ', 'secret-password')).toBe(true);
    expect((await handleLogin(loginRequest({ password: 'secret-password' }), env)).status).toBe(401);
    expect((await handleLogin(loginRequest({ username: 'root.user', password: 'secret-password' }), env)).status).toBe(200);
  });

  it('stores a PBKDF2 verifier without plaintext and gives the override precedence', async () => {
    const kv = createKv();
    const env = { TSUB_KV: kv, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'environment-password' };
    await saveAdminCredentials(env, 'environment-password', 'Ops.Admin', 'replacement-password');
    const raw = kv.dump('SYSTEM_ADMIN_CREDENTIALS_V1');
    expect(raw).not.toContain('replacement-password');
    expect(JSON.parse(raw)).toMatchObject({ mode: 'override', username: 'ops.admin', passwordVerifier: { algorithm: 'PBKDF2-SHA256' }, authVersion: 2 });
    expect(JSON.parse(raw).passwordVerifier.iterations).toBe(600000);
    expect(await verifyAdminCredentials(env, 'ops.admin', 'replacement-password')).toBe(true);
    expect(await verifyAdminCredentials(env, 'admin', 'environment-password')).toBe(false);
    expect(await getAdminCredentialMetadata(env)).toMatchObject({ usernameSource: 'kv', passwordSource: 'kv', authVersion: 2 });
  });

  it('upgrades legacy PBKDF2 work factors after a successful login without changing auth version', async () => {
    const kv = createKv({
      SYSTEM_ADMIN_CREDENTIALS_V1: JSON.stringify({
        schemaVersion: 1,
        mode: 'override',
        username: 'admin',
        passwordVerifier: await legacyVerifier('legacy-hashed-password'),
        authVersion: 4
      })
    });
    const env = { TSUB_KV: kv };
    expect(await verifyAdminCredentials(env, 'admin', 'legacy-hashed-password')).toBe(true);
    const upgraded = JSON.parse(kv.dump('SYSTEM_ADMIN_CREDENTIALS_V1'));
    expect(upgraded.passwordVerifier.iterations).toBe(600000);
    expect(upgraded.authVersion).toBe(4);
  });

  it('invalidates existing sessions when credentials change and restores environment credentials', async () => {
    const env = { TSUB_KV: createKv(), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'environment-password', COOKIE_SECRET: 'cookie-secret' };
    const login = await handleLogin(loginRequest({ username: 'admin', password: 'environment-password' }), env);
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const request = { headers: { get: name => name.toLowerCase() === 'cookie' ? cookie : '' } };
    expect((await getAuthSessionDiagnostic(request, env)).isAuthenticated).toBe(true);

    await saveAdminCredentials(env, 'environment-password', 'operator', 'replacement-password');
    expect(await getAuthSessionDiagnostic(request, env)).toMatchObject({ isAuthenticated: false, reason: 'credential_version_mismatch' });
    await resetAdminCredentials(env, 'replacement-password');
    expect(await verifyAdminCredentials(env, 'admin', 'environment-password')).toBe(true);
    expect(await getAdminCredentialMetadata(env)).toMatchObject({ usernameSource: 'env', passwordSource: 'env', authVersion: 3 });
  });

  it('uses the legacy KV password until the first versioned credential write', async () => {
    const env = { TSUB_KV: createKv({ SYSTEM_ADMIN_PASSWORD: 'legacy-password' }), ADMIN_PASSWORD: 'environment-password' };
    expect(await verifyAdminCredentials(env, 'admin', 'legacy-password')).toBe(true);
    expect(await verifyAdminCredentials(env, 'admin', 'environment-password')).toBe(false);
  });

  it('never returns hashes and expires the current cookie after an update', async () => {
    const env = { TSUB_KV: createKv(), ADMIN_PASSWORD: 'environment-password' };
    const getResponse = await handleAdminCredentials(new Request('https://example.com/api/settings/credentials'), env);
    expect(await getResponse.json()).toEqual({ success: true, data: expect.objectContaining({ username: 'admin', passwordSource: 'env' }) });

    const putResponse = await handleAdminCredentials(new Request('https://example.com/api/settings/credentials', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'environment-password', username: 'operator', newPassword: 'replacement-password' })
    }), env);
    const body = await putResponse.json();
    expect(body).toMatchObject({ success: true, reauthenticate: true, data: { username: 'operator' } });
    expect(JSON.stringify(body)).not.toMatch(/hash|salt|replacement-password/i);
    expect(putResponse.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});
