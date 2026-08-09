import { describe, expect, it } from 'vitest';
import { filterNodesBySelection, nodeFingerprint, nodeSelectionIdentity, reconcileNodeSelection } from '../../functions/modules/utils/node-fingerprint.js';

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

  it('migrates a changed URL by unique protocol and node name', async () => {
    const previous = 'vless://uuid@192.0.2.1:443?security=tls#Tokyo';
    const current = 'vless://uuid@example.com:8443?security=tls&fp=chrome#Tokyo';
    const selection = { mode: 'include', fingerprints: [await nodeFingerprint(previous)], identities: [] };
    const result = await reconcileNodeSelection(selection, [current], { previousNodes: [previous] });
    expect(result.matchedCount).toBe(1);
    expect(result.nodeSelection.fingerprints).toEqual([await nodeFingerprint(current)]);
    expect(result.nodeSelection.identities).toEqual([{ protocol: 'vless', name: 'Tokyo' }]);
    expect(await filterNodesBySelection([current], result.nodeSelection)).toEqual([current]);
  });

  it('keeps a completely unmatched include selection empty', async () => {
    const previous = 'trojan://secret@example.com:443#Old';
    const current = 'trojan://secret@example.net:443#New';
    const result = await reconcileNodeSelection(
      { mode: 'include', fingerprints: [await nodeFingerprint(previous)], identities: [] },
      [current],
      { previousNodes: [previous] }
    );
    expect(result.nodeSelection).toEqual({ mode: 'include', fingerprints: [], identities: [] });
    expect(await filterNodesBySelection([current], result.nodeSelection)).toEqual([]);
  });

  it('does not migrate ambiguous nodes with the same protocol and name', async () => {
    const previous = 'vless://uuid@192.0.2.1:443#Shared';
    const current = ['vless://uuid@example.com:443#Shared', 'vless://uuid@example.net:443#Shared'];
    const result = await reconcileNodeSelection(
      { mode: 'include', fingerprints: [await nodeFingerprint(previous)], identities: [] },
      current,
      { previousNodes: [previous] }
    );
    expect(result.matchedCount).toBe(0);
  });

  it('preserves an unmatched identity for an intermediate Quick Tunnel snapshot', async () => {
    const previous = 'vless://uuid@old.trycloudflare.com:443#CDN';
    const selection = { mode: 'include', fingerprints: [await nodeFingerprint(previous)], identities: [] };
    const intermediate = await reconcileNodeSelection(selection, [], {
      previousNodes: [previous],
      preserveUnmatchedIdentities: true
    });
    expect(intermediate.nodeSelection).toEqual({
      mode: 'include',
      fingerprints: [],
      identities: [{ protocol: 'vless', name: 'CDN' }]
    });
    const finalNode = 'vless://uuid@new.trycloudflare.com:443#CDN';
    const final = await reconcileNodeSelection(intermediate.nodeSelection, [finalNode]);
    expect(final.nodeSelection.fingerprints).toEqual([await nodeFingerprint(finalNode)]);
  });

  it('migrates legacy Quick Tunnel names to the stable temporary-tunnel name', async () => {
    const current = 'vless://uuid@new.trycloudflare.com:443#Hong-Kong-vless-51237-%E4%B8%B4%E6%97%B6%E9%9A%A7%E9%81%93';
    const result = await reconcileNodeSelection(
      {
        mode: 'include',
        fingerprints: [],
        identities: [
          { protocol: 'vless', name: 'Hong-Kong-vless-51237-CDN-old-name.trycloudflare.com' },
          { protocol: 'vmess', name: 'Hong-Kong-vmess-51238-CDN' }
        ]
      },
      [current]
    );
    expect(result.matchedCount).toBe(1);
    expect(result.nodeSelection.identities).toEqual([
      { protocol: 'vless', name: 'Hong-Kong-vless-51237-临时隧道' }
    ]);
    expect(result.nodeSelection.fingerprints).toEqual([await nodeFingerprint(current)]);
  });

  it('normalizes legacy Quick Tunnel suffixes for regular and VMess nodes', () => {
    expect(nodeSelectionIdentity('vless://uuid@example.com:443#Node-CDN-random-name.trycloudflare.com')).toEqual({
      protocol: 'vless', name: 'Node-临时隧道'
    });
    const json = JSON.stringify({ v: '2', ps: 'Node-CDN', add: 'example.com', port: '443', id: 'uuid' });
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    expect(nodeSelectionIdentity(`vmess://${payload}`)).toEqual({ protocol: 'vmess', name: 'Node-临时隧道' });
  });

  it('normalizes VMess protocol and Unicode display names for identities', () => {
    const json = JSON.stringify({ v: '2', ps: '  Te\u0301st  ', add: 'example.com', port: '443', id: 'uuid' });
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    expect(nodeSelectionIdentity(`vmess://${payload}`)).toEqual({ protocol: 'vmess', name: 'T\u00e9st' });
  });
});
