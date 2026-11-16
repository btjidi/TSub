import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentConfigurationError, deploymentErrorResponse } from '../../functions/modules/deployment-errors.js';
import { decryptDeploymentConfig, encryptDeploymentConfig } from '../../functions/modules/deployment-crypto.js';
import { assertDeploymentCommandResult, formatDeploymentError } from '../../src/lib/deployment-errors.js';
import { createI18n } from '../../src/i18n/index.js';
import { createErrorResponse } from '../../functions/modules/utils.js';
import { corsMiddleware, csrfOriginMiddleware, securityHeadersMiddleware } from '../../functions/middleware/cors.js';

afterEach(() => vi.restoreAllMocks());

describe('safe deployment diagnostics', () => {
  it.each(['DEPLOYMENT_KEY_INVALID', 'DEPLOYMENT_PINNED_ASSET_MISSING', 'DEPLOYMENT_COMMAND_FAILED'])('preserves trusted %s through the complete response middleware chain', async code => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = new Request('https://example.test/api/deployments', {
      method: 'POST', headers: { Origin: 'https://example.test' }
    });
    const original = await deploymentErrorResponse(new DeploymentConfigurationError(code));
    const expected = await original.clone().json();
    const response = await corsMiddleware(request, () => csrfOriginMiddleware(request,
      () => securityHeadersMiddleware(request, async () => original)),
    { origins: ['https://example.test'], allowCredentials: true });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expected);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.test');
  });

  it('does not trust a diagnostic code or headers in an arbitrary upstream response', async () => {
    const response = await securityHeadersMiddleware(new Request('https://example.test/api/deployments'), async () =>
      new Response(JSON.stringify({ code: 'DEPLOYMENT_KEY_INVALID', message: 'fixture-private-value', requestId: 'fixture-private-value' }), {
        status: 503, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '100' }
      }));
    expect(await response.json()).toMatchObject({ code: 'INTERNAL_ERROR', error: 'Internal Server Error' });
    expect(response.headers.has('Content-Encoding')).toBe(false);
    expect(response.headers.has('Content-Length')).toBe(false);
  });

  it.each([
    [undefined, 'DEPLOYMENT_KEY_MISSING'], ['', 'DEPLOYMENT_KEY_MISSING'],
    ['short', 'DEPLOYMENT_KEY_INVALID'], [' '.repeat(32), 'DEPLOYMENT_KEY_INVALID']
  ])('rejects invalid keys without exposing their value (%s)', async (key, code) => {
    await expect(encryptDeploymentConfig({}, { DEPLOYMENT_SECRET_KEY: key })).rejects.toMatchObject({ code });
  });

  it('reports a changed encryption key without returning ciphertext or cryptographic exceptions', async () => {
    const saved = await encryptDeploymentConfig({ password: 'fixture-private-value' }, { DEPLOYMENT_SECRET_KEY: 'fixture-original-key-32-characters' });
    await expect(decryptDeploymentConfig(saved, { DEPLOYMENT_SECRET_KEY: 'fixture-different-key-32-characters' })).rejects.toMatchObject({ code: 'DEPLOYMENT_DECRYPT_FAILED' });
  });

  it('exposes only allowlisted server messages and correlates safe logs with request IDs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await deploymentErrorResponse(new DeploymentConfigurationError('DEPLOYMENT_KEY_MISSING'));
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ code: 'DEPLOYMENT_KEY_MISSING', message: expect.stringContaining('DEPLOYMENT_SECRET_KEY'), requestId: expect.any(String) });
    expect(log).toHaveBeenCalledWith('[Deployment]', { code: body.code, status: 503, requestId: body.requestId });
  });

  it('never reflects unknown exceptions or spoofed diagnostic codes, and keeps generic 5xx protection', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('upstream password=fixture-secret-value https://example.test/private-token'), { code: 'DEPLOYMENT_KEY_MISSING' });
    const response = await deploymentErrorResponse(error);
    const body = await response.json();
    expect(body.code).toBe('DEPLOYMENT_COMMAND_FAILED');
    expect(JSON.stringify([body, log.mock.calls])).not.toMatch(/fixture-secret-value|private-token/);
    expect(await createErrorResponse(error, 503).json()).toMatchObject({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
  });

  it.each(['zh-CN', 'en-US'])('formats deployment diagnostics and legacy errors in %s', locale => {
    const { t } = createI18n({ initialLocale: locale });
    const result = formatDeploymentError({ status: 503, data: { code: 'DEPLOYMENT_KEY_MISSING', message: 'password=should-not-render', requestId: 'safe-request-1' } }, t);
    expect(result.message).toContain('DEPLOYMENT_SECRET_KEY');
    expect(result.message).not.toContain('should-not-render');
    expect(result.requestId).toBe('safe-request-1');
    expect(formatDeploymentError({ status: 503, data: { code: 'INTERNAL_ERROR', error: 'Internal Server Error' } }, t).message).toBe(t('deployments.commandErrors.unavailable'));
    expect(formatDeploymentError({ status: 401, data: '<html>gateway secret</html>' }, t).message).toBe(t('deployments.commandErrors.auth'));
    expect(formatDeploymentError(new TypeError('Failed to fetch'), t).message).toBe(t('deployments.commandErrors.network'));
    expect(formatDeploymentError({ name: 'AbortError' }, t).message).toBe(t('deployments.commandErrors.timeout'));
    expect(formatDeploymentError({ status: 400, data: { error: '重复端口 443' } }, t).message).toBe('重复端口 443');
    expect(formatDeploymentError({ status: 502, data: { message: 'upstream-private-body' } }, t).message).not.toContain('upstream-private-body');
  });

  it.each([null, '<html>Gateway</html>', {}, { success: false }, { data: { command: 'curl something' } }])('rejects malformed successful command responses', result => {
    expect(() => assertDeploymentCommandResult(result)).toThrow('Invalid deployment command response');
  });
});
