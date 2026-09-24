import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSerialQueue } from './serial-queue';

describe('createSerialQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('RunsTasksOneAfterAnotherInSubmissionOrder', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = queue.run(async () => {
      log.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      log.push('first:end');
    });
    const second = queue.run(async () => {
      log.push('second');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(log).toEqual(['first:start', 'first:end', 'second']);
  });

  it('ARejectingTaskDoesNotBlockTheNext', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = createSerialQueue();
    void queue.run(async () => {
      throw new Error('boom');
    });
    const next = await queue.run(async () => 42);
    expect(next).toBe(42);
  });

  it('TheReturnedPromiseResolvesEvenWhenTheTaskRejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = createSerialQueue();
    await expect(
      queue.run(async () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });
});
