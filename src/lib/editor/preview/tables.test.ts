import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { EditorView } from '@codemirror/view';
import { headingSlugsField } from '../heading-slugs';
import {
  cellEditWidth,
  parseCellsWithPositions,
  parseInlineMarkdown,
  routeLinkClick,
  tableToGrid,
  type CellInfo,
  type RowData,
  type TableContext,
} from './tables.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RowData for use in TableContext fixtures. */
function makeRow(
  overrides: Partial<RowData> & { cells: CellInfo[] }
): RowData {
  return {
    from: 0,
    to: 10,
    text: '',
    isDelimiter: false,
    isHeader: false,
    rowIndex: 0,
    ...overrides,
  };
}

/** Build a minimal TableContext. */
function makeCtx(rows: RowData[]): TableContext {
  return {
    rows,
    colWidths: [],
    colCount: 3,
    nodeFrom: 0,
    nodeTo: 100,
  };
}

// ---------------------------------------------------------------------------
// parseCellsWithPositions
// ---------------------------------------------------------------------------

describe('parseCellsWithPositions', () => {
  // -- Normal row -----------------------------------------------------------

  it('NormalRow_ThreeCells_ReturnsThreeCells', () => {
    const text = '| Alice | Engineer | Active |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(3);
    expect(cells[0].text).toBe('Alice');
    expect(cells[1].text).toBe('Engineer');
    expect(cells[2].text).toBe('Active');
  });

  it('NormalRow_ThreeCells_ReturnsCorrectFromPositions', () => {
    // text:  | Alice | Engineer | Active |
    // idx:   0123456789...
    // lineFrom = 0
    // After leading '|', cell 0 starts at index 1: ' Alice '
    //   raw = ' Alice ', trimmed = 'Alice', leadSpaces = 1
    //   from = 0 + 1 + 1 = 2, to = 2 + 5 = 7
    const text = '| Alice | Engineer | Active |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells[0].from).toBe(2);
    expect(cells[0].to).toBe(7);
  });

  it('NormalRow_ThreeCells_ReturnsCorrectToPositions', () => {
    const text = '| Alice | Engineer | Active |';
    const cells = parseCellsWithPositions(text, 0);

    // '| Alice | Engineer | Active |'
    //  0       8          19
    // The '|' closing cell 0 is at index 8; cellStart for cell 1 = 9.
    // raw = ' Engineer ' (indices 9–18), leadSpaces = 1
    // from = 0 + 9 + 1 = 10, to = 10 + 8 ('Engineer') = 18
    expect(cells[1].from).toBe(10);
    expect(cells[1].to).toBe(18);
  });

  it('NormalRow_LineFromOffset_PositionsAreAbsolute', () => {
    const text = '| Alice | Bob |';
    const lineFrom = 50;
    const cells = parseCellsWithPositions(text, lineFrom);

    // Cell 0: raw = ' Alice ', leadSpaces = 1, cellStart = 1
    // from = 50 + 1 + 1 = 52
    expect(cells[0].from).toBe(52);
    expect(cells[0].to).toBe(57); // 52 + 5 ('Alice')
  });

  // -- Empty cells ----------------------------------------------------------

  it('EmptyCells_ThreeEmpty_ReturnsThreeCells', () => {
    const text = '|   |   |   |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(3);
  });

  it('EmptyCells_EmptyText_TextIsEmptyString', () => {
    const text = '|   |   |   |';
    const cells = parseCellsWithPositions(text, 0);

    for (const cell of cells) {
      expect(cell.text).toBe('');
    }
  });

  it('EmptyCells_FromEqualsTo_PointsInsideCell', () => {
    const text = '|   |   |   |';
    // Cell 0: raw = '   ', cellStart = 1, midpoint = 0 + 1 + floor(3/2) = 2
    const cells = parseCellsWithPositions(text, 0);

    expect(cells[0].from).toBe(cells[0].to);
  });

  it('EmptyCells_Midpoint_CalculatedCorrectly', () => {
    const text = '|   |   |   |';
    // cellStart for cell 0 = 1 (after leading '|')
    // raw = '   ' (3 chars), midpoint = 0 + 1 + floor(3/2) = 2
    const cells = parseCellsWithPositions(text, 0);

    expect(cells[0].from).toBe(2);
  });

  // -- Row with dashes (data row, NOT delimiter) ----------------------------

  it('DashRow_CellsContainDashes_ParsedAsNormalCells', () => {
    const text = '| - | - | - |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(3);
    expect(cells[0].text).toBe('-');
    expect(cells[1].text).toBe('-');
    expect(cells[2].text).toBe('-');
  });

  it('DashRow_DelimiterStyle_ParsedAsNormalCells', () => {
    // A realistic GFM delimiter row — parseCellsWithPositions should treat it
    // identically to any other row; delimiter classification is done by position.
    const text = '| --- | --- | --- |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(3);
    expect(cells[0].text).toBe('---');
  });

  it('DashRow_AlignedDelimiter_ParsedAsNormalCells', () => {
    const text = '| :---: | ---: | :--- |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(3);
    expect(cells[0].text).toBe(':---:');
    expect(cells[1].text).toBe('---:');
    expect(cells[2].text).toBe(':---');
  });

  // -- Escaped pipe ---------------------------------------------------------

  it('EscapedPipe_InCell_NotSplitOnEscapedPipe', () => {
    // The parser skips '|' when preceded by '\'
    // text: | foo\|bar | baz |
    // The '\|' should not be treated as a cell separator.
    const text = '| foo\\|bar | baz |';
    const cells = parseCellsWithPositions(text, 0);

    // Depending on implementation: the escaped pipe is not a boundary.
    // parseCellsWithPositions checks text[i-1] !== '\\'
    expect(cells.length).toBeGreaterThanOrEqual(1);
    // 'baz' must always appear as its own cell
    const bazCell = cells.find(c => c.text === 'baz');
    expect(bazCell).toBeDefined();
  });

  it('EscapedPipe_FirstCell_ContainsLiteralBackslashPipe', () => {
    const text = '| foo\\|bar | baz |';
    const cells = parseCellsWithPositions(text, 0);

    // First cell raw segment is 'foo\\|bar' which trims to 'foo\\|bar'
    // because the '|' after '\\' is skipped as a separator.
    // Cell text should include the escaped sequence as-is.
    expect(cells[0].text).toBe('foo\\|bar');
  });

  // -- Leading/trailing whitespace variations --------------------------------

  it('Whitespace_ExtraSpaces_TextIsTrimmed', () => {
    const text = '|  Alice   |  Bob  |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells[0].text).toBe('Alice');
    expect(cells[1].text).toBe('Bob');
  });

  it('Whitespace_NoSpaceAroundPipes_ParsedCorrectly', () => {
    const text = '|Alice|Bob|';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(2);
    expect(cells[0].text).toBe('Alice');
    expect(cells[1].text).toBe('Bob');
  });

  it('Whitespace_SingleSpaceCell_TreatedAsEmpty', () => {
    // A single space trims to '' so it should be treated as an empty cell.
    const text = '| |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(1);
    expect(cells[0].text).toBe('');
    expect(cells[0].from).toBe(cells[0].to);
  });

  // -- Single-column table --------------------------------------------------

  it('SingleColumn_OneCell_ParsedCorrectly', () => {
    const text = '| Value |';
    const cells = parseCellsWithPositions(text, 0);

    expect(cells).toHaveLength(1);
    expect(cells[0].text).toBe('Value');
  });

  // -- Row without leading pipe ---------------------------------------------

  it('NoLeadingPipe_SkipsUntilFirstPipe_ThenParsesNormally', () => {
    // The function scans past any non-'|' chars before the first pipe.
    const text = 'Alice | Bob | Carol |';
    const cells = parseCellsWithPositions(text, 0);

    // After skipping 'Alice ' the first pipe is at index 6, then Bob and Carol
    expect(cells.length).toBeGreaterThanOrEqual(1);
    expect(cells[cells.length - 1].text).toBe('Carol');
  });
});

// ---------------------------------------------------------------------------
// tableToGrid
// ---------------------------------------------------------------------------

describe('tableToGrid', () => {
  it('FiltersDelimiterRow_OnlyHeaderAndDataRows', () => {
    const headerCells: CellInfo[] = [
      { text: 'Name', from: 1, to: 5 },
      { text: 'Role', from: 7, to: 11 },
    ];
    const delimCells: CellInfo[] = [
      { text: '---', from: 20, to: 23 },
      { text: '---', from: 25, to: 28 },
    ];
    const dataCells: CellInfo[] = [
      { text: 'Alice', from: 40, to: 45 },
      { text: 'Engineer', from: 47, to: 55 },
    ];

    const rows: RowData[] = [
      makeRow({ cells: headerCells, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: delimCells, isDelimiter: true, rowIndex: -1 }),
      makeRow({ cells: dataCells, isHeader: false, rowIndex: 1 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    expect(grid).toHaveLength(2);
  });

  it('FiltersDelimiterRow_GridDoesNotContainDelimiterContent', () => {
    const headerCells: CellInfo[] = [{ text: 'Name', from: 1, to: 5 }];
    const delimCells: CellInfo[] = [{ text: '---', from: 10, to: 13 }];
    const dataCells: CellInfo[] = [{ text: 'Alice', from: 20, to: 25 }];

    const rows: RowData[] = [
      makeRow({ cells: headerCells, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: delimCells, isDelimiter: true, rowIndex: -1 }),
      makeRow({ cells: dataCells, rowIndex: 1 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    const allText = grid.flat();
    expect(allText).not.toContain('---');
  });

  it('HeaderRow_IsFirstRowInGrid', () => {
    const headerCells: CellInfo[] = [
      { text: 'Name', from: 1, to: 5 },
      { text: 'Role', from: 7, to: 11 },
    ];
    const delimCells: CellInfo[] = [
      { text: '---', from: 20, to: 23 },
      { text: '---', from: 25, to: 28 },
    ];

    const rows: RowData[] = [
      makeRow({ cells: headerCells, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: delimCells, isDelimiter: true, rowIndex: -1 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    expect(grid[0]).toEqual(['Name', 'Role']);
  });

  it('MultipleDataRows_PreservesOrder', () => {
    const header: CellInfo[] = [{ text: 'Name', from: 0, to: 4 }];
    const delim: CellInfo[] = [{ text: '---', from: 10, to: 13 }];
    const row1: CellInfo[] = [{ text: 'Alice', from: 20, to: 25 }];
    const row2: CellInfo[] = [{ text: 'Bob', from: 30, to: 33 }];
    const row3: CellInfo[] = [{ text: 'Carol', from: 40, to: 45 }];

    const rows: RowData[] = [
      makeRow({ cells: header, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: delim, isDelimiter: true, rowIndex: -1 }),
      makeRow({ cells: row1, rowIndex: 1 }),
      makeRow({ cells: row2, rowIndex: 2 }),
      makeRow({ cells: row3, rowIndex: 3 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    expect(grid).toHaveLength(4);
    expect(grid[1]).toEqual(['Alice']);
    expect(grid[2]).toEqual(['Bob']);
    expect(grid[3]).toEqual(['Carol']);
  });

  it('CellText_ExtractedFromCellInfoText', () => {
    const headerCells: CellInfo[] = [
      { text: 'Name', from: 1, to: 5 },
      { text: 'Status', from: 7, to: 13 },
    ];
    const dataCells: CellInfo[] = [
      { text: 'Alice', from: 20, to: 25 },
      { text: 'Active', from: 27, to: 33 },
    ];
    const rows: RowData[] = [
      makeRow({ cells: headerCells, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: dataCells, rowIndex: 1 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    expect(grid[0]).toEqual(['Name', 'Status']);
    expect(grid[1]).toEqual(['Alice', 'Active']);
  });

  it('EmptyTable_OnlyHeaderAndDelimiter_ReturnsOnlyHeaderRow', () => {
    const header: CellInfo[] = [{ text: 'Col', from: 0, to: 3 }];
    const delim: CellInfo[] = [{ text: '---', from: 10, to: 13 }];

    const rows: RowData[] = [
      makeRow({ cells: header, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: delim, isDelimiter: true, rowIndex: -1 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    expect(grid).toHaveLength(1);
    expect(grid[0]).toEqual(['Col']);
  });

  it('NoDelimiterRow_AllRowsIncluded', () => {
    // Edge case: context with no delimiter row at all
    const row1: CellInfo[] = [{ text: 'A', from: 0, to: 1 }];
    const row2: CellInfo[] = [{ text: 'B', from: 10, to: 11 }];
    const rows: RowData[] = [
      makeRow({ cells: row1, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: row2, rowIndex: 1 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    expect(grid).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Delimiter detection: position-based, not content-based
// ---------------------------------------------------------------------------

describe('delimiter detection (position-based)', () => {
  // These tests document the intended classification rule:
  // "only the 2nd line (startLine + 1) is the delimiter — never by content."
  //
  // The decorateTable function sets:
  //   isDelimiter = (i === startLine.number + 1)
  //
  // We verify that parseCellsWithPositions itself is content-agnostic —
  // it never refuses to parse or changes behaviour based on dash content.

  it('DashOnlyRow_ParsedSameAsNormalRow', () => {
    // A row that LOOKS like a GFM delimiter should parse identically to a
    // row with real data — delimiter status is not parseCellsWithPositions' concern.
    const delim = '| --- | --- | --- |';
    const normal = '| foo | bar | baz |';

    const delimCells = parseCellsWithPositions(delim, 0);
    const normalCells = parseCellsWithPositions(normal, 0);

    expect(delimCells).toHaveLength(normalCells.length);
  });

  it('ThirdRow_DashContent_NotTreatedAsDelimiterByTableToGrid', () => {
    // A dash-content row at position 3 (rowIndex 2) is NOT a delimiter.
    // isDelimiter must be false for it, so tableToGrid must include it.
    const header: CellInfo[] = [{ text: 'Name', from: 0, to: 4 }];
    const delim: CellInfo[] = [{ text: '---', from: 10, to: 13 }];
    const data1: CellInfo[] = [{ text: 'Alice', from: 20, to: 25 }];
    const dashData: CellInfo[] = [{ text: '---', from: 30, to: 33 }];

    const rows: RowData[] = [
      makeRow({ cells: header, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: delim, isDelimiter: true, rowIndex: -1 }),
      makeRow({ cells: data1, rowIndex: 1 }),
      // Row with dashes at position 3 — isDelimiter must be false
      makeRow({ cells: dashData, isDelimiter: false, rowIndex: 2 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    // grid: header, data1, dashData — 3 rows
    expect(grid).toHaveLength(3);
    expect(grid[2]).toEqual(['---']);
  });

  it('SecondRow_AnyContent_MarkedAsDelimiter', () => {
    // Even a row with "real" content at position 2 would be the delimiter
    // according to the position-based rule.  tableToGrid filters it out.
    const header: CellInfo[] = [{ text: 'Name', from: 0, to: 4 }];
    const secondRow: CellInfo[] = [{ text: 'Alice', from: 10, to: 15 }];
    const data: CellInfo[] = [{ text: 'Bob', from: 20, to: 23 }];

    const rows: RowData[] = [
      makeRow({ cells: header, isHeader: true, rowIndex: 0 }),
      makeRow({ cells: secondRow, isDelimiter: true, rowIndex: -1 }),
      makeRow({ cells: data, rowIndex: 1 }),
    ];
    const ctx = makeCtx(rows);
    const grid = tableToGrid(ctx);

    expect(grid).toHaveLength(2);
    // 'Alice' (second row, treated as delimiter) must NOT appear in the grid
    expect(grid.flat()).not.toContain('Alice');
  });
});

// ---------------------------------------------------------------------------
// parseInlineMarkdown
// ---------------------------------------------------------------------------

describe('parseInlineMarkdown', () => {
  it('Empty_Empty_ReturnsEmptyArray', () => {
    expect(parseInlineMarkdown('')).toEqual([]);
  });

  it('PlainText_NoMarkdown_ReturnsSingleTextToken', () => {
    expect(parseInlineMarkdown('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('Link_BareLink_ReturnsLinkToken', () => {
    expect(parseInlineMarkdown('[click](https://example.com)')).toEqual([
      { type: 'link', text: 'click', url: 'https://example.com' },
    ]);
  });

  it('Link_IssueShorthandWithHash_ReturnsLinkToken', () => {
    // Real-world case from the bug report: `[#12480](https://github.com/.../issues/12480)`
    expect(
      parseInlineMarkdown('[#12480](https://github.com/dodobrands/dodo-mobile-ios/issues/12480)')
    ).toEqual([
      {
        type: 'link',
        text: '#12480',
        url: 'https://github.com/dodobrands/dodo-mobile-ios/issues/12480',
      },
    ]);
  });

  it('Link_MultipleLinksSeparatedByText_ReturnsInterleavedTokens', () => {
    expect(
      parseInlineMarkdown('[#1](https://x.test/1), [#2](https://x.test/2)')
    ).toEqual([
      { type: 'link', text: '#1', url: 'https://x.test/1' },
      { type: 'text', value: ', ' },
      { type: 'link', text: '#2', url: 'https://x.test/2' },
    ]);
  });

  it('Link_TextBeforeAndAfter_ReturnsTextLinkText', () => {
    expect(parseInlineMarkdown('see [docs](https://example.com) now')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', text: 'docs', url: 'https://example.com' },
      { type: 'text', value: ' now' },
    ]);
  });

  it('Bold_DoubleAsterisk_ReturnsBoldToken', () => {
    expect(parseInlineMarkdown('**bold**')).toEqual([
      { type: 'bold', value: 'bold' },
    ]);
  });

  it('Italic_SingleAsterisk_ReturnsItalicToken', () => {
    expect(parseInlineMarkdown('*italic*')).toEqual([
      { type: 'italic', value: 'italic' },
    ]);
  });

  it('BoldItalic_TripleAsterisk_ReturnsBoldItalicToken', () => {
    expect(parseInlineMarkdown('***both***')).toEqual([
      { type: 'boldItalic', value: 'both' },
    ]);
  });

  it('Strike_DoubleTilde_ReturnsStrikeToken', () => {
    expect(parseInlineMarkdown('~~gone~~')).toEqual([
      { type: 'strike', value: 'gone' },
    ]);
  });

  it('Code_Backticks_ReturnsCodeToken', () => {
    expect(parseInlineMarkdown('`code`')).toEqual([
      { type: 'code', value: 'code' },
    ]);
  });

  it('MalformedLink_MissingClosingParen_NotParsedAsLink', () => {
    // Defensive: opener without closing must remain plain text, not swallow rest of cell.
    expect(parseInlineMarkdown('[oops](https://x.test')).toEqual([
      { type: 'text', value: '[oops](https://x.test' },
    ]);
  });

  it('LinkWithBoldNeighbours_LinkBeforeBold_BothParsed', () => {
    expect(parseInlineMarkdown('[a](https://x.test) and **b**')).toEqual([
      { type: 'link', text: 'a', url: 'https://x.test' },
      { type: 'text', value: ' and ' },
      { type: 'bold', value: 'b' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// routeLinkClick
// ---------------------------------------------------------------------------

// Structural mock — mirrors the pattern used in heading-slugs.test.ts. Only
// `state` and `dispatch` are exercised by navigateToHeading, so a real
// EditorView (which needs the DOM) isn't required.
function makeMockView(doc: string): { view: EditorView; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn();
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      }),
      headingSlugsField,
    ],
  });
  const view = { state, dispatch } as unknown as EditorView;
  return { view, dispatch };
}

describe('routeLinkClick', () => {
  it('Anchor_KnownHeading_DispatchesScrollAndSkipsOpenExternal', () => {
    const { view, dispatch } = makeMockView('# Hello\n\nbody\n');
    const openExternal = vi.fn();

    routeLinkClick('#hello', view, openExternal);

    // navigateToHeading dispatches a single transaction with scrollIntoView effects.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Anchor_UnknownHeading_DispatchesNothingAndSkipsOpenExternal', () => {
    const { view, dispatch } = makeMockView('# Hello\n');
    const openExternal = vi.fn();

    routeLinkClick('#nope', view, openExternal);

    // navigateToHeading is a silent no-op for unknown slugs — must not fall
    // through to the external opener.
    expect(dispatch).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Anchor_RepeatedClicks_RouteThroughDispatchEveryTime_NeverEscapesToExternal', () => {
    // Repro for the regression: re-clicking the same in-document anchor used
    // to escape through the native `<a href="#x">` activation and end up in
    // the system browser. Routing must stay deterministic across N calls and
    // openExternal must never be invoked for `#`-prefixed URLs.
    const { view, dispatch } = makeMockView('# Hello\n\nbody\n');
    const openExternal = vi.fn();

    routeLinkClick('#hello', view, openExternal);
    routeLinkClick('#hello', view, openExternal);
    routeLinkClick('#hello', view, openExternal);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('External_HttpUrl_InvokesOpenExternalAndSkipsDispatch', () => {
    const { view, dispatch } = makeMockView('# Hello\n');
    const openExternal = vi.fn();

    routeLinkClick('https://example.com/path', view, openExternal);

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/path');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('External_DoesNotMistakeMidStringHashForAnchor', () => {
    // Only a leading `#` marks an in-document anchor — full URLs with fragments
    // (`https://x.test/page#section`) must still open externally.
    const { view, dispatch } = makeMockView('# Hello\n');
    const openExternal = vi.fn();

    routeLinkClick('https://x.test/page#section', view, openExternal);

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://x.test/page#section');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cellEditWidth (#50) — раскрытие ячейки на время ввода
// ---------------------------------------------------------------------------

describe('cellEditWidth', () => {
  it('расширяет узкую колонку до комфортного минимума', () => {
    expect(cellEditWidth(20, 900)).toBe(280);
  });

  it('не сужает ячейку, которая и так шире минимума', () => {
    expect(cellEditWidth(520, 900)).toBe(520);
  });

  it('не вылезает за остаток строки справа', () => {
    expect(cellEditWidth(40, 150)).toBe(150);
  });

  it('у правого края строки остаётся шириной с саму ячейку', () => {
    // Места справа не осталось вовсе (или оно отрицательное) — раскрывать
    // некуда, но и схлопывать ячейку нельзя.
    expect(cellEditWidth(90, 0)).toBe(90);
    expect(cellEditWidth(90, -40)).toBe(90);
  });

  it('уважает переданный минимум', () => {
    expect(cellEditWidth(20, 900, 120)).toBe(120);
  });
});
