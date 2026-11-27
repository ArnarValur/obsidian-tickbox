// Click/tap to toggle. Listens on the window in the capture phase, so it sees the pointer before Obsidian's Live
// Preview table editor does. A press that lands on a ☐/☑ inside a table cell is taken over completely (pointer,
// mouse, touch and click events are all stopped), and the box is flipped in the source on release. Any other press
// is left alone.
import {EditorView} from '@codemirror/view';
import {MarkdownView, Notice, type App, type MarkdownPostProcessorContext, type TFile} from 'obsidian';
import {isCellEditor, docLines, toggleAt} from './editor';
import {FileHistory, toggleInFile} from './file-edit';
import {isBox, linesOf, quoteBlockEnd, resolveBox, type BoxRef} from './table';

/** A box glyph found under the pointer. */
interface Glyph {
	node: Text;
	offset: number;
	char: string;
	/** Its number among the boxes of the cell, and all of the cell's boxes in order. */
	index: number;
	states: string;
}

type Target =
	| {kind: 'editor'; view: EditorView; pos: number; char: string}
	| {kind: 'file'; file: TFile; ref: BoxRef; char: string};

interface Hit {
	target: Target;
	cell: HTMLElement;
	glyph: Glyph;
}

interface Section {
	el: HTMLElement;
	ctx: MarkdownPostProcessorContext;
}

const MARKDOWN_VIEWS = '.markdown-source-view, .markdown-reading-view, .markdown-preview-view, .markdown-rendered';
/** Taps get a wider target than mouse clicks; a box is only about one letter wide. */
const PAD_MOUSE = 2;
const PAD_TOUCH = 8;
const MAX_MOVE = 12;

function asElement(t: EventTarget | null): Element | null {
	const n = t as Node | null;
	if (!n || typeof n.nodeType !== 'number') return null;
	return n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}

/** The part of a cell that is on screen: Live Preview cells hold a rendered copy and, while edited, an editor copy. */
function visibleScope(cell: HTMLElement): HTMLElement {
	for (const w of Array.from(cell.children)) {
		if (w.classList.contains('table-cell-wrapper') && w.getClientRects().length > 0) return w as HTMLElement;
	}
	return cell;
}

/** The box under (x, y) in `scope`, with its number among the scope's boxes. */
function glyphUnder(scope: HTMLElement, x: number, y: number, pad: number): Glyph | null {
	const doc = scope.ownerDocument;
	const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
	const range = doc.createRange();
	let states = '';
	let best: Omit<Glyph, 'states'> | null = null;
	let bestDist = Infinity;
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const text = n as Text;
		const data = text.data;
		for (let i = 0; i < data.length; i++) {
			const c = data[i];
			if (!isBox(c)) continue;
			const index = states.length;
			states += c;
			range.setStart(text, i);
			range.setEnd(text, i + 1);
			const r = range.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			if (x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad) continue;
			const dist = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2);
			if (dist < bestDist) {
				bestDist = dist;
				best = {node: text, offset: i, char: c, index};
			}
		}
	}
	range.detach();
	return best ? {...best, states} : null;
}

function outermostEditor(el: Element): Element | null {
	let ed = el.closest('.cm-editor');
	while (ed) {
		const up = ed.parentElement?.closest('.cm-editor');
		if (!up) return ed;
		ed = up;
	}
	return null;
}

export class ClickToggler {
	/** Reading-view tables → the rendered section they belong to (filled by the post processor). */
	readonly sections = new WeakMap<HTMLTableElement, Section>();
	private pending: {hit: Hit; pointerId: number; x: number; y: number} | null = null;
	/** After a toggle, stray mouse/click events on the same cell are swallowed until this time. */
	private swallowUntil = 0;
	private swallowCell: HTMLElement | null = null;
	private hoverCell: HTMLElement | null = null;

	/** Undo/redo for toggles written straight to the file (Reading view). */
	readonly history: FileHistory;

	constructor(private readonly app: App) {
		this.history = new FileHistory(app);
	}

	/** For registerMarkdownPostProcessor: remembers which section each rendered table came from. */
	readonly postProcess = (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		for (const t of Array.from(el.querySelectorAll('table'))) this.sections.set(t, {el, ctx});
	};

	/** The listeners to register on every window (main and pop-outs), all in the capture phase. */
	listeners(): Array<[string, (e: Event) => void, AddEventListenerOptions]> {
		const cap = {capture: true};
		const capActive = {capture: true, passive: false};
		return [
			['pointerdown', (e) => this.onPointerDown(e as PointerEvent), cap],
			['pointerup', (e) => this.onPointerUp(e as PointerEvent), cap],
			['pointercancel', () => (this.pending = null), cap],
			['pointermove', (e) => this.onPointerMove(e as PointerEvent), cap],
			['touchstart', (e) => this.swallowIfOurs(e), capActive],
			['touchend', (e) => this.swallowIfOurs(e), capActive],
			['mousedown', (e) => this.swallowIfOurs(e), cap],
			['mouseup', (e) => this.swallowIfOurs(e), cap],
			['click', (e) => this.swallowIfOurs(e), cap],
			['dblclick', (e) => this.swallowIfOurs(e), cap],
			['contextmenu', (e) => this.swallowIfOurs(e), cap],
		];
	}

	private swallow(e: Event): void {
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	private swallowIfOurs(e: Event): void {
		if (this.pending) {
			this.swallow(e);
			return;
		}
		if (Date.now() < this.swallowUntil && this.swallowCell) {
			const el = asElement(e.target);
			if (el && this.swallowCell.contains(el)) this.swallow(e);
		}
	}

	private onPointerDown(e: PointerEvent): void {
		this.pending = null;
		if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
		const hit = this.hitTest(e);
		if (!hit) return;
		this.pending = {hit, pointerId: e.pointerId, x: e.clientX, y: e.clientY};
		this.swallow(e);
	}

	private onPointerUp(e: PointerEvent): void {
		const p = this.pending;
		if (!p || e.pointerId !== p.pointerId) return;
		this.swallow(e);
		this.pending = null;
		this.swallowUntil = Date.now() + 600;
		this.swallowCell = p.hit.cell;
		if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MAX_MOVE) return;
		void this.apply(p.hit);
	}

	private onPointerMove(e: PointerEvent): void {
		if (e.pointerType !== 'mouse') return;
		const el = asElement(e.target);
		const cell = el?.closest<HTMLTableCellElement>('td, th');
		const over = cell && cell.closest(MARKDOWN_VIEWS) ? glyphUnder(visibleScope(cell), e.clientX, e.clientY, PAD_MOUSE) : null;
		const next = over && cell ? cell : null;
		if (next === this.hoverCell) return;
		this.hoverCell?.removeClass('tickbox-pointer');
		next?.addClass('tickbox-pointer');
		this.hoverCell = next;
	}

	/** The box under the pointer and where it lives in the source, or null (then the press is left alone). */
	private hitTest(e: PointerEvent): Hit | null {
		const el = asElement(e.target);
		const cell = el?.closest<HTMLTableCellElement>('td, th');
		if (!cell) return null;
		const table = cell.closest('table');
		if (!table || !cell.closest(MARKDOWN_VIEWS)) return null;
		const pad = e.pointerType === 'mouse' ? PAD_MOUSE : PAD_TOUCH;
		const glyph = glyphUnder(visibleScope(cell), e.clientX, e.clientY, pad);
		if (!glyph) return null;
		const target = this.resolve(cell, table, glyph);
		return target ? {target, cell, glyph} : null;
	}

	private resolve(cell: HTMLTableCellElement, table: HTMLTableElement, glyph: Glyph): Target | null {
		const row = cell.parentElement as HTMLTableRowElement | null;
		if (!row) return null;
		const outer = outermostEditor(cell);
		if (outer) return this.resolveLivePreview(outer, cell, row, table, glyph);
		return this.resolveReading(cell, row, table, glyph);
	}

	/** Live Preview: the table is a widget in the note's editor; a cell being edited has its own small editor. */
	private resolveLivePreview(outer: Element, cell: HTMLTableCellElement, row: HTMLTableRowElement, table: HTMLTableElement, glyph: Glyph): Target | null {
		const inner = glyph.node.parentElement?.closest('.cm-editor');
		if (inner && inner !== outer) {
			const view = EditorView.findFromDOM(inner as HTMLElement);
			if (!view || !isCellEditor(view)) return null;
			const pos = view.posAtDOM(glyph.node, glyph.offset);
			const states = Array.from(view.state.doc.toString()).filter(isBox).join('');
			if (view.state.doc.sliceString(pos, pos + 1) !== glyph.char || states !== glyph.states) return null;
			return {kind: 'editor', view, pos, char: glyph.char};
		}
		const view = EditorView.findFromDOM(outer as HTMLElement);
		const block = table.closest('.cm-embed-block');
		if (!view || !block) return null;
		const lines = docLines(view.state);
		const start = view.state.doc.lineAt(view.posAtDOM(block)).number - 1;
		const isTableWidget = block.classList.contains('cm-table-widget');
		const tables = Array.from(block.querySelectorAll('table'));
		const ref: BoxRef = {
			from: start,
			to: isTableWidget ? start : quoteBlockEnd(lines, start),
			tableIndex: isTableWidget ? 0 : tables.indexOf(table),
			tableCount: isTableWidget ? 1 : tables.length,
			row: row.rowIndex,
			col: cell.cellIndex,
			box: glyph.index,
			states: glyph.states,
		};
		const at = resolveBox(lines, ref);
		if (!at) return null;
		const pos = view.state.doc.line(at.line + 1).from + at.ch;
		return {kind: 'editor', view, pos, char: glyph.char};
	}

	/** Reading view: the post processor told us which section the table was rendered from. */
	private resolveReading(cell: HTMLTableCellElement, row: HTMLTableRowElement, table: HTMLTableElement, glyph: Glyph): Target | null {
		const section = this.sections.get(table);
		const info = section?.ctx.getSectionInfo(section.el);
		if (!section || !info) return null;
		const tables = Array.from(section.el.querySelectorAll('table'));
		const ref: BoxRef = {
			from: info.lineStart,
			to: info.lineEnd,
			tableIndex: tables.indexOf(table),
			tableCount: tables.length,
			row: row.rowIndex,
			col: cell.cellIndex,
			box: glyph.index,
			states: glyph.states,
		};
		const file = this.app.vault.getFileByPath(section.ctx.sourcePath);
		if (!file) return null;
		// Check against the note as it is now before taking the click over. The open Reading view holds the current
		// text; elsewhere (a hover preview) the section info does. The write checks once more.
		const md = this.app.workspace.getLeavesOfType('markdown')
			.map((l) => l.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path && v.containerEl.contains(table));
		const text = md ? md.getViewData() : info.text;
		const lines = linesOf(text);
		if (lines.count > info.lineEnd && !resolveBox(lines, ref)) return null;
		return {kind: 'file', file, ref, char: glyph.char};
	}

	private async apply(hit: Hit): Promise<void> {
		const t = hit.target;
		if (t.kind === 'editor') {
			if (!toggleAt(t.view, t.pos, t.char)) new Notice('Tickbox: the note changed, nothing toggled.');
			return;
		}
		const edit = await toggleInFile(this.app, t.file, t.ref, t.char);
		if (edit) this.history.record(t.file, edit);
		else new Notice('Tickbox: the note changed, nothing toggled.');
	}
}
