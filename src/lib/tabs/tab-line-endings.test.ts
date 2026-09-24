import { describe, it, expect } from 'vitest';
import { createTabLineEndings } from './tab-line-endings';
import { fromDisk } from '../line-endings';

describe('createTabLineEndings', () => {
  it('AnswersLfForAFileNeverReadAndForUntitled', () => {
    const endings = createTabLineEndings();
    expect(endings.of('/a.md')).toBe('lf');
    expect(endings.of(null)).toBe('lf');
  });

  it('RemembersTheEndingOfEveryRead_AndHandsBackLfText', () => {
    // A background tab's agent edit is written with this: a CRLF file stays CRLF.
    const endings = createTabLineEndings();
    expect(endings.record('/win.md', fromDisk('a\r\nb\r\n'))).toBe('a\nb\n');
    expect(endings.of('/win.md')).toBe('crlf');
  });

  it('FollowsARereadThatOnlyChangedTheEndings', () => {
    const endings = createTabLineEndings();
    endings.record('/a.md', fromDisk('a\r\nb'));
    endings.record('/a.md', fromDisk('a\nb'));
    expect(endings.of('/a.md')).toBe('lf');
  });

  it('HandOverKeepsWhatTheLeavingTabsEndingBecame_AndAnswersTheArrivingOne', () => {
    const endings = createTabLineEndings();
    endings.record('/a.md', fromDisk('x\ny'));
    endings.record('/b.md', fromDisk('x\r\ny'));
    // `/a.md` became CRLF while shown (an external conversion followed).
    expect(endings.handOver({ path: '/a.md', lineEnding: 'crlf' }, '/b.md')).toBe('crlf');
    expect(endings.of('/a.md')).toBe('crlf');
    expect(endings.handOver({ path: '/b.md', lineEnding: 'crlf' }, null)).toBe('lf');
  });

  it('HandOverToTheSamePathKeepsTheFreshRead', () => {
    // Re-shown after a fresh load: the read that just landed is newer than
    // what the view held.
    const endings = createTabLineEndings();
    endings.record('/a.md', fromDisk('x\r\ny'));
    expect(endings.handOver({ path: '/a.md', lineEnding: 'lf' }, '/a.md')).toBe('crlf');
  });

  it('HandOverFromUntitledRecordsNothing', () => {
    const endings = createTabLineEndings();
    expect(endings.handOver({ path: null, lineEnding: 'crlf' }, '/a.md')).toBe('lf');
    expect(endings.of(null)).toBe('lf');
  });
});
