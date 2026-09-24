import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const { readDocument, writeDocument } = await import('./commands');

describe('document read/write boundary', () => {
  beforeEach(() => invoke.mockReset());

  it('ReadDocument_NormalizesCrlfAndReportsIt', async () => {
    invoke.mockResolvedValueOnce('a\r\nb\r\n');
    await expect(readDocument('/x.md')).resolves.toEqual({ text: 'a\nb\n', lineEnding: 'crlf' });
    expect(invoke).toHaveBeenCalledWith('read_file', { path: '/x.md' });
  });

  it('ReadDocument_NoNewline_KeepsTheFallback', async () => {
    invoke.mockResolvedValueOnce('one line');
    await expect(readDocument('/x.md', 'crlf')).resolves.toEqual({
      text: 'one line',
      lineEnding: 'crlf',
    });
  });

  it('ReadDocument_PropagatesTheBackendError', async () => {
    // The open path turns this into an `open-error` toast; it must arrive
    // intact, since the message is the only explanation the user gets.
    invoke.mockRejectedValueOnce('Cannot open: file is not valid text.');
    await expect(readDocument('/x.bin')).rejects.toBe('Cannot open: file is not valid text.');
  });

  it('WriteDocument_RestoresCrlf', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await writeDocument('/x.md', 'a\nb\n', 'crlf');
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/x.md', content: 'a\r\nb\r\n' });
  });

  it('WriteDocument_LfIsUnchanged', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await writeDocument('/x.md', 'a\nb\n', 'lf');
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/x.md', content: 'a\nb\n' });
  });
});
