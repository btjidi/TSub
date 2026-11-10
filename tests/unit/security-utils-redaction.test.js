import { describe, expect, it } from 'vitest';
import { redactErrorMessage, redactSensitiveObject, redactSensitiveText, redactUrl } from '../../functions/modules/security-utils.js';

describe('security log redaction', () => {
  it('redacts bearer credentials and sensitive URL parameters in text', () => {
    const input = 'request failed: Bearer abc.DEF-123 https://example.com/api?token=secret-value&mode=test';
    const output = redactSensitiveText(input);

    expect(output).not.toContain('abc.DEF-123');
    expect(output).not.toContain('secret-value');
    expect(output).toContain('Bearer [REDACTED]');
  });

  it('redacts credentials embedded in error message and stack fields', () => {
    const output = redactSensitiveObject({
      message: 'authorization=top-secret',
      stack: 'fetch https://example.com/api/deploy/run/abcdefghijklmnop.sh failed'
    });

    expect(output.message).not.toContain('top-secret');
    expect(output.stack).not.toContain('abcdefghijklmnop');
  });

  it('redacts subscription URL credentials and token-bearing path segments', () => {
    const output = redactUrl('https://user:password@example.com/subscribe/long-secret-token?token=query-secret#fragment');

    expect(output).toContain('example.com');
    expect(output).not.toContain('user');
    expect(output).not.toContain('password');
    expect(output).not.toContain('long-secret-token');
    expect(output).not.toContain('query-secret');
  });

  it('redacts proxy URI credentials and private config fields while keeping endpoint hints', () => {
    const input = [
      'failed vless://12345678-1234-1234-1234-123456789abc@example.net:443?security=reality&pbk=private-public#node',
      'uuid: 12345678-1234-1234-1234-123456789abc',
      'private_key: wireguard-private-value'
    ].join('\n');
    const output = redactSensitiveText(input);

    expect(output).toContain('vless://example.net:443');
    expect(output).not.toContain('12345678-1234-1234-1234-123456789abc');
    expect(output).not.toContain('wireguard-private-value');
    expect(output).not.toContain('pbk=private-public');
  });

  it('redacts node links from error messages', () => {
    const output = redactErrorMessage(new Error('invalid node ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@nodes.example:8388#secret'));

    expect(output).toContain('ss://[REDACTED]');
    expect(output).not.toContain('password');
    expect(output).not.toContain('secret');
  });

  it('redacts quoted fields, cookies, multiline keys and numeric credentials', () => {
    const text = [
      'Cookie: session=fixture-session; other=fixture-cookie',
      'Authorization: Basic dXNlcjpwYXNz',
      '{"password": "fixture password with spaces", "private_key": "fixture-private"}',
      '-----BEGIN PRIVATE KEY-----\nfixture-pem\n-----END PRIVATE KEY-----'
    ].join('\n');
    const output = redactSensitiveText(text);
    for (const secret of ['fixture-session', 'fixture-cookie', 'dXNlcjpwYXNz', 'fixture password', 'fixture-private', 'fixture-pem']) {
      expect(output).not.toContain(secret);
    }
    expect(redactSensitiveObject({ password: 123456, credentials: { user: 'fixture-user' } }).password).toBe('[REDACTED]');
  });

  it('handles nested Error objects, arrays and cycles without exposing secrets or mutating input', () => {
    const list = [];
    list.push(new Error('https://example.com/a?token=fixture-query'), list);
    const value = { list, secret: { nested: 'fixture-value' } };
    const output = redactSensitiveObject(value);
    expect(JSON.stringify(output)).not.toContain('fixture-query');
    expect(JSON.stringify(output)).not.toContain('fixture-value');
    expect(output.list[1]).toBe('[REDACTED]');
    expect(value.secret.nested).toBe('fixture-value');
  });
});
