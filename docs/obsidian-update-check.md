# After an Obsidian update: quick check

Tickbox relies on how Obsidian draws tables (see *Findings* in [ARCHITECTURE.md](ARCHITECTURE.md)). An Obsidian
update can change that. About 5 minutes after each update:

## 1. Automatic (laptop, 2 min)

1. Update the test Obsidian too: `flatpak update md.obsidian.Obsidian`.
2. `npm run e2e`. The first line shows the Obsidian version. Every line must say `PASS`.
3. Optional, to see it: `npx tsx test/e2e/visual.ts`, then open `.local/e2e/visual/contact-sheet.png`.
   In every pair, the ringed box must be flipped in the *after* picture, and nothing else.

## 2. By hand (laptop and phone, 3 min)

In a note with a table:

- [ ] Live Preview: click a ☐. It becomes ☑. The cell does not open for editing.
- [ ] Reading view: click a ☑. It becomes ☐.
- [ ] Ctrl+Z (Cmd+Z) undoes the last flip, in both views.
- [ ] Type `[]` in a cell. It becomes ☐.
- [ ] Put the cursor in a cell and press the hotkey. The nearest box flips.
- [ ] Phone: tap a box in Live Preview and in Reading view. It flips. The cell does not open for editing.

## If something fails

- A click opens the cell instead of flipping the box: Obsidian probably renamed the table's CSS classes
  (`cm-table-widget`, `table-cell-wrapper`). Compare with *Findings* in ARCHITECTURE.md.
- Nothing happens in Reading view: check that `getSectionInfo` still returns the table's lines.
- Fix, add a test case to `test/e2e/run.ts`, bump the version (`npm version patch`), push the tag.
