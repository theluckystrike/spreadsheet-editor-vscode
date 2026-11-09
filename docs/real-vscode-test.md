# Real VS Code test, 9 November 2026

The packaged extension was installed in VS Code 1.142.0 (macOS, Apple silicon) with a clean profile and driven like a user: clicks, typing, keyboard shortcuts, saves and dialogs. The results below are for the released file.

## Dark theme, 37 of 37 checks pass

vsix sha256 `bd74c1f0dd4020aff67c0ebbd5af99096ea8a9cfc7f3468452234e98b5650691`

| Check | Result |
|---|---|
| open earthquakes_week.csv | pass |
| open country-codes.csv | pass |
| open financial-sample.xlsx | pass |
| open budget-formats.xlsx | pass |
| open clients-windows-1252.csv | pass |
| open bestellungen-semicolon.csv | pass |
| open earthquakes.tsv | pass |
| open earthquakes-utf16.csv | pass |
| open sensor-with-comments.csv | pass |
| comment prefix # hides 3 comment lines, keeps them in the file | pass |
| open hostile-unterminated-quote.csv | pass |
| open hostile-mixed-eol-nul.csv | pass |
| open hostile-1mb-cell.csv | pass |
| open hostile-zip-bomb.xlsx | pass |
| type into a cell: grid shows it, tab is dirty, file not written yet | pass |
| save: one line changed (the edited field only); all other bytes identical | pass |
| undo after save brings the old value back (tab dirty); redo returns to the saved state (tab clean) | pass |
| close and reopen: the change is there | pass |
| 50 edits then 50 undos: cells back, tab clean, file byte-identical | pass |
| 50 redos then save: 50 cells written | pass |
| File: Revert File drops the edits | pass |
| file changed on disk with unsaved edits: note shows, save asks, cancel keeps the newer file | pass |
| overwrite on request writes my version | pass |
| xlsx save budget-formats.xlsx: value written, styles/merges/sheets kept (openpyxl) | pass |
| xlsx save financial-sample.xlsx: value written, styles/merges/sheets kept (openpyxl) | pass |
| Cmd+F opens find; Enter finds; regex Replace All with groups | pass |
| one undo takes Replace All back | pass |
| paste a 2x3 block at the last cell (from a spreadsheet clipboard): adds rows and columns | pass |
| 1M-row CSV: opens, edit the last row, save; every other row byte-identical; memory | pass |
| 200 MB CSV (5.6M rows): opens, edit, save; memory under 1 GB | pass |
| reload with unsaved edits (hot exit): the tab comes back dirty with the edit; file untouched | pass |
| Pro switched off: no Pro command in the palette, no license command | pass |
| Pro switched off: license commands hidden | pass |
| no network from the extension: no webview requests, no extension-host sockets | pass |
| VS Code bridge note "No custom document found" after closing tabs (counted) | pass |
| no errors from the extension in the consoles | pass |
| no extension-host errors for this extension | pass |

## Light theme, 26 of 26 checks pass

vsix sha256 `bd74c1f0dd4020aff67c0ebbd5af99096ea8a9cfc7f3468452234e98b5650691`

| Check | Result |
|---|---|
| open earthquakes_week.csv | pass |
| open country-codes.csv | pass |
| open financial-sample.xlsx | pass |
| open budget-formats.xlsx | pass |
| open clients-windows-1252.csv | pass |
| open bestellungen-semicolon.csv | pass |
| open earthquakes.tsv | pass |
| open earthquakes-utf16.csv | pass |
| open sensor-with-comments.csv | pass |
| comment prefix # hides 3 comment lines, keeps them in the file | pass |
| open hostile-unterminated-quote.csv | pass |
| open hostile-mixed-eol-nul.csv | pass |
| open hostile-1mb-cell.csv | pass |
| open hostile-zip-bomb.xlsx | pass |
| type into a cell: grid shows it, tab is dirty, file not written yet | pass |
| save: one line changed (the edited field only); all other bytes identical | pass |
| undo after save brings the old value back (tab dirty); redo returns to the saved state (tab clean) | pass |
| close and reopen: the change is there | pass |
| xlsx save budget-formats.xlsx: value written, styles/merges/sheets kept (openpyxl) | pass |
| xlsx save financial-sample.xlsx: value written, styles/merges/sheets kept (openpyxl) | pass |
| light theme earthquakes_week.csv | pass |
| light theme budget-formats.xlsx | pass |
| no network from the extension: no webview requests, no extension-host sockets | pass |
| VS Code bridge note "No custom document found" after closing tabs (counted) | pass |
| no errors from the extension in the consoles | pass |
| no extension-host errors for this extension | pass |

## Files

Real files: the USGS earthquake feed for one week (CSV), the datasets/country-codes CSV, and the Financial Sample workbook from Microsoft. Made from them or written for the test: a Windows-1252 CSV, a semicolon CSV with CRLF, a TSV, a UTF-16 LE file with a BOM, a CSV with comment lines, a workbook with styles, number formats, merged cells, formulas and a hidden sheet, a 1,000,000-row CSV (38 MB) and a 5,600,000-row CSV (219 MB).

Hostile files: an unterminated quote, mixed line endings with a NUL byte, a 1 MB cell, an .xlsx zip bomb whose directory says 4 KB for a part that unpacks to 400 MB, and a file changed on disk while it has unsaved edits.

Excel saves were checked with openpyxl, a separate reader. The JSON files next to this one have the details of each check.
