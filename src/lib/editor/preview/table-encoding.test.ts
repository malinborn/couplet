import { describe, it, expect } from 'vitest';
import {
  encodeForCommit,
  decodeForEdit,
  encodedOffset,
  decodedOffset,
} from './table-encoding';

describe('encodeForCommit', () => {
  it('NoSpecialChars_ReturnsUnchanged', () => {
    expect(encodeForCommit('hello world')).toBe('hello world');
  });

  it('SingleNewline_ConvertsToBrTag', () => {
    expect(encodeForCommit('line1\nline2')).toBe('line1<br>line2');
  });

  it('MultipleNewlines_EachConvertsToBr', () => {
    expect(encodeForCommit('a\nb\nc')).toBe('a<br>b<br>c');
  });

  it('TrailingNewlines_AreTrimmed', () => {
    expect(encodeForCommit('a\nb\n\n')).toBe('a<br>b');
  });

  it('Pipe_EscapedWithBackslash', () => {
    expect(encodeForCommit('a|b')).toBe('a\\|b');
  });

  it('PipeAndNewline_BothEscaped', () => {
    expect(encodeForCommit('a|b\nc|d')).toBe('a\\|b<br>c\\|d');
  });

  it('EmptyString_ReturnsEmpty', () => {
    expect(encodeForCommit('')).toBe('');
  });

  it('OnlyNewlines_ReturnsEmpty', () => {
    expect(encodeForCommit('\n\n')).toBe('');
  });

  it('CRLF_NormalizedToLF', () => {
    expect(encodeForCommit('a\r\nb\r\nc')).toBe('a<br>b<br>c');
  });

  it('LoneCR_NormalizedToLF', () => {
    expect(encodeForCommit('a\rb')).toBe('a<br>b');
  });
});

describe('decodeForEdit', () => {
  it('NoSpecialChars_ReturnsUnchanged', () => {
    expect(decodeForEdit('hello world')).toBe('hello world');
  });

  it('BrTag_ConvertsToNewline', () => {
    expect(decodeForEdit('line1<br>line2')).toBe('line1\nline2');
  });

  it('SelfClosingBr_ConvertsToNewline', () => {
    expect(decodeForEdit('a<br/>b')).toBe('a\nb');
  });

  it('BrWithSpaces_ConvertsToNewline', () => {
    expect(decodeForEdit('a<br />b')).toBe('a\nb');
  });

  it('BrUppercase_ConvertsToNewline', () => {
    expect(decodeForEdit('a<BR>b')).toBe('a\nb');
  });

  it('EscapedPipe_Unescaped', () => {
    expect(decodeForEdit('a\\|b')).toBe('a|b');
  });

  it('RoundTrip_PreservesContent', () => {
    const input = 'hello|world\nsecond line';
    expect(decodeForEdit(encodeForCommit(input))).toBe(input);
  });

  // Documented tradeoff (see spec): literal "<br>" typed by user becomes a
  // newline on next edit. Acceptable because GFM cells can't contain real
  // newlines so <br> is the only sensible roundtrip path.
  it('LiteralBrTagFromUser_BecomesNewline', () => {
    expect(decodeForEdit('see <br> tag')).toBe('see \n tag');
  });
});

/**
 * The comment button commits an open cell overlay before anchoring (#60), so
 * the selection has to survive the encoding: `|` becomes two characters and a
 * newline becomes four. An off-by-anything here points the comment at the
 * wrong words, and the re-anchor search on the next open then fails silently.
 */
describe('encodedOffset', () => {
  it('is the identity on plain text', () => {
    expect(encodedOffset('hello world', 6)).toBe(6);
  });

  it('counts the backslash an escaped pipe adds', () => {
    // "a|b" -> "a\\|b": everything after the pipe shifts by one.
    expect(encodedOffset('a|b', 1)).toBe(1);
    expect(encodedOffset('a|b', 2)).toBe(3);
    expect(encodedOffset('a|b', 3)).toBe(4);
  });

  it('counts the four characters a newline becomes', () => {
    expect(encodedOffset('a\nb', 2)).toBe(5);
  });

  it('agrees with encodeForCommit at the end of the string', () => {
    const cases = ['plain', 'a|b|c', 'one\ntwo', 'pipe | and\nline'];
    for (const value of cases) {
      expect(encodedOffset(value, value.length)).toBe(encodeForCommit(value).length);
    }
  });

  it('clamps into the trailing newlines the commit strips', () => {
    // encodeForCommit drops the trailing blank line, so there is no offset
    // past "ab" for a selection that reached into it to land on.
    expect(encodeForCommit('ab\n\n')).toBe('ab');
    expect(encodedOffset('ab\n\n', 4)).toBe(2);
  });

  it('is not confused by a newline that is not trailing', () => {
    // The strip is the one position-dependent step in the encoding; a mid
    // string newline must still cost its four characters.
    expect(encodeForCommit('a\nb\n')).toBe('a<br>b');
    expect(encodedOffset('a\nb\n', 3)).toBe(6);
  });

  it('clamps out-of-range offsets rather than going negative', () => {
    expect(encodedOffset('abc', -5)).toBe(0);
    expect(encodedOffset('abc', 99)).toBe(3);
  });
});

/**
 * The other direction (#53). A click parks the caret in a cell and computes its
 * offset against the cell's *source*; the field the first keystroke opens holds
 * the decoded form, so the offset has to be walked across the escapes.
 */
describe('decodedOffset', () => {
  it('is the identity when nothing is escaped', () => {
    expect(decodedOffset('hello', 0)).toBe(0);
    expect(decodedOffset('hello', 3)).toBe(3);
    expect(decodedOffset('hello', 5)).toBe(5);
  });

  it('counts a <br> as the one newline it decodes to', () => {
    // 'a<br>b' -> 'a\nb'
    expect(decodedOffset('a<br>b', 1)).toBe(1);
    expect(decodedOffset('a<br>b', 5)).toBe(2);
    expect(decodedOffset('a<br>b', 6)).toBe(3);
  });

  it('counts an escaped pipe as one character', () => {
    expect(decodedOffset('a\\|b', 4)).toBe(3);
  });

  it('resolves an offset inside an escape to just after it', () => {
    // There is no position between the '\\' and the '|' in the decoded text.
    expect(decodedOffset('a\\|b', 2)).toBe(2);
    expect(decodedOffset('a<br>b', 3)).toBe(2);
  });

  it('round-trips with encodedOffset on a decoded value', () => {
    const source = 'a<br>b\\|c';
    const decoded = decodeForEdit(source);
    for (let i = 0; i <= decoded.length; i++) {
      expect(decodedOffset(source, encodedOffset(decoded, i))).toBe(i);
    }
  });

  it('clamps out-of-range offsets rather than going negative', () => {
    expect(decodedOffset('abc', -5)).toBe(0);
    expect(decodedOffset('abc', 99)).toBe(3);
  });
});
