import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../../functions/services/fetch-utils.js';
import { debugTgNotification, sendTgNotification } from '../../functions/services/notification-service.js';
import { APIError, createErrorResponse } from '../../functions/modules/utils.js';

afterEach(() => vi.restoreAllMocks());

describe('security log and error response boundaries', () => {
  it('redacts retry URLs and errors without changing successful fetched content', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Bearer fixture-token Cookie: fixture-session'))
      .mockResolvedValueOnce(new Response('successful content'));
    const result = await fetchWithRetry('https://example.com/short?token=fixture-query', {}, { maxRetries: 1, baseDelay: 0 });
    const output = JSON.stringify(log.mock.calls);
    for (const secret of ['fixture-token', 'fixture-session', 'fixture-query', '/short']) expect(output).not.toContain(secret);
    expect(output).toContain('example.com');
    expect(await result.text()).toBe('successful content');
  });

  it('does not log Telegram response bodies or return network exception content', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('fixture-upstream-secret', { status: 403 }))
      .mockRejectedValueOnce(new Error('fixture-unstructured-secret'));
    const settings = { BotToken: 'fixture-bot-token', ChatID: 'fixture-chat' };
    expect(await sendTgNotification(settings, 'test')).toBe(false);
    const debug = await debugTgNotification(settings, 'test');
    const output = JSON.stringify({ debug, logs: log.mock.calls });
    for (const secret of ['fixture-upstream-secret', 'fixture-unstructured-secret', 'fixture-bot-token']) expect(output).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sanitizes 4xx API error details while keeping stable codes', async () => {
    const result = await createErrorResponse(new APIError('invalid https://example.com/private?token=fixture-query', 400, 'INVALID_CONFIG', {
      password: 'fixture-password', nested: [{ private_key: 'fixture-key' }]
    })).json();
    expect(result.code).toBe('INVALID_CONFIG');
    for (const secret of ['fixture-query', 'fixture-password', 'fixture-key']) expect(JSON.stringify(result)).not.toContain(secret);
  });
});
