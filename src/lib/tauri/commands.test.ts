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
});

/**
 * A disk behind `invoke`: `file_exists`, `read_file`, `write_file` on a plain
 * record. `unreadable` paths exist but fail to read.
 */
function fakeDisk(files: Record<string, string>, unreadable: string[] = []): Record<string, string> {
  invoke.mockImplementation(async (cmd: string, args: { path: string; content?: string }) => {
    if (cmd === 'file_exists') return args.path in files || unreadable.includes(args.path);
    if (cmd === 'read_file') {
      if (unreadable.includes(args.path)) throw 'Cannot open: file is not valid text.';
      if (!(args.path in files)) throw 'No such file';
      return files[args.path];
    }
    if (cmd === 'write_file') {
      files[args.path] = args.content ?? '';
      return undefined;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return files;
}

const commands = () => invoke.mock.calls.map((c) => c[0] as string);

describe('writeDocument on a CSV path', () => {
  // A block body: an arrow returning the spy would hand vitest a cleanup hook, and it would call `invoke()`.
  beforeEach(() => {
    invoke.mockReset();
  });

  it('TakesTheDialectFromTheFileItReplaces_AndReturnsTheCanonicalTable', async () => {
    const disk = fakeDisk({ '/t/w.csv': '\uFEFFa;b\r\n1;2\r\n' });
    const baseline = await writeDocument('/t/w.csv', '| a | b |\n| - | - |\n| 1 |3|\n', 'lf');
    expect(disk['/t/w.csv']).toBe('\uFEFFa;b\r\n1;3\r\n');
    expect(baseline).toBe('| a | b |\n| - | - |\n| 1 | 3 |\n');
  });

  it('AMissingFileGetsTheDefaultDialect_AndAnUntouchedNewFileSavesEmpty', async () => {
    const disk = fakeDisk({});
    await writeDocument('/t/new.csv', '| a |\n| - |\n| 1 |\n', 'lf');
    expect(disk['/t/new.csv']).toBe('a\n1\n');
    expect(commands()).not.toContain('read_file');

    await expect(writeDocument('/t/new2.csv', newFileText('/t/new2.csv'), 'lf')).resolves.toBe(
      newFileText('/t/new2.csv')
    );
    expect(disk['/t/new2.csv']).toBe('');
  });

  it('AnExistingFileThatCannotBeRead_RejectsAndWritesNothing', async () => {
    fakeDisk({}, ['/t/locked.csv']);
    await expect(writeDocument('/t/locked.csv', '| a |\n| - |\n| 1 |\n', 'lf')).rejects.toBe(
      'Cannot open: file is not valid text.'
    );
    expect(commands()).not.toContain('write_file');
  });

  it('TableBuffer_ReturnsWhatTheNextReadReturns_SoItsOwnEchoIsIgnored', async () => {
    const path = '/t/echo.csv';
    const disk = fakeDisk({ [path]: 'a,b\n1,2\n' });
    const buffer = (await readDocument(path)).text.replace('| 2 |', '|xyz|'); // a cell commit leaves it unpadded
    const baseline = await writeDocument(path, buffer, 'lf');

    // The watcher fires on our own write and re-reads the file.
    const echo = (await readDocument(path)).text;
    expect(baseline).toBe(decodeFromDisk(path, disk[path], 'lf').text);
    expect(baseline).toBe(echo);
    expect(echo).not.toBe(buffer);

    expect(resolveExternalChange({ disk: echo, buffer, baseline, dismissedDisk: null })).toBe('ignore');
    // With the buffer itself as the baseline the echo would be taken for an
    // external change: the buffer "never diverged", so it would be reloaded.
    expect(resolveExternalChange({ disk: echo, buffer, baseline: buffer, dismissedDisk: null })).not.toBe(
      'ignore'
    );
  });

  it('RawButParseableBuffer_IsWrittenAsIs_ReturnsTheBuffer_AndItsEchoReloadsIntoATable', async () => {
    // A markdown note Save-As'd to .csv: not a table, but almost any text parses as CSV.
    const path = '/t/note.csv';
    const disk = fakeDisk({}, [path]); // exists but unreadable: a raw save must not even read it
    const buffer = '# Title\nsome text, more\n';
    const baseline = await writeDocument(path, buffer, 'lf');
    expect(baseline).toBe(buffer);
    expect(disk[path]).toBe(buffer);
    expect(commands()).not.toContain('read_file');

    const echo = decodeFromDisk(path, disk[path], 'lf').text;
    expect(echo).not.toBe(buffer); // it reads back as a table
    // Buffer === baseline: the echo takes the normal silent-reload path, and
    // the tab becomes the table the file now reads as.
    expect(resolveExternalChange({ disk: echo, buffer, baseline, dismissedDisk: null })).toBe('reload');
  });

  it('BrokenCsvText_IsWrittenAsIsInItsLineEnding_ReturnsTheBuffer', async () => {
    const disk = fakeDisk({ '/t/raw.csv': 'a,"open\r\n' });
    await expect(writeDocument('/t/raw.csv', 'a,"open\nmore\n', 'crlf')).resolves.toBe('a,"open\nmore\n');
    expect(disk['/t/raw.csv']).toBe('a,"open\r\nmore\r\n');
  });
});
