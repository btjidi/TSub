import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAFFIC_NODE_DISPLAY,
  groupTrafficNodeItems,
  normalizeTrafficNodeDisplay,
  resolveTrafficNodeLabel,
  sanitizeTrafficNodeCustomLabel,
  TRAFFIC_NODE_LABELS
} from '../../functions/modules/traffic-node-settings.js';
import { migrateConfigSettings } from '../../functions/modules/utils.js';

describe('traffic node settings', () => {
  it('maps all sixteen fixed label styles', () => {
    expect(TRAFFIC_NODE_LABELS).toEqual({
      upload: { symbol: '↑', single: '上', short: '上行', full: '上行流量' },
      download: { symbol: '↓', single: '下', short: '下行', full: '下行流量' },
      total: { symbol: 'TOT', single: '总', short: '总计', full: '总计流量' },
      remaining: { symbol: 'REM', single: '剩', short: '剩余', full: '剩余流量' }
    });
    for (const [key, styles] of Object.entries(TRAFFIC_NODE_LABELS)) {
      for (const [style, label] of Object.entries(styles)) {
        expect(resolveTrafficNodeLabel(key, style)).toBe(label);
      }
    }
  });

  it('migrates missing and malformed values to safe defaults', () => {
    expect(normalizeTrafficNodeDisplay()).toEqual(DEFAULT_TRAFFIC_NODE_DISPLAY);
    expect(migrateConfigSettings({ enableTrafficNode: 'true' })).toMatchObject({
      enableTrafficNode: true,
      trafficNodeDisplay: DEFAULT_TRAFFIC_NODE_DISPLAY
    });
    expect(normalizeTrafficNodeDisplay({ upload: { enabled: false, label: '<script>' } }).upload)
      .toEqual({ enabled: false, label: 'symbol', customLabel: '' });
    expect(normalizeTrafficNodeDisplay({ layout: 'invalid' }).layout).toBe('two');
  });

  it('sanitizes and resolves bounded custom labels with safe fallbacks', () => {
    expect(sanitizeTrafficNodeCustomLabel('  上\u0000传  ')).toBe('上传');
    expect(resolveTrafficNodeLabel('upload', 'custom', '  上传  ')).toBe('上传');
    expect(resolveTrafficNodeLabel('upload', 'custom', '')).toBe('↑');
    expect(normalizeTrafficNodeDisplay({
      upload: { enabled: true, label: 'custom', customLabel: '  上传流量  ' }
    }).upload).toEqual({ enabled: true, label: 'custom', customLabel: '上传流量' });
    expect(normalizeTrafficNodeDisplay({
      upload: { enabled: true, label: 'custom', customLabel: '界'.repeat(24) }
    }).upload).toEqual({ enabled: true, label: 'custom', customLabel: '界'.repeat(24) });
    expect(normalizeTrafficNodeDisplay({
      upload: { enabled: true, label: 'custom', customLabel: '超'.repeat(25) }
    }).upload).toEqual({ enabled: true, label: 'symbol', customLabel: '' });
    expect(normalizeTrafficNodeDisplay({
      upload: { enabled: false, label: 'full', customLabel: '草稿' }
    }).upload).toEqual({ enabled: false, label: 'full', customLabel: '草稿' });
  });

  it('groups available metrics into one, two or four virtual nodes', () => {
    const items = [
      { key: 'upload', text: '↑ 1 GB' },
      { key: 'download', text: '↓ 2 GB' },
      { key: 'total', text: 'TOT 10 GB' },
      { key: 'remaining', text: 'REM 7 GB' }
    ];
    expect(groupTrafficNodeItems(items, 'one')).toEqual([items]);
    expect(groupTrafficNodeItems(items, 'two')).toEqual([items.slice(0, 2), items.slice(2)]);
    expect(groupTrafficNodeItems(items, 'four')).toEqual(items.map(item => [item]));
    expect(groupTrafficNodeItems(items, 'invalid')).toEqual([items.slice(0, 2), items.slice(2)]);
    expect(groupTrafficNodeItems(items.filter(item => item.key !== 'download'), 'two')).toEqual([
      [items[0]], items.slice(2)
    ]);
  });
});
