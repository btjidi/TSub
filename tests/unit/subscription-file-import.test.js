import { describe, expect, it } from 'vitest';
import { parseSubscriptionFile, SUBSCRIPTION_IMPORT_MAX_ITEMS } from '../../src/utils/subscriptionFileImport.js';

describe('subscription file import parser', () => {
  it('parses TXT names and URLs while rejecting node links and duplicates', () => {
    const result = parseSubscriptionFile([
      'https://one.example/sub',
      '备用源|https://two.example/sub?token=a,b',
      '节点,vmess://invalid',
      'https://one.example/sub'
    ].join('\n'), 'txt', ['https://existing.example/sub']);

    expect(result.subscriptions).toEqual([
      { name: '', url: 'https://one.example/sub' },
      { name: '备用源', url: 'https://two.example/sub?token=a,b' }
    ]);
    expect(result.duplicate).toBe(1);
    expect(result.invalid).toBe(1);
  });

  it('parses quoted CSV with localized headers', () => {
    const result = parseSubscriptionFile('名称,订阅链接\n"主力,高速","https://one.example/sub?a=1,b=2"\n备用,https://two.example/sub', 'csv');
    expect(result.subscriptions).toEqual([
      { name: '主力,高速', url: 'https://one.example/sub?a=1,b=2' },
      { name: '备用', url: 'https://two.example/sub' }
    ]);
  });

  it('parses JSON arrays and deduplicates existing URLs', () => {
    const result = parseSubscriptionFile(JSON.stringify([
      'https://one.example/sub',
      { name: '二号', url: 'https://two.example/sub' },
      { name: '已有', url: 'https://existing.example/sub' },
      { name: '错误', url: 'ftp://invalid.example/sub' }
    ]), 'json', ['https://existing.example/sub']);

    expect(result.subscriptions).toHaveLength(2);
    expect(result.duplicate).toBe(1);
    expect(result.invalid).toBe(1);
  });

  it('rejects unsupported formats and caps imported records', () => {
    expect(() => parseSubscriptionFile('https://example.com', 'yaml')).toThrow('unsupported-format');
    const content = Array.from({ length: SUBSCRIPTION_IMPORT_MAX_ITEMS + 2 }, (_, index) => `https://${index}.example/sub`).join('\n');
    const result = parseSubscriptionFile(content, 'txt');
    expect(result.subscriptions).toHaveLength(SUBSCRIPTION_IMPORT_MAX_ITEMS);
    expect(result.invalid).toBe(2);
  });
});
