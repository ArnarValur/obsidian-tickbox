// CodeMirror side: toggling a box in an editor, undo bookkeeping, and the [] → ☐ quick insert.
import {isolateHistory} from '@codemirror/commands';
import {syntaxTree} from '@codemirror/language';
import {Annotation, Transaction, type EditorState, type Extension} from '@codemirror/state';
import {EditorView, ViewPlugin, type ViewUpdate} from '@codemirror/view';
import {UNCHECKED, bracketsStandAlone, cellAt, isBox, isDelimiterRow, tableAt, toggled, type Lines} from './table';

/** Marks transactions made by Tickbox. */
export const tickboxEdit = Annotation.define<'toggle' | 'insert'>();

/** True for the small editor Obsidian puts inside a Live Preview table cell while you edit it. */
export function isCellEditor(view: EditorView): boolean {
	return !!view.dom.parentElement?.closest('.cm-editor') && !!view.dom.closest('td, th');
}

/** An editor's document as 0-based Lines. */
export function docLines(state: EditorState): Lines {
	return {count: state.doc.lines, line: (n) => state.doc.line(n + 1).text};
}

/** The table cell around `pos` as document offsets, or null when `pos` is not in a table cell. */
export function cellRangeAt(view: EditorView, pos: number): {from: number; to: number} | null {
	const {state} = view;
	if (isCellEditor(view)) return {from: 0, to: state.doc.length};
	const line = state.doc.lineAt(pos);
	const block = tableAt(docLines(state), line.number - 1);
	if (!block || isDelimiterRow(line.text)) return null;
	const cell = cellAt(line.text, pos - line.from);
	return cell ? {from: line.from + cell.from, to: line.from + cell.to} : null;
}

/** Flips the box at `pos` (checked against `expected` when given). One undo step per toggle. */
export function toggleAt(view: EditorView, pos: number, expected?: string): boolean {
	const ch = view.state.doc.sliceString(pos, pos + 1);
	if (!isBox(ch) || (expected !== undefined && ch !== expected)) return false;
	view.dispatch({
		changes: {from: pos, to: pos + 1, insert: toggled(ch)},
		annotations: [tickboxEdit.of('toggle'), isolateHistory.of('full')],
	});
	return true;
}

/**
 * Counts Tickbox toggles that undo can still take back, so Ctrl+Z also works when the editor has no focus (Reading
 * view, or a click in a Live Preview table that kept the focus elsewhere). Any other edit resets the count.
 */
export class UndoTracker {
	undoable = 0;
	redoable = 0;
	update(u: ViewUpdate): void {
		for (const tr of u.transactions) {
			if (tr.annotation(tickboxEdit) === 'toggle') {
				this.undoable++;
				this.redoable = 0;
			} else if (tr.isUserEvent('undo')) {
				if (this.undoable > 0) {
					this.undoable--;
					this.redoable++;
				}
			} else if (tr.isUserEvent('redo')) {
				if (this.redoable > 0) {
					this.redoable--;
					this.undoable++;
				}
			} else if (tr.docChanged) {
				this.undoable = 0;
				this.redoable = 0;
			}
		}
	}
}

export const undoTracker = ViewPlugin.fromClass(UndoTracker);

function inCode(state: EditorState, pos: number): boolean {
	try {
		let node = syntaxTree(state).resolveInner(pos, -1);
		for (;;) {
			if (/code/i.test(node.name)) return true;
			if (!node.parent) return false;
			node = node.parent;
		}
	} catch {
		return false;
	}
}

/** Typing `]` right after `[` inside a table cell replaces the `[]` with ☐ (also after Obsidian's auto-pair). */
class QuickInsert {
	/** When a `]` key or text input last reached this editor (soft keyboards report the text, not the key). */
	closeTypedAt = 0;

	constructor(readonly view: EditorView) {}

	update(u: ViewUpdate): void {
		const sel = u.state.selection.main;
		if (!sel.empty || sel.head < 2 || u.state.selection.ranges.length > 1) return;
		const head = sel.head;
		if (u.state.doc.sliceString(head - 2, head) !== '[]') return;
		if (u.docChanged ? this.typedClose(u, head) : this.typedOver(u, head)) this.schedule(head, 0);
	}

	/** A `]` was typed and inserted just before the cursor. */
	typedClose(u: ViewUpdate, head: number): boolean {
		if (!u.transactions.some((tr) => tr.isUserEvent('input.type'))) return false;
		let typed = false;
		u.changes.iterChanges((_fa, _ta, fromB, toB, inserted) => {
			if (fromB <= head - 1 && toB >= head && inserted.sliceString(head - 1 - fromB, head - fromB) === ']') typed = true;
		});
		return typed;
	}

	/**
	 * Obsidian's auto-pair: typing `[` gives `[]` with the cursor inside, and typing `]` then only moves the cursor
	 * past the `]` (a selection change with no user event; arrow keys and clicks carry "select" events).
	 */
	typedOver(u: ViewUpdate, head: number): boolean {
		if (Date.now() - this.closeTypedAt > 500) return false;
		if (!u.selectionSet || u.transactions.some((tr) => tr.annotation(Transaction.userEvent) !== undefined)) return false;
		const before = u.startState.selection.main;
		return before.empty && before.head === head - 1;
	}

	schedule(head: number, tries: number): void {
		window.setTimeout(() => this.convert(head, tries), 0);
	}

	convert(head: number, tries: number): void {
		const {view} = this;
		if (view.composing) {
			if (tries < 40) this.schedule(head, tries + 1);
			return;
		}
		const {state} = view;
		if (state.selection.main.head !== head || state.doc.sliceString(head - 2, head) !== '[]') return;
		const cell = cellRangeAt(view, head - 2);
		if (!cell || inCode(state, head - 1)) return;
		const text = state.doc.sliceString(cell.from, cell.to);
		if (!bracketsStandAlone(text, head - cell.from, 0)) return;
		view.dispatch({
			changes: {from: head - 2, to: head, insert: UNCHECKED},
			selection: {anchor: head - 1},
			annotations: tickboxEdit.of('insert'),
			userEvent: 'input.tickbox',
		});
	}
}

const quickInsert = ViewPlugin.fromClass(QuickInsert, {
	eventHandlers: {
		keydown(e) {
			if (e.key === ']') this.closeTypedAt = Date.now();
		},
		beforeinput(e) {
			if (e.data?.endsWith(']')) this.closeTypedAt = Date.now();
		},
	},
});

export function editorExtensions(): Extension {
	return [undoTracker, quickInsert];
}
