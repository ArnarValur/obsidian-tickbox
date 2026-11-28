import {describe, expect, it} from 'vitest';
import {bracketsStandAlone, cellAt, strikeOf, toggled, isDelimiterRow, linesOf, nearestBox, resolveBox, splitCells, tableAt, tablesIn} from '../../src/table';

const cells = (line: string): string[] => (splitCells(line) ?? []).map((c) => line.slice(c.from, c.to));

describe('splitCells', () => {
	it('handles leading and trailing pipes', () => {
		expect(cells('| a | b |')).toEqual([' a ', ' b ']);
		expect(cells('a | b')).toEqual(['a ', ' b']);
		expect(cells('| a | b')).toEqual([' a ', ' b']);
		expect(cells('a | b |  ')).toEqual(['a ', ' b ']);
	});
	it('keeps escaped pipes inside a cell', () => {
		expect(cells('| [[x\\|y]] ☐ | b |')).toEqual([' [[x\\|y]] ☐ ', ' b ']);
	});
	it('handles callout prefixes and empty cells', () => {
		expect(cells('> | ☐ | | x |')).toEqual([' ☐ ', ' ', ' x ']);
	});
	it('returns null without a pipe', () => {
		expect(splitCells('plain ☐')).toBeNull();
	});
});

describe('tables', () => {
	const doc = linesOf(['intro | not a table', '', '| A | B |', '| --- | :-: |', '| ☐ | x ☑ ☐ |', '| y | ☐ |', '', '> [!note]', '> | C |', '> |---|', '> | ☑ |'].join('\n'));
	it('finds the table around a row', () => {
		expect(tableAt(doc, 4)).toEqual({header: 2, last: 5});
		expect(tableAt(doc, 2)).toEqual({header: 2, last: 5});
		expect(tableAt(doc, 0)).toBeNull();
		expect(tableAt(doc, 10)).toEqual({header: 8, last: 10});
	});
	it('lists tables in a range', () => {
		expect(tablesIn(doc, 0, 10)).toEqual([{header: 2, last: 5}, {header: 8, last: 10}]);
	});
	it('spots delimiter rows', () => {
		expect(isDelimiterRow('| --- | :-: |')).toBe(true);
		expect(isDelimiterRow('> |---|')).toBe(true);
		expect(isDelimiterRow('| ☐ | x |')).toBe(false);
	});
	it('resolves a rendered box to its source spot, and refuses mismatches', () => {
		const at = resolveBox(doc, {from: 2, to: 2, tableIndex: 0, tableCount: 1, row: 1, col: 1, box: 1, states: '☑☐'});
		expect(at).toEqual({line: 4, ch: '| ☐ | x ☑ '.length});
		expect(resolveBox(doc, {from: 2, to: 2, tableIndex: 0, tableCount: 1, row: 1, col: 1, box: 1, states: '☐☐'})).toBeNull();
		expect(resolveBox(doc, {from: 7, to: 10, tableIndex: 0, tableCount: 1, row: 1, col: 0, box: 0, states: '☑'})).toEqual({line: 10, ch: 4});
		expect(resolveBox(doc, {from: 2, to: 2, tableIndex: 0, tableCount: 1, row: 0, col: 0, box: 0, states: '☐'})).toBeNull();
	});
});

describe('command helpers', () => {
	it('picks the cell at the cursor', () => {
		const line = '| ☐ a | b ☑ |';
		expect(cellAt(line, 3)).toEqual({from: 1, to: 6});
		expect(cellAt(line, 9)).toEqual({from: 7, to: 12});
	});
	it('picks the nearest box, the left one on a tie', () => {
		expect(nearestBox([2, 10], 4)).toBe(2);
		expect(nearestBox([2, 10], 9)).toBe(10);
		expect(nearestBox([2, 3], 3)).toBe(2);
		expect(nearestBox([], 3)).toBeNull();
	});
});

describe('quick insert', () => {
	it('converts lone brackets only', () => {
		expect(bracketsStandAlone(' []', 3, 0)).toBe(true);
		expect(bracketsStandAlone('[]', 2, 0)).toBe(true);
		expect(bracketsStandAlone(' [[]', 4, 0)).toBe(false);
		expect(bracketsStandAlone(' ![]', 4, 0)).toBe(false);
		expect(bracketsStandAlone(' \\[]', 4, 0)).toBe(false);
		expect(bracketsStandAlone(' `[]', 4, 0)).toBe(false);
		expect(bracketsStandAlone(' `a` []', 7, 0)).toBe(true);
	});
});

describe('strike boxes', () => {
	it('toggles each kind of box within its own pair', () => {
		expect(toggled('☐')).toBe('☑');
		expect(toggled('☑')).toBe('☐');
		expect(toggled('⊟')).toBe('☒');
		expect(toggled('☒')).toBe('⊟');
	});
	it('strikes the cell when text sits beside a ticked strike box, the row when the box stands alone', () => {
		expect(strikeOf(' ☒ Buy milk ')).toBe('cell');
		expect(strikeOf('Buy milk ☒')).toBe('cell');
		expect(strikeOf(' ☒ ')).toBe('row');
		expect(strikeOf('☒ ☐ ☑')).toBe('row');
		expect(strikeOf(' ⊟ Buy milk ')).toBe('none');
		expect(strikeOf(' ⊟ ')).toBe('none');
		expect(strikeOf(' ☑ done ')).toBe('none');
	});
	it('resolves a strike box like any other box', () => {
		const doc = linesOf(['| A | B |', '| - | - |', '| ⊟ milk ☐ | x |'].join('\n'));
		expect(resolveBox(doc, {from: 0, to: 0, tableIndex: 0, tableCount: 1, row: 1, col: 0, box: 0, states: '⊟☐'})).toEqual({line: 2, ch: 2});
		expect(resolveBox(doc, {from: 0, to: 0, tableIndex: 0, tableCount: 1, row: 1, col: 0, box: 0, states: '☒☐'})).toBeNull();
	});
	it('converts a lone [-] only', () => {
		expect(bracketsStandAlone(' [-]', 4, 0, '[-]')).toBe(true);
		expect(bracketsStandAlone('[-]', 3, 0, '[-]')).toBe(true);
		expect(bracketsStandAlone(' [[-]', 5, 0, '[-]')).toBe(false);
		expect(bracketsStandAlone(' `[-]', 5, 0, '[-]')).toBe(false);
		expect(bracketsStandAlone(' [x]', 4, 0, '[-]')).toBe(false);
	});
});
