import { vi } from 'vitest';

/**
 * A working `localStorage` for tests.
 *
 * jsdom's own is inert in this environment: `window.localStorage` resolves to a bare
 * object carrying none of the `Storage` methods, so a test that leans on it asserts
 * nothing and a spy on `Storage.prototype` never fires. This installs a real in-memory
 * one instead.
 *
 * It can also be told to refuse, which is the branch worth having: a browser with storage
 * disabled, and Safari in private mode, *throw* rather than return null. Code that only
 * ever meets a working store looks correct right up until it takes the whole screen down
 * over a saved preference.
 */
export interface FakeLocalStorage {
  /** Every read and write throws, as a browser with storage switched off does. */
  readonly refuseEverything: () => void;
  /** Reads work, writes throw — the shape of a full or quota-limited store. */
  readonly refuseWrites: () => void;
}

export function installFakeLocalStorage(): FakeLocalStorage {
  const entries = new Map<string, string>();
  let readsThrow = false;
  let writesThrow = false;

  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => {
      if (readsThrow) throw new Error('storage is disabled');
      return entries.get(key) ?? null;
    },
    setItem: (key: string, value: string): void => {
      if (readsThrow || writesThrow) throw new Error('storage is disabled');
      entries.set(key, value);
    },
    removeItem: (key: string): void => {
      entries.delete(key);
    },
    clear: (): void => {
      entries.clear();
    },
    key: (index: number): string | null => [...entries.keys()][index] ?? null,
    get length(): number {
      return entries.size;
    },
  });

  return {
    refuseEverything: () => {
      readsThrow = true;
    },
    refuseWrites: () => {
      writesThrow = true;
    },
  };
}
