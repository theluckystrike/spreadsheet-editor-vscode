# Changelog

## 0.1.0 (2026-11-09)

First release.

- Edit CSV, TSV and Excel (.xlsx) files as a spreadsheet: cells, rows, columns, moves, paste from Excel or Google Sheets, fill down, clear.
- VS Code's own undo, redo, save, save as, revert and hot exit. The tab shows unsaved changes. A file changed on disk while you edit is never overwritten without asking.
- CSV saves copy every untouched row byte for byte and keep the delimiter, quoting, encoding, BOM and line endings.
- 1,000,000-row CSV files open in about 2 seconds; files up to 512 MB open for editing, up to 1 GB read-only.
- Excel saves keep styles, number formats, merged cells, column widths, formulas, hidden and other sheets. A note before the first save lists the parts that cannot be kept. Macro workbooks are saved as a .xlsx copy only.
- Find and replace with match case, regex and whole cell. Filter by text or SQL condition, sort the view, column stats.
- Any one-character delimiter, quote character, 13 encodings, comment lines.
- Free, no sign-in, works offline. No telemetry.
