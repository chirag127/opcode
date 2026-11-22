import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ConsentManager } from '../src/lib/analytics/consent';

const key = 'opcode-analytics-settings';
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let stored: Map<string, string>;
const manager = ConsentManager.getInstance();

beforeEach(() => {
  stored = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => stored.set(name, value),
      removeItem: (name: string) => stored.delete(name),
    },
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('analytics requires explicit consent', () => {
  test('fresh installation starts disabled', async () => {
    const settings = await manager.initialize();
    expect(settings.enabled).toBe(false);
    expect(settings.hasConsented).toBe(false);
    expect(manager.isEnabled()).toBe(false);
  });

  test('explicit opt-in and opt-out work', async () => {
    await manager.initialize();
    await manager.grantConsent();
    expect(manager.isEnabled()).toBe(true);
    await manager.revokeConsent();
    expect(manager.isEnabled()).toBe(false);
  });

  test('deleting analytics data does not opt back in', async () => {
    await manager.initialize();
    await manager.grantConsent();
    await manager.deleteAllData();
    expect(manager.isEnabled()).toBe(false);
    expect(manager.hasConsented()).toBe(false);
    expect(JSON.parse(stored.get(key)!).enabled).toBe(false);
  });

  test('malformed storage revokes previously loaded consent', async () => {
    await manager.initialize();
    await manager.grantConsent();
    stored.set(key, '{invalid');
    expect((await manager.initialize()).enabled).toBe(false);
    expect(manager.isEnabled()).toBe(false);
  });

  test('blocked storage fails closed', async () => {
    await manager.initialize();
    await manager.grantConsent();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('Storage blocked for test'); },
    });
    expect((await manager.initialize()).enabled).toBe(false);
    expect(manager.isEnabled()).toBe(false);
  });

  test('enabled alone is not consent', async () => {
    stored.set(key, JSON.stringify({ enabled: true, hasConsented: false }));
    await manager.initialize();
    expect(manager.isEnabled()).toBe(false);
  });
});
