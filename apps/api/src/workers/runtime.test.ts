import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { WorkerRuntime, type Worker } from './runtime.js';

const silent = pino({ level: 'silent' });

function recordingWorker(name: string, log: string[]): Worker {
  return {
    name,
    start: () => {
      log.push(`start:${name}`);
      return Promise.resolve();
    },
    stop: () => {
      log.push(`stop:${name}`);
      return Promise.resolve();
    },
  };
}

describe('WorkerRuntime', () => {
  it('starts every registered worker when enabled', async () => {
    const log: string[] = [];
    const runtime = new WorkerRuntime({ logger: silent, enabled: true });
    runtime.register(recordingWorker('scheduled', log));
    runtime.register(recordingWorker('outbox', log));

    await runtime.start();

    expect(log).toEqual(['start:scheduled', 'start:outbox']);
  });

  it('starts nothing when workers are disabled, so the same image can run API-only', async () => {
    const log: string[] = [];
    const runtime = new WorkerRuntime({ logger: silent, enabled: false });
    runtime.register(recordingWorker('scheduled', log));

    await runtime.start();

    expect(log).toEqual([]);
  });

  it('stops workers in reverse order of start', async () => {
    const log: string[] = [];
    const runtime = new WorkerRuntime({ logger: silent, enabled: true });
    runtime.register(recordingWorker('scheduled', log));
    runtime.register(recordingWorker('notifications', log));

    await runtime.start();
    log.length = 0;
    await runtime.stop();

    expect(log).toEqual(['stop:notifications', 'stop:scheduled']);
  });

  it('drains the remaining workers even when one fails to stop', async () => {
    const log: string[] = [];
    const runtime = new WorkerRuntime({ logger: silent, enabled: true });
    runtime.register(recordingWorker('scheduled', log));
    runtime.register({
      name: 'notifications-subscription',
      start: () => Promise.resolve(),
      stop: () => Promise.reject(new Error('provider socket hung')),
    });

    await runtime.start();
    log.length = 0;

    await expect(runtime.stop()).rejects.toThrow(AggregateError);
    // The sibling still drained: a half-finished job is the corruption to avoid.
    expect(log).toEqual(['stop:scheduled']);
  });

  it('does not stop the same worker twice', async () => {
    const log: string[] = [];
    const runtime = new WorkerRuntime({ logger: silent, enabled: true });
    runtime.register(recordingWorker('scheduled', log));

    await runtime.start();
    await runtime.stop();
    await runtime.stop();

    expect(log.filter((entry) => entry === 'stop:scheduled')).toHaveLength(1);
  });
});
