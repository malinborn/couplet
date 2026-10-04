import { describe, it, expect } from 'vitest';
import { createCsvNotices } from './csv-notice';
import type { CsvTableRefusal } from './csv-codec';

const BIG: CsvTableRefusal = { reason: 'too-large', rows: 100_000 };
const BROKEN: CsvTableRefusal = { reason: 'unparseable' };

describe('createCsvNotices — once per open tab', () => {
  it('open → tell; switch away and back → nothing; close → reopen → tell again', () => {
    const notices = createCsvNotices();
    expect(notices.settle('/a.csv', BIG, ['/a.csv'])).toEqual({ do: 'tell', refusal: BIG });
    // Another tab is shown, then this one again: the toast is not repeated.
    expect(notices.settle('/b.md', null, ['/a.csv', '/b.md'])).toEqual({ do: 'nothing' });
    expect(notices.settle('/a.csv', BIG, ['/a.csv', '/b.md'])).toEqual({ do: 'nothing' });
    // Closed: the next document shown no longer lists it.
    expect(notices.settle('/b.md', null, ['/b.md'])).toEqual({ do: 'nothing' });
    // Reopened — its own tab may not be in the list yet when it is configured.
    expect(notices.settle('/a.csv', BIG, ['/b.md'])).toEqual({ do: 'tell', refusal: BIG });
  });

  it('broken → fixed → broken: told, withdrawn, told again', () => {
    const notices = createCsvNotices();
    expect(notices.settle('/a.csv', BROKEN, ['/a.csv'])).toEqual({ do: 'tell', refusal: BROKEN });
    expect(notices.settle('/a.csv', null, ['/a.csv'])).toEqual({ do: 'withdraw' });
    expect(notices.settle('/a.csv', null, ['/a.csv'])).toEqual({ do: 'nothing' });
    expect(notices.settle('/a.csv', BROKEN, ['/a.csv'])).toEqual({ do: 'tell', refusal: BROKEN });
  });

  it('a document that was never told about has nothing to withdraw', () => {
    const notices = createCsvNotices();
    expect(notices.settle('/a.csv', null, ['/a.csv'])).toEqual({ do: 'nothing' });
    expect(notices.settle(null, null, [null])).toEqual({ do: 'nothing' });
  });

  it('each path separately', () => {
    const notices = createCsvNotices();
    expect(notices.settle('/a.csv', BIG, ['/a.csv', '/b.csv'])).toEqual({ do: 'tell', refusal: BIG });
    expect(notices.settle('/b.csv', BROKEN, ['/a.csv', '/b.csv'])).toEqual({ do: 'tell', refusal: BROKEN });
    expect(notices.settle('/a.csv', BIG, ['/a.csv', '/b.csv'])).toEqual({ do: 'nothing' });
  });
});
