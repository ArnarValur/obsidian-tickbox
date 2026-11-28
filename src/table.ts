// Pure Markdown-table helpers: no Obsidian, no DOM. Everything Tickbox writes is decided here.

export const UNCHECKED = '☐';
export const CHECKED = '☑';
/** Strike box: ⊟ (U+229F, looks like `[-]`) open, ☒ (U+2612) ticked. A ticked one strikes its cell's text or row. */
export const STRIKE_OPEN = '⊟';
export const STRIKE_DONE = '☒';

const PAIRS: Record<string, string> = {
	[UNCHECKED]: CHECKED,
	[CHECKED]: UNCHECKED,
	[STRIKE_OPEN]: STRIKE_DONE,
	[STRIKE_DONE]: STRIKE_OPEN,
};

export function isBox(ch: string | undefined): ch is string {
	return ch !== undefined && ch.length === 1 && ch in PAIRS;
}

export function toggled(ch: string): string {
	return PAIRS[ch] ?? ch;
}

/** What a cell's ticked strike box strikes through: nothing, the cell's own text, or (no text beside it) the row. */
export type Strike = 'none' | 'cell' | 'row';

/** Decides the strike for one cell's text: text next to a ticked strike box → that cell; a ticked box alone → the row. */
export function strikeOf(cellText: string): Strike {
	if (!cellText.includes(STRIKE_DONE)) return 'none';
	const rest = Array.from(cellText).filter((c) => !isBox(c)).join('').trim();
	return rest === '' ? 'row' : 'cell';
}

/** A cell's content inside one line: [from, to) offsets in the line, pipes excluded. */
export interface CellSpan {
	from: number;
	to: number;
}

/** Length of the blockquote/callout prefix ("> ", "> > ", leading spaces) in front of a table row. */
export function quotePrefixLength(line: string): number {
	const m = /^[ \t]*(?:>[ \t]?)*[ \t]*/.exec(line);
	return m ? m[0].length : 0;
}

/** Offsets of unescaped pipes in `line` from `start`. */
function pipeOffsets(line: string, start: number): number[] {
	const out: number[] = [];
	for (let i = start; i < line.length; i++) {
		const c = line[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (c === '|') out.push(i);
	}
	return out;
}

/** True when the line (prefix ignored) has at least one unescaped pipe. */
export function hasPipe(line: string): boolean {
	return pipeOffsets(line, quotePrefixLength(line)).length > 0;
}

/**
 * The cells of a table row. GFM rules: cells are split on unescaped `|`; a leading and a trailing pipe are
 * optional; `\|` stays inside the cell. Returns null when the line has no pipe at all.
 */
export function splitCells(line: string): CellSpan[] | null {
	const start = quotePrefixLength(line);
	const pipes = pipeOffsets(line, start);
	if (pipes.length === 0) return null;
	let end = line.length;
	while (end > start && /\s/.test(line[end - 1] ?? '')) end--;
	const bounds: number[] = [];
	const first = pipes[0];
	const leading = first !== undefined && line.slice(start, first).trim() === '';
	bounds.push(leading && first !== undefined ? first : start - 1);
	for (const p of pipes) if (!(leading && p === first)) bounds.push(p);
	const last = bounds[bounds.length - 1];
	const trailing = last !== undefined && last === end - 1 && bounds.length > 1;
	if (!trailing) bounds.push(end);
	const cells: CellSpan[] = [];
	for (let i = 0; i + 1 < bounds.length; i++) {
		const a = bounds[i];
		const b = bounds[i + 1];
		if (a === undefined || b === undefined) continue;
		cells.push({from: a + 1, to: b});
	}
	return cells;
}

const DELIM_CELL = /^\s*:?-+:?\s*$/;

/** True for a table delimiter row such as `| --- | :-: |`. */
export function isDelimiterRow(line: string): boolean {
	const cells = splitCells(line);
	if (!cells || cells.length === 0) return false;
	return cells.every((c) => DELIM_CELL.test(line.slice(c.from, c.to)));
}

/** A table block, 0-based line numbers: header, delimiter (header + 1), last row (inclusive). */
export interface TableBlock {
	header: number;
	last: number;
}

export interface Lines {
	count: number;
	line(n: number): string;
}

export function linesOf(text: string): Lines {
	const arr = text.split('\n');
	return {count: arr.length, line: (n) => arr[n] ?? ''};
}

function isHeaderAt(lines: Lines, n: number): boolean {
	if (n < 0 || n + 1 >= lines.count) return false;
	const head = lines.line(n);
	const delim = lines.line(n + 1);
	if (!hasPipe(head) || !isDelimiterRow(delim)) return false;
	return splitCells(head)?.length === splitCells(delim)?.length;
}

function blockFrom(lines: Lines, header: number): TableBlock {
	let last = header + 1;
	while (last + 1 < lines.count && hasPipe(lines.line(last + 1)) && lines.line(last + 1).trim() !== '') last++;
	return {header, last};
}

/** The table that contains line `n`, or null. */
export function tableAt(lines: Lines, n: number): TableBlock | null {
	if (n < 0 || n >= lines.count || !hasPipe(lines.line(n))) return null;
	for (let h = n; h >= 0; h--) {
		if (isHeaderAt(lines, h)) {
			const block = blockFrom(lines, h);
			return n <= block.last ? block : null;
		}
		if (h < n && !hasPipe(lines.line(h))) break;
	}
	return null;
}

/** Every table whose header lies in [from, to] (0-based, inclusive), in order. */
export function tablesIn(lines: Lines, from: number, to: number): TableBlock[] {
	const out: TableBlock[] = [];
	for (let n = Math.max(0, from); n <= Math.min(to, lines.count - 1); n++) {
		if (isHeaderAt(lines, n)) {
			const b = blockFrom(lines, n);
			out.push(b);
			n = b.last;
		}
	}
	return out;
}

/** Source line of the rendered row `rowIndex` (0 = header row; the delimiter line has no rendered row). */
export function rowLine(block: TableBlock, rowIndex: number): number | null {
	const n = rowIndex === 0 ? block.header : block.header + rowIndex + 1;
	return n <= block.last ? n : null;
}

/** Offsets (in `text`) of every box in [from, to). */
export function boxesIn(text: string, from = 0, to = text.length): number[] {
	const out: number[] = [];
	for (let i = from; i < to; i++) if (isBox(text[i])) out.push(i);
	return out;
}

/** The box nearest to `pos` among `boxes` (offsets); on a tie the one before the cursor wins. */
export function nearestBox(boxes: number[], pos: number): number | null {
	let best: number | null = null;
	let bestDist = Infinity;
	for (const b of boxes) {
		const dist = pos <= b ? b - pos : pos - (b + 1);
		if (dist < bestDist || (dist === bestDist && b < pos)) {
			best = b;
			bestDist = dist;
		}
	}
	return best;
}

/** The cell of `line` that holds offset `ch` (pipes count as the cell to their left's edge). */
export function cellAt(line: string, ch: number): CellSpan | null {
	const cells = splitCells(line);
	if (!cells) return null;
	return cells.find((c) => ch >= c.from && ch <= c.to) ?? null;
}

/** True when offset `ch` of `text` sits inside an inline code span (odd number of backticks before it). */
export function insideInlineCode(text: string, from: number, ch: number): boolean {
	let ticks = 0;
	for (let i = from; i < ch; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === '`') ticks++;
	}
	return ticks % 2 === 1;
}

/**
 * Locates box number `index` of cell `col` on the given row line, checking that the cell's boxes are exactly
 * `expected` (the states seen on screen, in order). Returns the box's offset in the line, or null when the source
 * does not match what was rendered: Tickbox then changes nothing.
 */
export function locateBox(line: string, col: number, index: number, expected: string): number | null {
	const cells = splitCells(line);
	const cell = cells?.[col];
	if (!cell) return null;
	const boxes = boxesIn(line, cell.from, cell.to);
	const seen = boxes.map((b) => line[b]).join('');
	if (seen !== expected) return null;
	return boxes[index] ?? null;
}

/** Last line (0-based) of the blockquote/callout that starts at `start`. */
export function quoteBlockEnd(lines: Lines, start: number): number {
	let n = start;
	while (n + 1 < lines.count && /^[ \t]*>/.test(lines.line(n + 1))) n++;
	return n;
}

/** Where a box seen on screen sits: the source range holding its table, and its place in the rendered table. */
export interface BoxRef {
	/** 0-based source lines to search for tables (inclusive). */
	from: number;
	to: number;
	/** Which table in that range, and how many tables were rendered there (must match the source). */
	tableIndex: number;
	tableCount: number;
	/** Rendered row (0 = header), column, and box number within the cell. */
	row: number;
	col: number;
	box: number;
	/** The cell's boxes as rendered, in order (e.g. "☐☑"). The source cell must hold exactly these. */
	states: string;
}

/** The source line and offset of the box `ref` points at, or null when the source does not match the screen. */
export function resolveBox(lines: Lines, ref: BoxRef): {line: number; ch: number} | null {
	const tables = tablesIn(lines, ref.from, ref.to);
	if (tables.length !== ref.tableCount) return null;
	const block = tables[ref.tableIndex];
	if (!block) return null;
	const line = rowLine(block, ref.row);
	if (line === null) return null;
	const ch = locateBox(lines.line(line), ref.col, ref.box, ref.states);
	return ch === null ? null : {line, ch};
}

/** Quick-insert shortcuts: typed in a table cell, each becomes its box. */
export const SHORTCUTS: ReadonlyArray<{text: string; box: string}> = [
	{text: '[]', box: UNCHECKED},
	{text: '[-]', box: STRIKE_OPEN},
];

/**
 * Quick insert: should the `shortcut` (`[]` or `[-]`) that ends at `head` (just typed) become a box? Only when the
 * brackets stand alone (not a wikilink, image, escaped or reference link) and are not inside inline code. `cellFrom`
 * is where the cell starts.
 */
export function bracketsStandAlone(text: string, head: number, cellFrom: number, shortcut = '[]'): boolean {
	const start = head - shortcut.length;
	if (start < cellFrom || text.slice(start, head) !== shortcut) return false;
	const before = text[start - 1];
	if (start - 1 >= cellFrom && (before === '[' || before === '!' || before === '\\' || before === ']')) return false;
	return !insideInlineCode(text, cellFrom, start);
}
