import { STORAGE_TYPES, StorageFactory } from '../storage-adapter.js';

export const PLATFORM_TYPES = Object.freeze({
  CLOUDFLARE: 'cloudflare',
  SERVER: 'server'
});

export const FULL_STORAGE_TYPES = new Set([
  STORAGE_TYPES.D1,
  STORAGE_TYPES.SQLITE,
  STORAGE_TYPES.POSTGRES
]);

export function detectPlatform(env = {}) {
  return env.TSUB_PLATFORM === PLATFORM_TYPES.SERVER
    ? PLATFORM_TYPES.SERVER
    : PLATFORM_TYPES.CLOUDFLARE;
}

export async function getPlatformCapabilities(env = {}) {
  const platform = detectPlatform(env);
  const storageType = await StorageFactory.getStorageType(env);
  const fullMode = FULL_STORAGE_TYPES.has(storageType);
  const localExecutor = platform === PLATFORM_TYPES.SERVER && Boolean(env.TSUB_LOCAL_EXECUTOR_SOCKET);

  return {
    platform,
    storageType,
    mode: fullMode ? 'full' : 'basic',
    features: {
      manualBootstrap: true,
      activePush: true,
      rowLevelDeployments: fullMode,
      concurrentPushTransactions: fullMode,
      remoteAgent: fullMode,
      remoteCommands: fullMode,
      heartbeats: fullMode,
      localExecutor
    },
    database: {
      switchTargets: platform === PLATFORM_TYPES.SERVER
        ? ['sqlite', 'postgres']
        : ['kv', 'd1'],
      multiInstance: storageType === STORAGE_TYPES.POSTGRES
    }
  };
}

export async function requireFullControl(env = {}) {
  const capabilities = await getPlatformCapabilities(env);
  return capabilities.mode === 'full' ? null : capabilities;
}
