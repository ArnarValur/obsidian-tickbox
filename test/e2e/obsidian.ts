// A real Obsidian (Flatpak md.obsidian.Obsidian) started headless with its own profile and driven over CDP.
//
// Isolation from your own running Obsidian:
//  - own --user-data-dir whose obsidian.json lists only the test vault, "cli": false, updates disabled;
//  - own XDG_CONFIG_HOME and XDG_RUNTIME_DIR, so the real instance keeps its CLI socket and launcher files;
//  - --password-store=basic (no keyring), headless ozone with the X11/Wayland sockets withheld (no window appears);
//  - only this instance's processes are ever signalled (descendants of our `flatpak run`, or carrying our user-data dir);
//  - the real obsidian.json is compared byte for byte before and after.
// Everything lives below ~/tickbox-test/ (TEST_ROOT); assertTestPath refuses anything else.
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {createWriteStream, mkdirSync, readFileSync, readdirSync, realpathSync, existsSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {chromium, type Browser, type Page} from 'playwright-core';

export const FLATPAK_ID = 'md.obsidian.Obsidian';
export const TEST_ROOT = join(homedir(), 'tickbox-test');
export const REAL_OBSIDIAN_JSON = join(homedir(), '.var', 'app', FLATPAK_ID, 'config', 'obsidian', 'obsidian.json');

/** Refuses any path outside TEST_ROOT (and so any real vault). */
export function assertTestPath(p: string): string {
	const abs = resolve(p);
	if (abs !== TEST_ROOT && !abs.startsWith(TEST_ROOT + sep)) throw new Error(`refusing a path outside ${TEST_ROOT}: ${abs}`);
	if (existsSync(abs) && realpathSync(abs) !== abs) throw new Error(`refusing a symlinked path: ${abs}`);
	return abs;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.once('error', rej);
		srv.listen(0, '127.0.0.1', () => {
			const a = srv.address();
			const port = typeof a === 'object' && a ? a.port : 0;
			srv.close(() => res(port));
		});
	});
}

interface Proc { pid: number; ppid: number; args: string[] }

function cmdlineOf(pid: number): string[] {
	try {
		const parts = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s !== '');
		return parts.length === 1 && parts[0]?.includes(' ') ? parts[0].split(' ').filter((s) => s !== '') : parts;
	} catch {
		return [];
	}
}

function processes(): Proc[] {
	const out: Proc[] = [];
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
			const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
			out.push({pid: Number(name), ppid, args: cmdlineOf(Number(name))});
		} catch {
			// gone
		}
	}
	return out;
}

/** PIDs of this instance only: descendants of our `flatpak run` plus processes carrying our --user-data-dir. */
function instancePids(rootPid: number | undefined, userData: string): number[] {
	const all = processes();
	const mine = new Set<number>();
	const ud = `--user-data-dir=${userData}`;
	for (const p of all) if (p.args.includes(ud)) mine.add(p.pid);
	if (rootPid !== undefined && all.some((p) => p.pid === rootPid)) {
		mine.add(rootPid);
		let grew = true;
		while (grew) {
			grew = false;
			for (const p of all) if (!mine.has(p.pid) && mine.has(p.ppid)) { mine.add(p.pid); grew = true; }
		}
	}
	mine.delete(process.pid);
	return [...mine];
}

async function killInstance(rootPid: number | undefined, userData: string): Promise<void> {
	for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
		const pids = instancePids(rootPid, userData);
		if (pids.length === 0) return;
		for (const pid of pids) {
			try { process.kill(pid, sig); } catch { /* gone */ }
		}
		const end = Date.now() + 5000;
		while (Date.now() < end && instancePids(rootPid, userData).length > 0) await sleep(200);
	}
}

export interface LaunchOptions {
	vault: string;
	userData: string;
	logDir: string;
	viewport?: {width: number; height: number};
}

export class ObsidianApp {
	private constructor(
		readonly vault: string,
		readonly userData: string,
		private readonly child: ChildProcess,
		readonly browser: Browser,
		readonly page: Page,
		private readonly realConfigBefore: Buffer,
	) {}

	static async launch(opts: LaunchOptions): Promise<ObsidianApp> {
		const vault = assertTestPath(opts.vault);
		const userData = assertTestPath(opts.userData);
		const logDir = assertTestPath(opts.logDir);
		const realConfigBefore = readFileSync(REAL_OBSIDIAN_JSON);
		mkdirSync(join(vault, '.obsidian'), {recursive: true});
		mkdirSync(userData, {recursive: true, mode: 0o700});
		mkdirSync(logDir, {recursive: true});
		const xdg = join(userData, 'xdg-config');
		mkdirSync(xdg, {recursive: true});
		// Short path: Chromium's SingletonSocket must fit in sun_path (107 bytes).
		const xdgRun = join(TEST_ROOT, 'rt', createHash('sha256').update(userData).digest('hex').slice(0, 8));
		mkdirSync(join(xdgRun, 'app', FLATPAK_ID), {recursive: true, mode: 0o700});
		writeFileSync(join(userData, 'obsidian.json'), JSON.stringify({
			vaults: {[randomBytes(8).toString('hex')]: {path: vault, ts: Date.now(), open: true}},
			cli: false,
			updateDisabled: true,
		}));
		const viewport = opts.viewport ?? {width: 1280, height: 860};
		const port = await freePort();
		const args = [
			'run',
			'--nosocket=wayland', '--nosocket=x11', '--nosocket=fallback-x11',
			'--env=OBSIDIAN_CLEAN_CACHE=0',
			'--env=OBSIDIAN_DISABLE_GPU=1',
			`--env=XDG_CONFIG_HOME=${xdg}`,
			`--env=XDG_RUNTIME_DIR=${xdgRun}`,
			FLATPAK_ID,
			`--user-data-dir=${userData}`,
			`--remote-debugging-port=${port}`,
			'--remote-allow-origins=*',
			'--password-store=basic',
			'--ozone-platform=headless',
			`--window-size=${viewport.width},${viewport.height}`,
		];
		const log = createWriteStream(join(logDir, 'obsidian.log'), {flags: 'a'});
		const child = spawn('flatpak', args, {stdio: ['ignore', 'pipe', 'pipe']});
		child.stdout?.pipe(log);
		child.stderr?.pipe(log);
		let exited = false;
		child.once('exit', () => (exited = true));
		try {
			const end = Date.now() + 90_000;
			for (;;) {
				if (exited) throw new Error(`Obsidian exited during launch; see ${logDir}/obsidian.log`);
				try {
					const r = await fetch(`http://127.0.0.1:${port}/json/version`);
					if (r.ok) break;
				} catch { /* not up yet */ }
				if (Date.now() > end) throw new Error('Obsidian did not open its debugging port');
				await sleep(300);
			}
			const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
			let page: Page | undefined;
			while (!page) {
				page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://obsidian.md'));
				if (!page) {
					if (Date.now() > end) throw new Error('no Obsidian window over CDP');
					await sleep(300);
				}
			}
			await page.setViewportSize(viewport).catch(() => undefined);
			// tsx (esbuild keepNames) wraps named functions in __name(); page-side code needs that helper too.
			await page.addInitScript('globalThis.__name = (f) => f;').catch(() => undefined);
			await page.evaluate('globalThis.__name = (f) => f;');
			const app = new ObsidianApp(vault, userData, child, browser, page, realConfigBefore);
			await app.waitFor('workspace layout', () => (window as unknown as {app?: {workspace?: {layoutReady?: boolean}}}).app?.workspace?.layoutReady === true, end - Date.now());
			const base = await app.eval(() => (window as unknown as {app: {vault: {adapter: {getBasePath(): string}}}}).app.vault.adapter.getBasePath());
			if (realpathSync(base) !== vault) {
				await app.kill();
				throw new Error(`isolation: test Obsidian opened ${base}, not ${vault}`);
			}
			return app;
		} catch (e) {
			await killInstance(child.pid, userData);
			throw e;
		}
	}

	eval<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
		return this.page.evaluate<R, A>(fn as never, arg as A);
	}

	async waitFor<R>(what: string, fn: () => R | Promise<R>, timeoutMs = 20_000): Promise<R> {
		const end = Date.now() + timeoutMs;
		let last: unknown;
		for (;;) {
			try {
				const v = await this.page.evaluate(fn);
				if (v) return v;
				last = v;
			} catch (e) {
				last = e;
			}
			if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${String(last)})`);
			await sleep(150);
		}
	}

	/**
	 * Turns restricted mode off and enables a plugin the way the Community plugins tab does, then answers Obsidian's
	 * first-open "Do you trust the author of this vault?" dialog (it would cover the window and eat every click).
	 */
	async enablePlugin(id: string): Promise<void> {
		await this.eval(async (pid: string) => {
			const a = (window as unknown as {app: any}).app;
			await a.plugins.loadManifests();
			if (!a.plugins.isEnabled()) await a.plugins.setEnable(true);
			if (!(await a.plugins.enablePluginAndSave(pid))) throw new Error(`enablePluginAndSave(${pid}) failed`);
		}, id);
		await sleep(800);
		await this.eval(() => {
			for (const b of Array.from(document.querySelectorAll('.modal-container button'))) {
				if (/trust author/i.test(b.textContent ?? '')) (b as HTMLElement).click();
			}
		});
		await this.waitFor('no dialog open', () => document.querySelectorAll('.modal-container').length === 0, 10_000);
		// Obsidian writes community-plugins.json a moment later; a reload before that would start without the plugin.
		const list = join(this.vault, '.obsidian', 'community-plugins.json');
		const end = Date.now() + 10_000;
		while (!(existsSync(list) && readFileSync(list, 'utf8').includes(`"${id}"`))) {
			if (Date.now() > end) throw new Error(`${id} never reached community-plugins.json`);
			await sleep(200);
		}
	}

	/** Reloads the app window (a normal start: plugins load, default hotkeys become active) and waits for it. */
	async reload(pluginId: string): Promise<void> {
		await this.page.evaluate(() => location.reload()).catch(() => undefined);
		await sleep(1500);
		await this.page.evaluate('globalThis.__name = (f) => f;');
		const ready = `(() => { const a = window.app; return !!(a && a.workspace && a.workspace.layoutReady && a.plugins.plugins[${JSON.stringify(pluginId)}]); })()`;
		const end = Date.now() + 60_000;
		while (!(await this.page.evaluate(ready).catch(() => false))) {
			if (Date.now() > end) {
				const why = await this.page.evaluate(`JSON.stringify({ready: !!(window.app && window.app.workspace && window.app.workspace.layoutReady), plugins: window.app ? Object.keys(window.app.plugins.plugins) : null, enabled: window.app ? window.app.plugins.isEnabled() : null, modal: Array.from(document.querySelectorAll('.modal-container')).map((m) => m.innerText.slice(0, 80))})`).catch((e: unknown) => String(e));
				throw new Error(`app did not come back after reload: ${String(why)}`);
			}
			await sleep(200);
		}
		await this.page.evaluate('globalThis.__name = (f) => f;');
	}

	/** True when the real instance's obsidian.json is byte-identical to before launch. */
	realConfigUnchanged(): boolean {
		return readFileSync(REAL_OBSIDIAN_JSON).equals(this.realConfigBefore);
	}

	async quit(): Promise<void> {
		await this.page.evaluate(() => { setTimeout(() => window.close(), 50); }).catch(() => undefined);
		const end = Date.now() + 15_000;
		while (Date.now() < end && instancePids(this.child.pid, this.userData).length > 0) await sleep(250);
		await this.kill();
	}

	async kill(): Promise<void> {
		await this.browser.close().catch(() => undefined);
		await killInstance(this.child.pid, this.userData);
	}

	pids(): number[] {
		return instancePids(this.child.pid, this.userData);
	}
}
