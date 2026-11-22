import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactElement, ReactNode } from 'react';

const sdk = {
  init: mock((_key: string, options: { loaded?: (client: typeof sdk) => void }) => {
    options.loaded?.(sdk);
  }),
  capture: mock(() => {}),
  identify: mock(() => {}),
  opt_in_capturing: mock(() => {}),
  opt_out_capturing: mock(() => {}),
  reset: mock(() => {}),
};
mock.module('posthog-js', () => ({ default: sdk }));

// Exercise main's rendered tree without mounting the app or accessing native sessions.
function render(node: ReactNode): void {
  if (Array.isArray(node)) {
    node.forEach(render);
  } else if (node && typeof node === 'object' && 'type' in node) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (typeof element.type === 'function') {
      render((element.type as (props: typeof element.props) => ReactNode)(element.props));
    } else {
      render(element.props.children);
    }
  }
}
const renderRoot = mock(render);
mock.module('react-dom/client', () => ({
  default: { createRoot: () => ({ render: renderRoot }) },
}));
mock.module('../src/App', () => ({ default: () => null }));
mock.module('../src/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
mock.module('../src/components/AnalyticsErrorBoundary', () => ({
  AnalyticsErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
// The real provider initializes in a React effect; model that SDK boundary so
// reintroducing an unconditional provider in main fails the startup assertion.
mock.module('posthog-js/react', () => ({
  PostHogProvider: ({ apiKey, options, children }: any) => {
    sdk.init(apiKey, options ?? {});
    return children;
  },
}));
mock.module('../src/assets/shimmer.css', () => ({}));
mock.module('../src/styles.css', () => ({}));
mock.module('../src/assets/nfo/asterisk-logo.png', () => ({ default: 'test-icon.png' }));

const { analytics, resourceMonitor } = await import('../src/lib/analytics');
const key = 'opcode-analytics-settings';
let stored: Map<string, string>;
let intervals: Map<number, { callback: () => void; ms: number }>;
let originalGlobals: Map<string, PropertyDescriptor | undefined>;
let nextInterval = 0;

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function monitoringIntervals(): number {
  return [...intervals.values()].filter(({ ms }) => ms === 120000).length;
}

beforeEach(() => {
  originalGlobals = new Map(
    ['localStorage', 'window', 'document', 'setInterval', 'clearInterval'].map(name =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  stored = new Map();
  intervals = new Map();
  setGlobal('localStorage', {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => stored.set(name, value),
    removeItem: (name: string) => stored.delete(name),
  });
  setGlobal('window', {});
  setGlobal('document', {
    documentElement: { classList: { add: () => {} } },
    querySelector: () => null,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    getElementById: () => ({}),
  });
  setGlobal('setInterval', (callback: () => void, ms: number) => {
    const id = ++nextInterval;
    intervals.set(id, { callback, ms });
    return id;
  });
  setGlobal('clearInterval', (id: number) => intervals.delete(id));
  // Keep singleton reset in tests, not as a production-only testing API.
  (analytics as unknown as { initialized: boolean }).initialized = false;
  Object.values(sdk).forEach(method => method.mockClear());
  renderRoot.mockClear();
});

afterEach(() => {
  analytics.shutdown();
  resourceMonitor.stopMonitoring();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function expectNoTelemetry(): void {
  analytics.setScreen('settings');
  analytics.track('test_event');
  analytics.identify({ anonymous: true });
  for (const { callback } of intervals.values()) callback();
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.capture).not.toHaveBeenCalled();
  expect(sdk.identify).not.toHaveBeenCalled();
  expect(sdk.opt_in_capturing).not.toHaveBeenCalled();
  expect(monitoringIntervals()).toBe(0);
}

describe('analytics startup and consent transitions', () => {
  test('the actual main entrypoint neither initializes nor captures before consent', async () => {
    await import('../src/main');
    await Promise.resolve();
    expect(renderRoot).toHaveBeenCalledTimes(1);
    expect(analytics.isEnabled()).toBe(false);
    expectNoTelemetry();
  });

  test.each([
    ['fresh storage', undefined],
    ['malformed JSON', '{invalid'],
    ['enabled without consent', JSON.stringify({ enabled: true, hasConsented: false })],
    ['truthy non-boolean consent', JSON.stringify({ enabled: true, hasConsented: 'false' })],
  ])('%s cannot initialize or capture telemetry', async (_name, value) => {
    if (value !== undefined) stored.set(key, value);
    await analytics.initialize();
    expectNoTelemetry();
  });

  test('blocked storage cannot initialize or capture telemetry', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('Storage blocked for test'); },
    });
    await analytics.initialize();
    expectNoTelemetry();
  });

  test('explicit opt-in starts monitoring without a restart, opt-out stops it', async () => {
    await analytics.initialize();
    expectNoTelemetry();
    await analytics.enable();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(monitoringIntervals()).toBe(1);
    analytics.setScreen('consented_screen');
    expect(sdk.capture).toHaveBeenCalledWith('$screen', { $screen_name: 'consented_screen' });

    await analytics.disable();
    expect(sdk.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(monitoringIntervals()).toBe(0);
    sdk.capture.mockClear();
    sdk.identify.mockClear();
    analytics.setScreen('disabled_screen');
    analytics.track('disabled_event');
    analytics.identify();
    for (const { callback } of intervals.values()) callback();
    expect(sdk.capture).not.toHaveBeenCalled();
    expect(sdk.identify).not.toHaveBeenCalled();

    await analytics.enable();
    expect(monitoringIntervals()).toBe(1);
  });

  test('persisted explicit consent starts monitoring during initialization', async () => {
    stored.set(key, JSON.stringify({ enabled: true, hasConsented: true }));
    await analytics.initialize();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(monitoringIntervals()).toBe(1);
  });

  test('deleting data stops monitoring and opts out of the initialized SDK', async () => {
    await analytics.initialize();
    await analytics.enable();
    await analytics.deleteAllData();
    expect(analytics.isEnabled()).toBe(false);
    expect(analytics.hasConsented()).toBe(false);
    expect(sdk.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(sdk.reset).toHaveBeenCalledTimes(1);
    expect(monitoringIntervals()).toBe(0);
  });
});
