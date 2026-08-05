import { describe, expect, it } from 'vitest';
import { filterNodesBySelection, nodeFingerprint } from '../../functions/modules/utils/node-fingerprint.js';

describe('Profile node selection fingerprints', () => {
  it('ignores display-name changes and filters explicit subsets', async () => {
    const first = 'vless://uuid@example.com:443?type=tcp#Singapore-A';
    const renamed = 'vless://uuid@example.com:443?type=tcp#Singapore-B';
    const other = 'trojan://secret@example.net:443#Other';
    const fingerprint = await nodeFingerprint(first);
    expect(await nodeFingerprint(renamed)).toBe(fingerprint);
    expect(await filterNodesBySelection([renamed, other], { mode: 'include', fingerprints: [fingerprint] })).toEqual([renamed]);
  });

  it('ignores VMess ps while preserving credential identity', async () => {
    const make = ps => `vmess://${btoa(JSON.stringify({ v: '2', ps, add: 'example.com', port: '443', id: 'uuid' }))}`;
    expect(await nodeFingerprint(make('Old'))).toBe(await nodeFingerprint(make('New')));
  });
});
