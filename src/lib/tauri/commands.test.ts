import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const { readDocument, writeDocument } = await import('./commands');
const { decodeFromDisk, newFileText } = await import('../csv/csv-codec');
const { resolveExternalChange } = await import('../external-change');

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

  it('ReadDocument_Csv_DecodesToATable', async () => {
    invoke.mockResolvedValueOnce('a;b\r\n1;2\r\n');
    const doc = await readDocument('/t/read.csv');
    expect(doc).toEqual({ text: '| a | b |\n| - | - |\n| 1 | 2 |\n', lineEnding: 'lf' });
  });

  it('WriteDocument_NonCsv_ReadsNothingAndReturnsTheBuffer', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await expect(writeDocument('/x.md', 'a\nb\n', 'crlf')).resolves.toBe('a\nb\n');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('WriteDocument_Csv_TakesTheDialectFromTheFileItReplaces', async () => {
    invoke.mockResolvedValueOnce('\uFEFFa;b\r\n1;2\r\n'); // read_file of the current file
    invoke.mockResolvedValueOnce(undefined); // write_file
    await writeDocument('/t/write.csv', '| a | b |\n| - | - |\n| 1 |3|\n', 'lf');
    expect(invoke).toHaveBeenNthCalledWith(1, 'read_file', { path: '/t/write.csv' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'write_file', {
      path: '/t/write.csv',
      content: '\uFEFFa;b\r\n1;3\r\n',
    });
  });

  it('WriteDocument_Csv_NoFileYet_UsesTheDefault_AndAnUntouchedNewFileSavesEmpty', async () => {
    invoke.mockRejectedValueOnce('No such file');
    invoke.mockResolvedValueOnce(undefined);
    await writeDocument('/t/new.csv', '| a |\n| - |\n| 1 |\n', 'lf');
    expect(invoke).toHaveBeenLastCalledWith('write_file', { path: '/t/new.csv', content: 'a\n1\n' });

    invoke.mockRejectedValueOnce('No such file');
    invoke.mockResolvedValueOnce(undefined);
    await expect(writeDocument('/t/new.csv', newFileText('/t/new.csv'), 'lf')).resolves.toBe(
      newFileText('/t/new.csv')
    );
    expect(invoke).toHaveBeenLastCalledWith('write_file', { path: '/t/new.csv', content: '' });
  });

  it('WriteDocument_Csv_ReturnsWhatTheNextReadReturns_SoItsOwnEchoIsIgnored', async () => {
    const path = '/t/echo.csv';
    invoke.mockResolvedValueOnce('a,b\n1,2\n');
    const buffer = (await readDocument(path)).text.replace('| 2 |', '|xyz|'); // a cell commit leaves it unpadded
    invoke.mockResolvedValueOnce('a,b\n1,2\n');
    invoke.mockResolvedValueOnce(undefined);
    const baseline = await writeDocument(path, buffer, 'lf');
    const written = invoke.mock.calls[invoke.mock.calls.length - 1][1] as { content: string };

    // The watcher fires on our own write and re-reads the file.
    invoke.mockResolvedValueOnce(written.content);
    const disk = (await readDocument(path)).text;
    expect(baseline).toBe(decodeFromDisk(path, written.content, 'lf').text);
    expect(baseline).toBe(disk);
    expect(disk).not.toBe(buffer);

    expect(resolveExternalChange({ disk, buffer, baseline, dismissedDisk: null })).toBe('ignore');
    // With the buffer itself as the baseline the echo would be taken for an
    // external change: the buffer "never diverged", so it would be reloaded.
    expect(resolveExternalChange({ disk, buffer, baseline: buffer, dismissedDisk: null })).not.toBe(
      'ignore'
    );
  });

  it('WriteDocument_Csv_NotATable_WritesItAsIs', async () => {
    invoke.mockResolvedValueOnce('a,"open\r\n');
    invoke.mockResolvedValueOnce(undefined);
    await expect(writeDocument('/t/raw.csv', 'a,"open\nmore\n', 'crlf')).resolves.toBe('a,"open\nmore\n');
    expect(invoke).toHaveBeenLastCalledWith('write_file', { path: '/t/raw.csv', content: 'a,"open\r\nmore\r\n' });
  });
});
