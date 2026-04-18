# Getlanded Jobs Sync README

This repository contains a Next.js app and supporting scripts, but the primary operations workflow is the ATS sync pipeline.

The master sync entrypoint is:

- `src/scripts/syncAll.ts`

This README focuses on how to run, operate, and troubleshoot sync.

## 1) Sync Purpose

`syncAll.ts` reads ATS configuration from Supabase, fetches jobs from each provider, keeps UK-relevant jobs, upserts current jobs into `jobs`, removes stale jobs, and recalculates `companies.active_jobs_count`.

The behavior is snapshot-based per company (current state wins), not append-only history.

## 2) Source of Truth

Sync reads company config from:

- `companies.ats_provider`
- `companies.ats_board_token`

Optional overrides are merged from `ats_import_audit` before fetch:

- `sync_provider`
- `board_token_raw`
- `careers_url_raw`

Because sync loads companies dynamically from DB, adding/updating rows in Supabase usually updates what sync processes without code changes.

## 3) Required Environment Variables

Create `.env.local` with:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Optional (enables search fallback for missing/invalid ATS config):

```bash
SERPER_API_KEY=...
```

Notes:

- `SUPABASE_SERVICE_ROLE_KEY` is recommended for full write access.
- If service role key is not set, script can fall back to `NEXT_PUBLIC_SUPABASE_ANON_KEY` (limited permissions).

## 4) Install and Run

Install dependencies:

```bash
npm install
```

Run full sync:

```bash
npm run sync
```

Equivalent direct command:

```bash
npx tsx src/scripts/syncAll.ts
```

Run selected companies only:

```bash
npx tsx src/scripts/syncAll.ts --ids 12,45,90
```

## 5) High-Level Pipeline

For each company:

1. Resolve provider/token (including import overrides).
2. Call provider fetcher from `FETCHERS` map.
3. If fetch fails/empty, try ATS inference from `careers_url_raw`.
4. If still empty and `SERPER_API_KEY` exists, discover likely careers URLs and retry.
5. If no ATS mapping works, try generic careers page extraction.
6. Apply UK relevance filter.
7. Deduplicate by URL.
8. Upsert jobs to `jobs` with conflict key `url`.
9. Delete stale rows for the same company that are not in latest URL set.
10. Recompute and write `companies.active_jobs_count`.

## 6) Supported Providers

Current dispatch supports:

- greenhouse
- ashby
- lever
- workable
- teamtailor
- bamboohr
- smartrecruiters
- pinpoint
- breezy / breezyhr
- recruitee
- personio
- workday / workday_enterprise
- oracle_cloud
- successfactors
- eightfold
- hibob
- wipro
- icims
- rippling
- amazon
- goldmansachs
- google
- jpmc

If a provider key is unsupported, that company is skipped and reported.

## 7) UK Filtering Rules

Jobs are retained based on UK signals from location/title/url and blocked on explicit non-UK indicators.

Important implications:

- Bad or missing location fields can reduce retained jobs.
- URL country hints can influence keep/drop behavior.
- A provider can return jobs successfully but still save `0` after UK filtering.

## 8) Database Impact

Tables touched during sync:

- `companies` (read provider config; write `active_jobs_count`)
- `ats_import_audit` (read optional override data)
- `jobs` (upsert latest jobs; delete stale jobs)

`jobs.url` uniqueness is required for conflict-safe upserts.

## 9) Typical Operations Flow

1. Validate environment variables in `.env.local`.
2. (Optional) import ATS config CSV into `ats_import_audit`.
3. Run targeted sync first using `--ids` for validation.
4. Run full sync.
5. Verify counts and sample companies in Supabase.

Useful import commands:

```bash
npm run import:ats:csv -- --file "ATS compnies - industry_grade_ats_database_fixed.csv" --dry-run
npm run import:ats:csv -- --file "ATS compnies - industry_grade_ats_database_fixed.csv"
```

## 10) Troubleshooting

If saved jobs are `0` for a company:

1. Check if fetcher returned jobs before UK filter.
2. Confirm provider key is supported.
3. Verify token format for that ATS.
4. Confirm provider endpoint structure has not changed.
5. Run company-specific sync with `--ids` and inspect logs.

If jobs disappear unexpectedly:

1. Confirm fetcher did not return empty due to API failure.
2. Confirm stale cleanup removed only truly missing URLs.
3. Check if provider changed URL formats between runs.

## 11) Add a New Provider

1. Add `fetchMyProvider(token)` to `src/scripts/syncAll.ts`.
2. Normalize output to `{ title, location, url, department? }`.
3. Register provider in `FETCHERS` map.
4. Set `companies.ats_provider` and `companies.ats_board_token`.
5. Test with `--ids`.

## 12) Related Docs and Files

- `docs/SYNC_ALL_GUIDE.md` (deep technical guide)
- `src/scripts/syncAll.ts` (main pipeline)
- `src/lib/inferJobLevel.ts` (job level inference)
- `supabase/schema.sql` (table definitions)
- `package.json` (`sync` and import scripts)

## 13) Notes on Repository Scope

Sync operation is TypeScript/Supabase based around `src/scripts/syncAll.ts` and related DB/schema/docs assets.

Python scraping under `backend_scrape/` is not required for the sync function and is intentionally excluded from sync-focused git scope.
