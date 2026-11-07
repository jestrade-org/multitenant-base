import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { installShutdownHandlers, type ShutdownStep } from './shutdown.js';

const silent = pino({ level: 'silent' });

function step(name: string, log: string[], behaviour?: () => Promise<void>): ShutdownStep {
  return {
    name,
    run: async () => {
      log.push(name);
      await (behaviour?.() ?? Promise.resolve());
    },
  };
}

describe('graceful shutdown', () => {
  it('drains readiness before tearing anything down', async () => {
    const log: string[] = [];
    const shutdown = installShutdownHandlers({
      logger: silent,
      timeoutMs: 1000,
      beginDraining: () => log.push('drain'),
      steps: [step('http-server', log), step('workers', log)],
      exit: () => undefined,
    });

    await shutdown();

    expect(log).toEqual(['drain', 'http-server', 'workers']);
  });

  it('runs steps in order: stop serving, then stop working, then release resources', async () => {
    const log: string[] = [];
    const shutdown = installShutdownHandlers({
      logger: silent,
      timeoutMs: 1000,
      beginDraining: () => undefined,
      steps: [step('http-server', log), step('workers', log), step('infrastructure', log)],
      exit: () => undefined,
    });

    await shutdown();

    expect(log).toEqual(['http-server', 'workers', 'infrastructure']);
  });

  it('exits zero when the sequence completes', async () => {
    const exit = vi.fn();
    const shutdown = installShutdownHandlers({
      logger: silent,
      timeoutMs: 1000,
      beginDraining: () => undefined,
      steps: [step('http-server', [])],
      exit,
    });

    await shutdown();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('gives up loudly instead of hanging past the deadline', async () => {
    const exit = vi.fn();
    const shutdown = installShutdownHandlers({
      logger: silent,
      timeoutMs: 20,
      beginDraining: () => undefined,
      steps: [
        step('workers', [], () => new Promise((resolve) => setTimeout(resolve, 5_000).unref())),
      ],
      exit,
    });

    await shutdown();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits non-zero when a shutdown step throws', async () => {
    const exit = vi.fn();
    const shutdown = installShutdownHandlers({
      logger: silent,
      timeoutMs: 1000,
      beginDraining: () => undefined,
      steps: [step('workers', [], () => Promise.reject(new Error('queue refused to drain')))],
      exit,
    });

    await shutdown();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ignores a second signal instead of tearing down twice', async () => {
    const log: string[] = [];
    const shutdown = installShutdownHandlers({
      logger: silent,
      timeoutMs: 1000,
      beginDraining: () => undefined,
      steps: [step('http-server', log)],
      exit: () => undefined,
    });

    await shutdown();
    await shutdown();

    expect(log).toEqual(['http-server']);
  });
});
