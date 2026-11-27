import {redo, undo} from '@codemirror/commands';
import {EditorView} from '@codemirror/view';
import {type Editor, MarkdownView, Notice, Platform, Plugin} from 'obsidian';
import {ClickToggler} from './click';
import {cellRangeAt, editorExtensions, isCellEditor, toggleAt, undoTracker} from './editor';
import {boxesIn, nearestBox} from './table';

function viewOf(editor: Editor): EditorView | null {
	const cm = (editor as {cm?: unknown}).cm;
	return cm instanceof EditorView ? cm : null;
}

/** The Live Preview cell editor that has the focus, if any. */
function focusedCellEditor(): EditorView | null {
	const el = activeDocument.activeElement?.closest('.cm-editor');
	const view = el ? EditorView.findFromDOM(el as HTMLElement) : null;
	return view && isCellEditor(view) ? view : null;
}

function isEditable(t: EventTarget | null): boolean {
	const el = t as HTMLElement | null;
	if (!el || typeof el.closest !== 'function') return false;
	return !!el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

export default class TickboxPlugin extends Plugin {
	private clicks!: ClickToggler;

	async onload(): Promise<void> {
		this.clicks = new ClickToggler(this.app);
		this.registerMarkdownPostProcessor(this.clicks.postProcess);
		this.registerEditorExtension(editorExtensions());

		this.listenOn(window);
		this.registerEvent(this.app.workspace.on('window-open', (_w, win) => this.listenOn(win)));

		this.addCommand({
			id: 'toggle-box-in-cell',
			name: 'Toggle box in current cell',
			// Asked for in the brief (lint warns about default hotkeys). Mod+Shift+Enter is unbound in Obsidian 1.15.
			hotkeys: [{modifiers: ['Mod', 'Shift'], key: 'Enter'}],
			editorCheckCallback: (checking, editor) => this.toggleInCell(checking, editor),
		});
	}

	/** Click/tap handling and Ctrl+Z for toggles made without editor focus, on one window. */
	private listenOn(win: Window): void {
		for (const [type, fn, opts] of this.clicks.listeners()) this.registerDomEvent(win, type as keyof WindowEventMap, fn, opts);
		this.registerDomEvent(win, 'keydown', (e) => this.onKeyDown(e), {capture: true});
	}

	/** The command: flips the box nearest the cursor in the table cell the cursor is in. */
	private toggleInCell(checking: boolean, editor: Editor): boolean {
		const view = focusedCellEditor() ?? viewOf(editor);
		if (!view) return false;
		const head = view.state.selection.main.head;
		const cell = cellRangeAt(view, head);
		if (!cell) return false;
		if (checking) return true;
		const text = view.state.doc.sliceString(cell.from, cell.to);
		const box = nearestBox(boxesIn(text).map((b) => b + cell.from), head);
		if (box === null) new Notice('Tickbox: no box in this cell.');
		else toggleAt(view, box);
		return true;
	}

	/**
	 * Ctrl+Z / Ctrl+Shift+Z (Cmd on macOS) when no editor has the focus: in Reading view it takes back the toggles
	 * written to the file; in Live Preview the toggles made by clicking, while nothing else was edited since.
	 */
	private onKeyDown(e: KeyboardEvent): void {
		const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
		if (!mod || e.altKey || isEditable(e.target)) return;
		const key = e.key.toLowerCase();
		const isUndo = key === 'z' && !e.shiftKey;
		const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey);
		if (!isUndo && !isRedo) return;
		const md = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!md?.file) return;
		if (md.getMode() === 'preview') {
			const h = this.clicks.history;
			if (isUndo ? !h.canUndo(md.file) : !h.canRedo(md.file)) return;
			void (isUndo ? h.undo(md.file) : h.redo(md.file));
		} else {
			const view = viewOf(md.editor);
			const tracker = view?.plugin(undoTracker);
			if (!view || !tracker) return;
			if (isUndo && tracker.undoable > 0) undo(view);
			else if (isRedo && tracker.redoable > 0) redo(view);
			else return;
		}
		e.preventDefault();
		e.stopPropagation();
	}
}
