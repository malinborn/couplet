import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  applyLineEnding,
  detectLineEnding,
  fromDisk,
  normalizeLineEndings,
} from './line-endings';
import { resolveExternalChange } from './external-change';

describe('detectLineEnding', () => {
  it('Lf', () => {
    expect(detectLineEnding('a\nb\n')).toBe('lf');
  });

  it('Crlf', () => {
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf');
  });

  it('LoneCr_ClassicMac', () => {
    expect(detectLineEnding('a\rb\r')).toBe('cr');
  });

  it('Empty_IsTheFallback', () => {
    expect(detectLineEnding('')).toBe('lf');
    expect(detectLineEnding('', 'crlf')).toBe('crlf');
  });

  it('NoNewline_IsTheFallback', () => {
    // A single line says nothing about the file's convention — a CRLF file
    // briefly edited down to one line must not become LF on the next save.
    expect(detectLineEnding('just one line')).toBe('lf');
    expect(detectLineEnding('just one line', 'crlf')).toBe('crlf');
  });

  it('Mixed_DominantWins', () => {
    expect(detectLineEnding('a\nb\r\nc\r\nd\r\n')).toBe('crlf');
    expect(detectLineEnding('a\r\nb\nc\nd\n')).toBe('lf');
  });

  it('Mixed_TieGoesToTheFirstSeen', () => {
    expect(detectLineEnding('a\r\nb\nc')).toBe('crlf');
    expect(detectLineEnding('a\nb\r\nc')).toBe('lf');
  });

  it('CrlfIsNotCountedAsACrPlusAnLf', () => {
    // One `\r\n` is one CRLF, not one CR and one LF — otherwise every CRLF file
    // would read as a three-way tie.
    expect(detectLineEnding('a\r\nb')).toBe('crlf');
    expect(detectLineEnding('a\r\n\r\nb\n')).toBe('crlf');
  });
});

describe('normalizeLineEndings', () => {
  it('ConvertsCrlfAndLoneCrToLf', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('LeavesLfTextAlone', () => {
    expect(normalizeLineEndings('a\nb\n')).toBe('a\nb\n');
    expect(normalizeLineEndings('')).toBe('');
  });

  it('CrCrLf_IsTwoLineBreaks', () => {
    // Same reading CM6 gives it: `\r` then `\r\n`.
    expect(normalizeLineEndings('a\r\r\nb')).toBe('a\n\nb');
  });

  it('MatchesWhatCodeMirrorBuilds', () => {
    // The whole contract: after normalization the string and the CM6
    // document have the same length, so offsets computed on one are valid in
    // the other.
    for (const raw of ['a\r\nb\r\n', 'a\rb\r', 'x\r\ny\nz\rw', '\r\n\r\n', 'plain']) {
      const doc = EditorState.create({ doc: raw }).doc;
      expect(doc.toString()).toBe(normalizeLineEndings(raw));
      expect(doc.length).toBe(normalizeLineEndings(raw).length);
    }
  });
});

describe('applyLineEnding', () => {
  it('Lf_IsIdentity', () => {
    expect(applyLineEnding('a\nb\n', 'lf')).toBe('a\nb\n');
  });

  it('Crlf', () => {
    expect(applyLineEnding('a\nb\n', 'crlf')).toBe('a\r\nb\r\n');
  });

  it('Cr', () => {
    expect(applyLineEnding('a\nb\n', 'cr')).toBe('a\rb\r');
  });

  it('NeverDoublesAStrayCr', () => {
    expect(applyLineEnding('a\r\nb', 'crlf')).toBe('a\r\nb');
  });

  it('EmptyAndNoNewline', () => {
    expect(applyLineEnding('', 'crlf')).toBe('');
    expect(applyLineEnding('one', 'crlf')).toBe('one');
  });
});

describe('disk round trip', () => {
  it('CrlfFile_OpenedEditedAndSaved_StaysCrlf', () => {
    const raw = '# Title\r\n\r\n- one\r\n- two\r\n';
    const disk = fromDisk(raw);
    expect(disk).toEqual({ text: '# Title\n\n- one\n- two\n', lineEnding: 'crlf' });

    // Into the editor, a keystroke at the end of "- two", back out.
    let state = EditorState.create({ doc: disk.text });
    const at = state.doc.line(4).to;
    state = state.update({ changes: { from: at, insert: '\n- three' } }).state;

    expect(applyLineEnding(state.doc.toString(), disk.lineEnding)).toBe(
      '# Title\r\n\r\n- one\r\n- two\r\n- three\r\n'
    );
  });

  it('LfFile_StaysLf', () => {
    const disk = fromDisk('a\nb\n');
    expect(disk.lineEnding).toBe('lf');
    expect(applyLineEnding(disk.text, disk.lineEnding)).toBe('a\nb\n');
  });

  it('CrFile_StaysCr', () => {
    const disk = fromDisk('a\rb\r');
    expect(applyLineEnding(disk.text, disk.lineEnding)).toBe('a\rb\r');
  });

  it('OurOwnCrlfSave_EchoesBackAsNoChange', () => {
    // The watcher fires on our own write. Its CRLF bytes, normalized at the
    // read boundary, must match the LF baseline the save recorded — otherwise
    // every autosave of a Windows file would look like an external edit.
    const buffer = 'a\nb\n';
    const written = applyLineEnding(buffer, 'crlf');
    const echo = fromDisk(written, 'crlf');
    expect(
      resolveExternalChange({ disk: echo.text, buffer, baseline: buffer, dismissedDisk: null })
    ).toBe('ignore');
    expect(echo.lineEnding).toBe('crlf');
  });
});
