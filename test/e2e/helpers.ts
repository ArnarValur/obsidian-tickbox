// Window helpers shared by the e2e check (run.ts) and the visual check (visual.ts).
import {readFileSync} from 'node:fs';
import type {CDPSession} from 'playwright-core';
import type {ObsidianApp} from './obsidian';

export const NOTE = 'Tickbox Test Tables.md';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Obsidian's internal app object, test code only
export type W = Window & {app: any};

// ---------- independent expectations ----------
export const BOX = /[☐☑]/g;
/** Flips box `k` of column `col` in the row whose first cell is `label` (simple split: test rows have no escapes). */
export function expectToggle(text: string, label: string, col: number, k: number): string {
	const lines = text.split('\n');
	const i = lines.findIndex((l) => new RegExp(`^(> )?\\| ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +\\|`).test(l));
	if (i < 0) throw new Error(`row ${label} not found`);
	const line = lines[i]!;
	const pipes = [...line.matchAll(/\|/g)].map((m) => m.index!);
	const from = pipes[col]! + 1;
	const to = pipes[col + 1]!;
	const at = [...line.slice(from, to).matchAll(BOX)][k];
	if (!at) throw new Error(`box ${k} of ${label}/${col} not found`);
	const p = from + at.index!;
	lines[i] = line.slice(0, p) + (line[p] === '☐' ? '☑' : '☐') + line.slice(p + 1);
	return lines.join('\n');
}

export function diffSummary(a: string, b: string): string {
	const x = a.split('\n');
	const y = b.split('\n');
	const out: string[] = [];
	for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(`L${i + 1}: "${x[i]}" -> "${y[i]}"`);
	return out.slice(0, 6).join(' | ') || '(same)';
}

// ---------- window helpers ----------
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The note as the open view holds it (the editor in Live Preview/Source, the loaded file in Reading view). */
export async function editorText(app: ObsidianApp): Promise<string> {
	return app.eval(() => (window as unknown as W).app.workspace.getMostRecentLeaf().view.getViewData());
}

/** Polls the view until it holds `want` (Reading view writes go through the file, so they land a moment later). */
export async function settle(app: ObsidianApp, want: string, ms = 2500): Promise<string> {
	const end = Date.now() + ms;
	let t = await editorText(app);
	while (t !== want && Date.now() < end) {
		await sleep(100);
		t = await editorText(app);
	}
	return t;
}

/** Puts the cursor at the end of the Live Preview cell editor that is open. */
export async function cellEditorCursorToEnd(app: ObsidianApp): Promise<boolean> {
	return app.eval(() => {
		const v = (window as unknown as W).app.workspace.getMostRecentLeaf().view;
		const el = document.querySelector('.workspace-leaf.mod-active td .cm-editor');
		const nv = el ? v.editor.cm.constructor.findFromDOM(el) : null;
		if (!nv) return false;
		nv.focus();
		nv.dispatch({selection: {anchor: nv.state.doc.length}});
		return true;
	});
}

export async function diskText(app: ObsidianApp, path: string): Promise<string> {
	await app.eval(async () => {
		const v = (window as unknown as W).app.workspace.getMostRecentLeaf().view;
		await v.save();
	});
	return readFileSync(path, 'utf8');
}

export async function setMode(app: ObsidianApp, mode: 'live' | 'source' | 'reading', file = NOTE): Promise<void> {
	await app.eval(async ({m, file}) => {
		const a = (window as unknown as W).app;
		const leaf = a.workspace.getLeaf(false);
		const state = m === 'reading' ? {file, mode: 'preview'} : {file, mode: 'source', source: m === 'source'};
		await leaf.setViewState({type: 'markdown', state, active: true});
		a.workspace.setActiveLeaf(leaf, {focus: true});
	}, {m: mode, file});
	await sleep(700);
}

/** Screen centre of box `k` in column `col` of the rendered row labelled `label` (null when not visible). */
export async function boxPoint(app: ObsidianApp, label: string, col: number, k: number): Promise<{x: number; y: number} | null> {
	await boxPointOnce(app, label, col, k, true);
	await sleep(250);
	return boxPointOnce(app, label, col, k, false);
}

export async function boxPointOnce(app: ObsidianApp, label: string, col: number, k: number, scroll: boolean): Promise<{x: number; y: number} | null> {
	return app.eval(({label, col, k, scroll}) => {
		const root = document.querySelector('.workspace-leaf.mod-active .view-content')!;
		for (const row of Array.from(root.querySelectorAll('tr'))) {
			const first = row.cells[0];
			const visible = (c: Element): Element => Array.from(c.children).find((w) => w.classList.contains('table-cell-wrapper') && w.getClientRects().length > 0) ?? c;
			if (!first || row.getClientRects().length === 0 || visible(first).textContent?.trim() !== label) continue;
			const cell = row.cells[col];
			if (!cell) return null;
			if (scroll) cell.scrollIntoView({block: 'center', behavior: 'instant'});
			const scope = visible(cell);
			const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
			let n = 0;
			for (let t = walker.nextNode(); t; t = walker.nextNode()) {
				const s = (t as Text).data;
				for (let i = 0; i < s.length; i++) {
					if (s[i] !== '☐' && s[i] !== '☑') continue;
					if (n++ === k) {
						const r = document.createRange();
						r.setStart(t, i);
						r.setEnd(t, i + 1);
						const b = r.getBoundingClientRect();
						return {x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2};
					}
				}
			}
		}
		return null;
	}, {label, col, k, scroll});
}

export async function clickBox(app: ObsidianApp, label: string, col: number, k: number): Promise<boolean> {
	const p = await boxPoint(app, label, col, k);
	if (!p) return false;
	await app.page.mouse.click(p.x, p.y);
	await sleep(350);
	return true;
}

export async function tapBox(app: ObsidianApp, cdp: CDPSession, label: string, col: number, k: number): Promise<boolean> {
	const p = await boxPoint(app, label, col, k);
	if (!p) return false;
	await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: p.x, y: p.y}]});
	await sleep(60);
	await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
	await sleep(450);
	return true;
}

