import { describe, expect, it } from 'vitest';
import { redactSensitiveObject, redactSensitiveText } from '../../functions/modules/security-utils.js';

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
});
