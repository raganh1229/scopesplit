# Backup: Pre-Zone Refactor (2026-04-19)

## What Changed
Refactored zone detection from regex-heavy (regex assigns zones definitively) to AI-primary (regex flags candidates, Claude validates and assigns).

## Files Backed Up
- `comparison-processing.ts` — main pipeline, Claude prompt, response parsing
- `deterministic-prematch.ts` — zone detection regex, prematch logic
- `zone-reconciliation.ts` — separate Claude call for zone name matching (being merged into main call)
- `comparison-line-filter.ts` — pre-filter for extracted lines

## How to Restore
Copy any file back to `lib/` to revert that module:
```
Copy-Item "backups\2026-04-19-pre-zone-refactor\comparison-processing.ts" "lib\comparison-processing.ts"
```
