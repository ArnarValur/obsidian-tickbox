// Copies the release files into a vault's plugin folder. Default vault: ~/Documents. Usage: npm run install-vault [-- <vault>]
import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const vault = process.argv[2] ?? join(homedir(), 'Documents');
if (!existsSync(join(vault, '.obsidian'))) throw new Error(`${vault} is not an Obsidian vault (no .obsidian folder)`);
const dir = join(vault, '.obsidian', 'plugins', 'tickbox');
mkdirSync(dir, {recursive: true});
for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(f, join(dir, f));
console.log(`Installed into ${dir}. Enable "Tickbox" in Settings → Community plugins (reload once for the hotkey).`);
