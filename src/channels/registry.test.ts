import { describe, it, expect } from 'vitest';

import {
  registerChannel,
  getChannelFactory,
  getRegisteredChannelNames,
} from './registry.js';

// The registry is module-level state, so we need a fresh module per test.
// We use dynamic import with cache-busting to isolate tests.
// However, since vitest runs each file in its own context and we control
// registration order, we can test the public API directly.

describe('channel registry', () => {
  // Note: registry is shared module state across tests in this file.
  // Tests are ordered to account for cumulative registrations.

  it('getChannelFactory returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent')).toBeUndefined();
  });

  it('registerChannel and getChannelFactory round-trip', () => {
    const factory = () => null;
    registerChannel('test-channel', factory);
    expect(getChannelFactory('test-channel')).toBe(factory);
  });

  it('getRegisteredChannelNames includes registered channels', () => {
    registerChannel('another-channel', () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain('test-channel');
    expect(names).toContain('another-channel');
  });

  it('rejects duplicate registrations', () => {
    const factory1 = () => null;
    const factory2 = () => null;
    registerChannel('duplicate-test', factory1);
    expect(() => registerChannel('duplicate-test', factory2)).toThrow(
      'Channel already registered: duplicate-test',
    );
    expect(getChannelFactory('duplicate-test')).toBe(factory1);
  });
});
