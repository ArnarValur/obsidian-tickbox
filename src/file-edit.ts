// Reading view writes the note file directly: there the note's hidden editor is not what gets saved, so an edit
// made through it would be lost or overwritten. Undo/redo for those writes is kept here, one stack per note.
import type {App, TFile} from 'obsidian';
import {linesOf, resolveBox, toggled, type BoxRef} from './table';

/** One line changed by a toggle: undo puts `before` back while the line still reads `after`. */
interface LineEdit {
	line: number;
	before: string;
	after: string;
}

/** Applies `change` to line `n` of the file if `check` passes; returns the edit, or null when nothing changed. */
async function editLine(app: App, file: TFile, pick: (text: string) => {line: number; next: string} | null): Promise<LineEdit | null> {
	let edit: LineEdit | null = null;
	await app.vault.process(file, (data) => {
		const lines = data.split('\n');
		const p = pick(data);
		const before = p ? lines[p.line] : undefined;
		if (!p || before === undefined) return data;
		lines[p.line] = p.next;
		edit = {line: p.line, before, after: p.next};
		return lines.join('\n');
	});
	return edit;
}

/** Flips the box `ref` points at in the file, if the file still matches what was on screen. */
export function toggleInFile(app: App, file: TFile, ref: BoxRef, char: string): Promise<LineEdit | null> {
	return editLine(app, file, (data) => {
		const at = resolveBox(linesOf(data), ref);
		const line = at ? data.split('\n')[at.line] : undefined;
		if (!at || line === undefined || line[at.ch] !== char) return null;
		return {line: at.line, next: line.slice(0, at.ch) + toggled(char) + line.slice(at.ch + 1)};
	});
}

export class FileHistory {
	private undoStack = new Map<string, LineEdit[]>();
	private redoStack = new Map<string, LineEdit[]>();

	constructor(private readonly app: App) {}

	record(file: TFile, edit: LineEdit): void {
		this.stack(this.undoStack, file).push(edit);
		this.redoStack.delete(file.path);
	}

	canUndo(file: TFile): boolean {
		return (this.undoStack.get(file.path)?.length ?? 0) > 0;
	}

	canRedo(file: TFile): boolean {
		return (this.redoStack.get(file.path)?.length ?? 0) > 0;
	}

	/** Takes back the last toggle in this note. If that line was changed since, the history is dropped instead. */
	async undo(file: TFile): Promise<boolean> {
		return this.move(file, this.undoStack, this.redoStack, (e) => ({from: e.after, to: e.before}));
	}

	async redo(file: TFile): Promise<boolean> {
		return this.move(file, this.redoStack, this.undoStack, (e) => ({from: e.before, to: e.after}));
	}

	private async move(file: TFile, from: Map<string, LineEdit[]>, to: Map<string, LineEdit[]>, dir: (e: LineEdit) => {from: string; to: string}): Promise<boolean> {
		const edit = from.get(file.path)?.pop();
		if (!edit) return false;
		const {from: expect, to: next} = dir(edit);
		const done = await editLine(this.app, file, (data) => (data.split('\n')[edit.line] === expect ? {line: edit.line, next} : null));
		if (!done) {
			this.undoStack.delete(file.path);
			this.redoStack.delete(file.path);
			return false;
		}
		this.stack(to, file).push(edit);
		return true;
	}

	private stack(map: Map<string, LineEdit[]>, file: TFile): LineEdit[] {
		let s = map.get(file.path);
		if (!s) map.set(file.path, (s = []));
		return s;
	}
}
