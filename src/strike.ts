// Strike boxes: a ticked ☒ in a table cell strikes through that cell's text, or the whole row when the box stands
// alone in its cell. Only the rendered table is styled (CSS classes); the note's text never changes.
import {ViewPlugin, type EditorView} from '@codemirror/view';
import {isCellEditor} from './editor';
import {strikeOf} from './table';

/** On each element whose text is struck (a Reading-view cell, or a Live Preview cell's rendered wrapper). */
export const STRUCK = 'tickbox-struck';
/** On a row struck whole, for themes that want to style it. */
export const STRUCK_ROW = 'tickbox-struck-row';

/** The rendered part of a cell: Live Preview wraps it in `.table-cell-wrapper` (a second one holds the cell editor). */
function renderedPart(cell: HTMLTableCellElement): HTMLElement {
	for (const w of Array.from(cell.children)) {
		if (w.classList.contains('table-cell-wrapper') && !w.querySelector('.cm-editor')) return w as HTMLElement;
	}
	return cell;
}

function setClass(el: Element, cls: string, on: boolean): void {
	if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** Applies the strike classes to every row of `table`, removing stale ones. */
export function markTable(table: HTMLTableElement): void {
	for (const row of Array.from(table.rows)) {
		const parts = Array.from(row.cells).map(renderedPart);
		const strikes = parts.map((p) => strikeOf(p.textContent ?? ''));
		const whole = strikes.includes('row');
		setClass(row, STRUCK_ROW, whole);
		parts.forEach((p, i) => setClass(p, STRUCK, whole || strikes[i] === 'cell'));
	}
}

/** Applies the strike classes to every table inside `root`. */
export function markTables(root: HTMLElement): void {
	for (const t of Array.from(root.querySelectorAll('table'))) markTable(t);
}

/**
 * Live Preview: Obsidian renders tables as widgets and re-renders them on its own schedule, so watch the editor's
 * DOM and re-mark the tables after any change (once per frame). Class changes are attributes, which are not watched.
 */
class LivePreviewStrikes {
	private readonly observer: MutationObserver | null = null;
	private frame = 0;

	constructor(private readonly view: EditorView) {
		if (isCellEditor(view)) return;
		this.observer = new MutationObserver(() => this.schedule());
		this.observer.observe(view.contentDOM, {childList: true, subtree: true, characterData: true});
		this.schedule();
	}

	private schedule(): void {
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			markTables(this.view.contentDOM);
		});
	}

	destroy(): void {
		this.observer?.disconnect();
		if (this.frame) window.cancelAnimationFrame(this.frame);
	}
}

export const livePreviewStrikes = ViewPlugin.fromClass(LivePreviewStrikes);
