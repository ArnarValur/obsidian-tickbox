// End-to-end check in a real, isolated, headless Obsidian (see obsidian.ts). Run: npm run e2e
// Real mouse clicks / touch taps at the boxes' screen positions, then the note is read back from the editor and
// from disk and compared with an independent expectation (simple string work, not the plugin's own parser).
import {copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {CDPSession} from 'playwright-core';
import {ObsidianApp, TEST_ROOT, assertTestPath} from './obsidian';
import {BOX, NOTE, boxPoint, cellEditorCursorToEnd, clickBox, diffSummary, diskText, editorText, expectToggle, setMode, settle, sleep, tapBox, type W} from './helpers';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = assertTestPath(join(TEST_ROOT, 'e2e'));
const vault = join(root, 'vault');
const shots = join(REPO, '.local', 'e2e');

interface Case { name: string; ok: boolean; detail?: string }
const results: Case[] = [];
function check(name: string, ok: boolean, detail?: string): void {
	results.push({name, ok, detail});
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
}

/** Click, then check both the editor text and the saved file against the expectation. */
async function clickCase(app: ObsidianApp, name: string, label: string, col: number, k: number, tap?: CDPSession): Promise<void> {
	const before = await editorText(app);
	const expected = expectToggle(before, label, col, k);
	const found = tap ? await tapBox(app, tap, label, col, k) : await clickBox(app, label, col, k);
	if (!found) return check(name, false, 'box not on screen');
	const after = await settle(app, expected);
	const disk = await diskText(app, join(vault, NOTE));
	check(name, after === expected && disk === expected, `editor: ${diffSummary(expected, after)}; disk: ${diffSummary(expected, disk)}`);
}

// ---------- the run ----------
rmSync(root, {recursive: true, force: true});
mkdirSync(join(vault, '.obsidian', 'plugins', 'tickbox'), {recursive: true});
mkdirSync(shots, {recursive: true});
for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(join(REPO, f), join(vault, '.obsidian', 'plugins', 'tickbox', f));
copyFileSync(join(REPO, 'test', 'fixtures', NOTE), join(vault, NOTE));
writeFileSync(join(vault, 'Tickbox.md'), '# Tickbox\n');
writeFileSync(join(vault, 'Hidden box.md'), '| A | B |\n|---|---|\n| x | %%☐%% ☐ |\n');
writeFileSync(join(vault, 'Typing.md'), 'plain line\n\n| Name | Notes |\n|---|---|\n| one | write here |\n| two | another |\n');
const original = readFileSync(join(vault, NOTE), 'utf8');

const app = await ObsidianApp.launch({vault, userData: join(root, 'userdata'), logDir: join(root, 'logs')});
const errors: string[] = [];
app.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
app.page.on('pageerror', (e) => errors.push(String(e)));
try {
	await app.enablePlugin('tickbox');
	await app.reload('tickbox');
	const info = await app.eval(() => {
		const a = (window as unknown as W).app;
		const clash = Object.entries(a.hotkeyManager.defaultKeys as Record<string, Array<{modifiers: string[]; key: string}>>)
			.filter(([id, ks]) => id !== 'tickbox:toggle-box-in-cell' && ks.some((k) => k.key === 'Enter' && k.modifiers.includes('Mod') && k.modifiers.includes('Shift') && k.modifiers.length === 2))
			.map(([id]) => id);
		return {version: (window as any).require('electron').ipcRenderer.sendSync('version') as string, clash};
	});
	console.log(`Obsidian ${info.version}`);
	check('default hotkey Mod+Shift+Enter is not used by Obsidian itself', info.clash.length === 0, info.clash.join(', '));

	// ----- Live Preview -----
	await setMode(app, 'live');
	await app.page.screenshot({path: join(shots, 'live-preview-before.png')});
	await clickCase(app, 'LP: single box', 'Buy milk', 1, 0);
	await clickCase(app, 'LP: untick a ticked box', 'Call mum', 1, 0);
	await clickCase(app, 'LP: 3rd of 4 boxes in a cell', 'Gym', 1, 2);
	await clickCase(app, 'LP: 2nd box of a cell, neighbours untouched', 'Read', 1, 1);
	await clickCase(app, 'LP: several boxes per row (Hoover)', 'Kitchen', 3, 0);
	await clickCase(app, 'LP: several boxes per row (Tidy, same row)', 'Kitchen', 2, 0);
	await clickCase(app, 'LP: mixed text, middle box', 'Oslo', 1, 1);
	await clickCase(app, 'LP: box after bold text', 'Shop', 1, 1);
	await clickCase(app, 'LP: box at the end of a cell', '☐ first', 1, 0);
	await clickCase(app, 'LP: last box of a two-box cell', '☐ first', 2, 1);
	await clickCase(app, 'LP: first box of a two-box cell', '☐ first', 2, 0);
	await clickCase(app, 'LP: box at the start of a cell', '☑ done', 0, 0);
	await clickCase(app, 'LP: table inside a callout', 'Basil', 1, 0);
	// two quick clicks on different boxes of one cell: the second must not be swallowed
	{
		const before = await editorText(app);
		const exp = expectToggle(expectToggle(before, 'Gym', 1, 0), 'Gym', 1, 1);
		const a = await boxPoint(app, 'Gym', 1, 0);
		const b = await boxPoint(app, 'Gym', 1, 1);
		if (a && b) {
			await app.page.mouse.click(a.x, a.y);
			await sleep(120);
			await app.page.mouse.click(b.x, b.y);
			await sleep(400);
		}
		const after = await editorText(app);
		check('LP: two quick clicks on neighbouring boxes both count', after === exp, diffSummary(exp, after));
	}
	// the click must not have opened the cell editor
	check('LP: clicking a box does not open the cell editor', await app.eval(() => !document.querySelector('.workspace-leaf.mod-active td .cm-editor')));

	// undo / redo after clicks
	{
		const before = await editorText(app);
		await clickBox(app, 'Pay rent', 1, 0);
		const toggled = await editorText(app);
		await app.page.keyboard.press('Control+z');
		await sleep(300);
		const undone = await editorText(app);
		await app.page.keyboard.press('Control+Shift+Z');
		await sleep(300);
		const redone = await editorText(app);
		check('LP: Ctrl+Z undoes a click', toggled !== before && undone === before, diffSummary(before, undone));
		check('LP: Ctrl+Shift+Z redoes it', redone === toggled, diffSummary(toggled, redone));
		await app.page.keyboard.press('Control+z');
		await sleep(200);
	}

	// cell editor: click into the text of a cell, then click a box inside the open cell editor
	{
		const p = await boxPoint(app, 'Oslo', 1, 0);
		if (p) await app.page.mouse.click(p.x + 40, p.y);
		await sleep(500);
		const open = await app.eval(() => !!document.querySelector('.workspace-leaf.mod-active td .cm-editor'));
		check('LP: clicking cell text still opens the cell editor', open);
		await clickCase(app, 'LP: click a box inside an open cell editor', 'Oslo', 1, 2);
		// command via hotkey inside the cell editor, cursor at the end of the cell → nearest box is the last one
		const before = await editorText(app);
		await cellEditorCursorToEnd(app);
		await app.page.keyboard.press('Control+Shift+Enter');
		await sleep(300);
		const after = await editorText(app);
		check('LP: hotkey in a cell editor flips the box nearest the cursor', after === expectToggle(before, 'Oslo', 1, 2), diffSummary(expectToggle(before, 'Oslo', 1, 2), after));
		await app.page.keyboard.press('Control+z');
		await sleep(300);
		check('LP: Ctrl+Z in the cell editor undoes the hotkey toggle', (await editorText(app)) === before, diffSummary(before, await editorText(app)));
		await app.page.keyboard.press('Escape');
		await sleep(200);
	}
	await app.page.screenshot({path: join(shots, 'live-preview-after.png')});

	// ----- Source mode: command and quick insert on raw table text -----
	await setMode(app, 'source');
	{
		const before = await editorText(app);
		const line = before.split('\n').findIndex((l) => l.startsWith('| Bedroom'));
		const ch = before.split('\n')[line]!.indexOf('|', 12) + 3; // inside the "Tidy" cell
		await app.eval(({line, ch}) => {
			const v = (window as unknown as W).app.workspace.getMostRecentLeaf().view;
			v.editor.focus();
			v.editor.setCursor({line, ch});
		}, {line, ch});
		await app.page.keyboard.press('Control+Shift+Enter');
		await sleep(300);
		const after = await editorText(app);
		check('Source: hotkey flips the box in the cursor cell', after === expectToggle(before, 'Bedroom', 2, 0), diffSummary(expectToggle(before, 'Bedroom', 2, 0), after));
		await app.eval(() => (window as unknown as W).app.commands.executeCommandById('tickbox:toggle-box-in-cell'));
		await sleep(300);
		check('Source: command from the palette flips it back', (await editorText(app)) === before, diffSummary(before, await editorText(app)));
	}

	// ----- Quick insert: typing [] in a cell (own note, so the main note stays comparable) -----
	await setMode(app, 'live', 'Typing.md');
	{
		const p = await app.eval(() => {
			for (const td of Array.from(document.querySelectorAll('.workspace-leaf.mod-active td'))) {
				if (td.textContent?.trim() !== 'write here') continue;
				const r = td.querySelector('.table-cell-wrapper')!.getBoundingClientRect();
				return {x: r.left + 10, y: (r.top + r.bottom) / 2};
			}
			return null;
		});
		if (p) await app.page.mouse.click(p.x, p.y);
		await sleep(500);
		await cellEditorCursorToEnd(app);
		await app.page.keyboard.type(' []');
		await sleep(400);
		const t1 = await editorText(app);
		check('LP: typing [] in a cell editor makes ☐', t1.includes('| write here ☐') && !t1.includes('[]'), t1.split('\n')[4]);
		await app.page.keyboard.type(' [[');
		await sleep(300);
		const t2 = await editorText(app);
		check('LP: typing [[ in a cell still starts a link', t2.includes('☐ [['), t2.split('\n')[4]);
		await app.page.keyboard.press('Escape');
		await sleep(200);
	}
	await app.page.keyboard.press('Escape');
	await setMode(app, 'source', 'Typing.md');
	{
		const lineOf = async (n: number): Promise<string> => (await editorText(app)).split('\n')[n] ?? '';
		// After a Live Preview cell editor closes, editor.focus() alone does not take the focus back: click the text.
		const firstLine = await app.page.locator('.workspace-leaf.mod-active .cm-line').first().boundingBox();
		if (firstLine) await app.page.mouse.click(firstLine.x + 5, firstLine.y + firstLine.height / 2);
		await sleep(200);
		const put = (line: number, ch: number): Promise<void> => app.eval(({line, ch}) => {
			const v = (window as unknown as W).app.workspace.getMostRecentLeaf().view;
			v.editor.focus();
			v.editor.setCursor({line, ch});
		}, {line, ch});
		const row = await lineOf(5);
		await put(5, row.indexOf('another') + 'another'.length);
		await app.page.keyboard.type(' []');
		await sleep(300);
		const t1 = await editorText(app);
		check('Source: typing [] in a table cell makes ☐', t1.split('\n')[5] === row.replace('another', 'another ☐'), t1.split('\n')[5]);
		await app.page.keyboard.press('Control+z');
		await sleep(300);
		const t2 = await editorText(app);
		check('Source: Ctrl+Z after quick insert takes the ☐ back', !t2.split('\n')[5]!.includes('☐'), t2.split('\n')[5]);
		await put(0, 'plain line'.length);
		await app.page.keyboard.type(' []');
		await sleep(300);
		const t3 = await editorText(app);
		check('Source: typing [] outside a table stays []', t3.split('\n')[0] === 'plain line []', t3.split('\n')[0]);
		const row5 = await lineOf(5);
		await put(5, row5.indexOf('another') + 'another'.length);
		await app.page.keyboard.type(' [');
		await app.page.keyboard.press('ArrowRight');
		await sleep(300);
		const t4 = await lineOf(5);
		check('Source: arrowing past an auto-paired ] keeps []', t4.includes('another []') && !t4.includes('☐'), t4);
	}

	// ----- Reading view -----
	await setMode(app, 'reading');
	await app.page.screenshot({path: join(shots, 'reading-before.png')});
	await clickCase(app, 'Reading: single box', 'Buy milk', 1, 0);
	await clickCase(app, 'Reading: 4th of 4 boxes in a cell', 'Gym', 1, 3);
	await clickCase(app, 'Reading: several per row (Clean)', 'Bedroom', 1, 0);
	await clickCase(app, 'Reading: mixed text, last box', 'Oslo', 1, 2);
	await clickCase(app, 'Reading: box at the end of a cell', '☐ done', 1, 0);
	await clickCase(app, 'Reading: box at the start of a cell', '☐ first', 0, 0);
	await clickCase(app, 'Reading: table inside a callout', 'Rosemary', 1, 0);
	{
		await sleep(300);
		const before = await editorText(app);
		await clickBox(app, 'Pay rent', 1, 0);
		const toggled = await settle(app, expectToggle(before, 'Pay rent', 1, 0));
		await app.page.keyboard.press('Control+z');
		const undone = await settle(app, before);
		check('Reading: Ctrl+Z undoes a click', toggled !== before && undone === before, diffSummary(before, undone));
		await sleep(300);
		const p = await boxPoint(app, 'Pay rent', 1, 0);
		const shown = p ? await app.eval(({x, y}) => document.elementFromPoint(x, y)?.textContent ?? '', p) : '';
		check('Reading: the view shows the undone state', shown.includes('☐'), shown);
		await app.page.keyboard.press('Control+Shift+Z');
		const redone = await settle(app, toggled);
		check('Reading: Ctrl+Shift+Z redoes it', redone === toggled, diffSummary(toggled, redone));
		await app.page.keyboard.press('Control+z');
		await settle(app, before);
	}
	{
		const disk = readFileSync(join(vault, NOTE), 'utf8');
		await setMode(app, 'live');
		const live = await app.eval(() => (window as unknown as W).app.workspace.getMostRecentLeaf().view.editor.getValue());
		check('Reading → Live Preview: the editor shows what Reading view wrote', live === disk, diffSummary(disk, live));
		await setMode(app, 'reading');
	}
	await app.page.screenshot({path: join(shots, 'reading-after.png')});

	// ----- safety: a box the source hides (in a %%comment%%) must not shift the mapping -----
	await app.eval(async () => {
		const a = (window as unknown as W).app;
		await a.workspace.getLeaf(false).setViewState({type: 'markdown', state: {file: 'Hidden box.md', mode: 'preview'}, active: true});
	});
	await sleep(700);
	{
		const before = readFileSync(join(vault, 'Hidden box.md'), 'utf8');
		await clickBox(app, 'x', 1, 0);
		await sleep(500);
		const after = readFileSync(join(vault, 'Hidden box.md'), 'utf8');
		check('Safety: when screen and source disagree, nothing is changed', after === before, diffSummary(before, after));
	}

	// ----- phone layout (Obsidian's mobile emulation) with real touch taps -----
	await app.eval(() => (window as unknown as W).app.emulateMobile(true));
	await sleep(3000);
	await app.waitFor('mobile layout', () => (window as unknown as W).app?.workspace?.layoutReady && document.body.classList.contains('is-mobile'), 60_000);
	await app.waitFor('plugin loaded (mobile)', () => !!(window as unknown as W).app.plugins.plugins['tickbox'], 30_000);
	const cdp = await app.page.context().newCDPSession(app.page);
	await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
	await app.eval(async () => {
		const a = (window as unknown as W).app;
		await a.workspace.getLeaf(false).setViewState({type: 'markdown', state: {file: 'Tickbox Test Tables.md', mode: 'source', source: false}, active: true});
	});
	await sleep(1200);
	await clickCase(app, 'Phone layout, Live Preview: tap a box', 'Call mum', 1, 0, cdp);
	await clickCase(app, 'Phone layout, Live Preview: tap 2nd box of a cell', 'Read', 1, 1, cdp);
	check('Phone layout: tapping a box does not open the cell editor or keyboard', await app.eval(() => !document.querySelector('.workspace-leaf.mod-active td .cm-editor')));
	await app.page.screenshot({path: join(shots, 'phone-live-preview.png')});
	await setMode(app, 'reading');
	await app.eval(() => {
		const c = (window as unknown as W).app.plugins.plugins['tickbox'].clicks;
		const log: string[] = [];
		(window as any).__tbLog = log;
		for (const m of ['hitTest', 'resolveReading', 'apply']) {
			const orig = c[m].bind(c);
			c[m] = (...args: unknown[]) => {
				const r = orig(...args);
				const e = args[0] as PointerEvent;
				const where = m === 'hitTest' ? ` at ${Math.round(e.clientX)},${Math.round(e.clientY)} on ${(e.target as Element)?.outerHTML?.slice(0, 80)} type=${e.pointerType}` : '';
				log.push(`${m}:${r === null ? 'null' : 'ok'}${where}`);
				return r;
			};
		}
	});
	await clickCase(app, 'Phone layout, Reading: tap a box', 'Kitchen', 1, 0, cdp);
	if (!results[results.length - 1]!.ok) console.log('      plugin steps:', JSON.stringify(await app.eval(() => (window as any).__tbLog)), 'leaves:', JSON.stringify(await app.eval(() => (window as unknown as W).app.workspace.getLeavesOfType('markdown').map((l: any) => l.view.getMode()))));
	await app.page.screenshot({path: join(shots, 'phone-reading.png')});
	await app.eval(() => (window as unknown as W).app.emulateMobile(false));
	await sleep(2000);

	const finalText = readFileSync(join(vault, NOTE), 'utf8');
	const strip = (s: string): string => s.replace(BOX, '#').replace(/ +\|/g, '|').replace(/\| +/g, '|');
	check('Only box characters changed in the whole note (table padding aside)', strip(finalText) === strip(original), diffSummary(strip(original), strip(finalText)));
	const ours = errors.filter((e) => /tickbox/i.test(e));
	check('No Tickbox errors in the console', ours.length === 0, ours.join(' | '));
} catch (e) {
	check('run finished without a crash', false, String((e as Error).stack ?? e));
} finally {
	check('real Obsidian config untouched', app.realConfigUnchanged());
	await app.quit();
	check('test Obsidian fully stopped', app.pids().length === 0);
	const failed = results.filter((r) => !r.ok);
	writeFileSync(join(shots, 'report.json'), JSON.stringify({when: new Date().toISOString(), results}, null, 2));
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	process.exitCode = failed.length ? 1 : 0;
}
