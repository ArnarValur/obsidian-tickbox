// Visual check: before/after pictures of real clicks and taps on boxes, plus the note's source line before/after.
// Run: npx tsx test/e2e/visual.ts   → .local/e2e/visual/ (pairs, cases.json, contact-sheet.png)
import {copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type CDPSession} from 'playwright-core';
import {NOTE, boxPoint, editorText, expectToggle, setMode, settle, sleep, tapBox, type W} from './helpers';
import {ObsidianApp, TEST_ROOT, assertTestPath} from './obsidian';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = assertTestPath(join(TEST_ROOT, 'visual'));
const vault = join(root, 'vault');
const out = join(REPO, '.local', 'e2e', 'visual');

interface Shot {
	id: string;
	view: string;
	what: string;
	row: string;
	column: string;
	boxNumber: number;
	before: string;
	after: string;
	sourceBefore: string;
	sourceAfter: string;
	expectedAfter: string;
}
const shots: Shot[] = [];

function rowLine(text: string, label: string): string {
	return text.split('\n').find((l) => l.replace(/^> /, '').startsWith(`| ${label} `)) ?? '(row not found)';
}

/** Picture of the table that holds row `label`, with a red ring around the box that is about to be pressed. */
async function tableShot(app: ObsidianApp, label: string, file: string, ring: {x: number; y: number} | null): Promise<void> {
	await app.eval(({ring}) => {
		document.getElementById('tb-ring')?.remove();
		if (!ring) return;
		const d = document.createElement('div');
		d.id = 'tb-ring';
		Object.assign(d.style, {position: 'fixed', left: `${ring.x - 14}px`, top: `${ring.y - 14}px`, width: '28px', height: '28px', border: '3px solid #ff3b30', borderRadius: '50%', pointerEvents: 'none', zIndex: '99999'});
		document.body.appendChild(d);
	}, {ring});
	const box = await app.eval((label: string) => {
		for (const row of Array.from(document.querySelectorAll('.workspace-leaf.mod-active tr')) as HTMLTableRowElement[]) {
			if (row.getClientRects().length === 0) continue;
			const first = row.cells[0];
			const vis = first && (Array.from(first.children).find((w) => w.classList.contains('table-cell-wrapper') && w.getClientRects().length > 0) ?? first);
			if (vis?.textContent?.trim() !== label) continue;
			const table = row.closest('table')!;
			let t = table.getBoundingClientRect();
			if (t.top < 0 || t.bottom > innerHeight) {
				table.scrollIntoView({block: 'center', behavior: 'instant'});
				t = table.getBoundingClientRect();
			}
			const x = Math.max(0, t.left - 24);
			const y = Math.max(0, t.top - 24);
			return {x, y, width: Math.min(innerWidth - x, t.width + 48), height: Math.min(innerHeight - y, t.height + 48)};
		}
		return null;
	}, label);
	if (box) await app.page.screenshot({path: file, clip: box});
	await app.eval(() => document.getElementById('tb-ring')?.remove());
}

async function shotCase(app: ObsidianApp, id: string, view: string, what: string, label: string, col: number, k: number, colName: string, tap?: CDPSession): Promise<void> {
	const before = await editorText(app);
	const expected = expectToggle(before, label, col, k);
	const p = await boxPoint(app, label, col, k);
	const fBefore = join(out, `${id}-before.png`);
	const fAfter = join(out, `${id}-after.png`);
	await tableShot(app, label, fBefore, p);
	if (p) {
		if (tap) await tapBox(app, tap, label, col, k);
		else await app.page.mouse.click(p.x, p.y);
	}
	await settle(app, expected);
	await sleep(400);
	// after a flip the row label stays the same unless the box was in the first column
	let n = -1;
	const afterLabel = col === 0 ? label.replace(/[☐☑]/g, (c) => (++n === k ? (c === '☐' ? '☑' : '☐') : c)) : label;
	await tableShot(app, afterLabel, fAfter, null);
	const after = await editorText(app);
	shots.push({id, view, what, row: label, column: colName, boxNumber: k + 1, before: fBefore, after: fAfter,
		sourceBefore: rowLine(before, label), sourceAfter: rowLine(after, afterLabel), expectedAfter: rowLine(expected, afterLabel)});
	console.log(`${id}: ${after === expected ? 'source as expected' : 'SOURCE DIFFERS'}`);
}

rmSync(root, {recursive: true, force: true});
rmSync(out, {recursive: true, force: true});
mkdirSync(join(vault, '.obsidian', 'plugins', 'tickbox'), {recursive: true});
mkdirSync(out, {recursive: true});
for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(join(REPO, f), join(vault, '.obsidian', 'plugins', 'tickbox', f));
copyFileSync(join(REPO, 'test', 'fixtures', NOTE), join(vault, NOTE));
writeFileSync(join(vault, 'Tickbox.md'), '# Tickbox\n');

const app = await ObsidianApp.launch({vault, userData: join(root, 'userdata'), logDir: join(root, 'logs')});
try {
	await app.enablePlugin('tickbox');
	await app.reload('tickbox');

	await setMode(app, 'live');
	await shotCase(app, 'lp1', 'Live Preview (desktop, mouse)', 'single box', 'Buy milk', 1, 0, 'Done');
	await shotCase(app, 'lp2', 'Live Preview (desktop, mouse)', '3rd of 4 boxes in one cell', 'Gym', 1, 2, 'Mon Tue Wed Thu');
	await shotCase(app, 'lp3', 'Live Preview (desktop, mouse)', 'several boxes per row: Hoover', 'Kitchen', 3, 0, 'Hoover');
	await shotCase(app, 'lp4', 'Live Preview (desktop, mouse)', 'box between words', 'Oslo', 1, 1, 'Packing list');
	await shotCase(app, 'lp5', 'Live Preview (desktop, mouse)', 'box at the end of a cell', '☐ first', 1, 0, 'End');
	await shotCase(app, 'lp6', 'Live Preview (desktop, mouse)', 'table inside a callout', 'Basil', 1, 0, 'Watered');
	{
		// undo: picture after Ctrl+Z must match the picture before lp6's click
		const before = await editorText(app);
		await app.page.keyboard.press('Control+z');
		await sleep(600);
		const f = join(out, 'lp7-after.png');
		await tableShot(app, 'Basil', f, null);
		shots.push({id: 'lp7', view: 'Live Preview (desktop, mouse)', what: 'Ctrl+Z after lp6', row: 'Basil', column: 'Watered', boxNumber: 1,
			before: join(out, 'lp6-after.png'), after: f, sourceBefore: rowLine(before, 'Basil'), sourceAfter: rowLine(await editorText(app), 'Basil'), expectedAfter: rowLine(expectToggle(before, 'Basil', 1, 0), 'Basil')});
	}

	await setMode(app, 'reading');
	await shotCase(app, 'rv1', 'Reading view (desktop, mouse)', 'untick a ticked box', 'Call mum', 1, 0, 'Done');
	await shotCase(app, 'rv2', 'Reading view (desktop, mouse)', '2nd of 4 boxes in one cell', 'Read', 1, 1, 'Mon Tue Wed Thu');
	await shotCase(app, 'rv3', 'Reading view (desktop, mouse)', 'box at the start of a cell', '☑ done', 0, 0, 'Start');
	await shotCase(app, 'rv4', 'Reading view (desktop, mouse)', 'last box after code', 'Shop', 1, 3, 'Packing list');

	await app.eval(() => (window as unknown as W).app.emulateMobile(true));
	await sleep(3000);
	await app.page.evaluate('globalThis.__name = (f) => f;');
	await app.waitFor('phone layout', () => (window as unknown as W).app?.workspace?.layoutReady && !!(window as unknown as W).app.plugins.plugins['tickbox'], 60_000);
	const cdp = await app.page.context().newCDPSession(app.page);
	await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
	await setMode(app, 'live');
	await shotCase(app, 'ph1', 'Phone layout, Live Preview (touch tap)', 'tap a single box', 'Pay rent', 1, 0, 'Done', cdp);
	await shotCase(app, 'ph2', 'Phone layout, Live Preview (touch tap)', 'tap Tidy in a row of boxes', 'Bedroom', 2, 0, 'Tidy', cdp);
	await setMode(app, 'reading');
	await shotCase(app, 'ph3', 'Phone layout, Reading view (touch tap)', 'tap the first box', 'Rosemary', 1, 0, 'Watered', cdp);
	await app.page.screenshot({path: join(out, 'phone-full.png')});
	await app.eval(() => (window as unknown as W).app.emulateMobile(false));
	await sleep(1500);
} finally {
	await app.quit();
}

writeFileSync(join(out, 'cases.json'), JSON.stringify(shots, null, 2));

// One contact sheet: each row = before | after, with the source line under each.
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const img = (f: string): string => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
const html = `<html><body style="font:14px sans-serif;background:#fff;margin:16px;width:1100px">
<h2 style="margin:0 0 4px">Tickbox — before / after each click or tap</h2>
<div style="color:#555;margin-bottom:12px">Red ring = where the click/tap lands. Text under each picture = that row in the note file.</div>
${shots.map((s) => `<div style="border-top:1px solid #ccc;padding:10px 0">
<b>${s.id} · ${esc(s.view)} · ${esc(s.what)}</b> — row “${esc(s.row)}”, column “${esc(s.column)}”, box ${s.boxNumber}
<div style="display:flex;gap:16px;margin-top:6px;align-items:flex-start">
<div><div style="color:#555">before</div><img src="${img(s.before)}" style="max-width:520px"><pre style="margin:4px 0">${esc(s.sourceBefore)}</pre></div>
<div><div style="color:#555">after</div><img src="${img(s.after)}" style="max-width:520px"><pre style="margin:4px 0">${esc(s.sourceAfter)}</pre></div>
</div></div>`).join('')}
</body></html>`;
writeFileSync(join(out, 'contact-sheet.html'), html);
const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--headless=new', '--no-sandbox']});
const page = await browser.newPage({deviceScaleFactor: 1});
await page.setContent(html);
await page.screenshot({path: join(out, 'contact-sheet.png'), fullPage: true});
await browser.close();
console.log(`done: ${shots.length} cases → ${out}`);
