-- ================================================================
-- IMPORT ATS COMPANY DATA INTO companies TABLE
-- ================================================================
-- Your CSV columns:
--   Company ID, Company Name, ATS Provider, ATS Board Token, URL, Verification, Status
--
-- The syncAll.ts scraper reads from: public.companies
-- Columns it uses: id, trading_name, ats_provider, ats_board_token, careers_url, url
--
-- HOW TO USE THIS SCRIPT:
-- 1. Open Supabase SQL Editor
-- 2. Paste this entire file and run it
-- 3. It will upsert rows into companies so existing data is preserved
-- ================================================================

-- STEP 1: Create a temporary staging table that matches your CSV structure
CREATE TEMP TABLE ats_csv_import (
    company_id    INTEGER,
    company_name  TEXT,
    ats_provider  TEXT,
    ats_token     TEXT,
    careers_url   TEXT,
    verification  TEXT,
    status        TEXT
);

-- STEP 2: Paste your CSV data as INSERT rows below.
-- Format: (company_id, 'Company Name', 'ats_provider', 'board_token', 'https://careers-url', 'verified', 'Good')
-- Example rows from your CSV:

INSERT INTO ats_csv_import (company_id, company_name, ats_provider, ats_token, careers_url, verification, status) VALUES
(1,   'incident.io',     'ashby',      'incident',        'https://jobs.ashbyhq.com/incident/',        'verified', 'Good'),
(660, 'Thought Machine', 'ashby',      'thought-machine', 'https://jobs.ashbyhq.com/thought-machine',  'verified', 'Good'),
(671, 'Terra',           'ashby',      'terraai',         'https://jobs.ashbyhq.com/terraai',          'verified', 'Good'),
(672, 'Vertice',         'ashby',      'vertice',         'https://jobs.ashbyhq.com/vertice/',         'verified', 'Good'),
(685, 'Ravio',           'ashby',      'ravio',           'https://jobs.ashbyhq.com/Ravio/',           'verified', 'Good'),
(723, 'Signal AI',       'ashby',      'signal-ai',       'https://jobs.ashbyhq.com/signal-ai',        'verified', 'Good'),
(731, 'Lendable',        'ashby',      'lendable',        'https://jobs.ashbyhq.com/lendable/',        'verified', 'Good'),
(749, 'Chattermill',     'ashby',      'chattermill',     'https://jobs.ashbyhq.com/chattermill/',     'verified', 'Good'),
(792, 'Attio',           'ashby',      'attio',           'https://jobs.ashbyhq.com/attio/',           'verified', 'Good'),
(947, 'Zoe',             'ashby',      'zoe',             'https://jobs.ashbyhq.com/zoe/',             'verified', 'Good'),
(957, 'Synthesia',       'ashby',      'synthesia',       'https://jobs.ashbyhq.com/synthesia/',       'verified', 'Good'),
(969, 'Elliptic',        'ashby',      'elliptic',        'https://jobs.ashbyhq.com/elliptic/',        'verified', 'Good');
-- ↑ ADD ALL YOUR REMAINING CSV ROWS ABOVE THIS LINE

-- STEP 3: Upsert into companies table
-- This will:
--   - INSERT new companies that don't exist yet (by id)
--   - UPDATE ats_provider, ats_board_token, careers_url for existing companies
--   - Leave all other columns (trading_name, description, favicon etc.) untouched

INSERT INTO public.companies (id, trading_name, ats_provider, ats_board_token, careers_url)
SELECT
    company_id,
    company_name,
    LOWER(ats_provider),   -- normalize to lowercase e.g. 'Ashby' -> 'ashby'
    ats_token,
    careers_url
FROM ats_csv_import
WHERE status = 'Good'      -- only import verified/good rows
ON CONFLICT (id) DO UPDATE SET
    ats_provider    = LOWER(EXCLUDED.ats_provider),
    ats_board_token = EXCLUDED.ats_board_token,
    careers_url     = EXCLUDED.careers_url,
    updated_at      = NOW();

-- STEP 4: Verify what was imported
SELECT id, trading_name, ats_provider, ats_board_token, careers_url
FROM public.companies
WHERE id IN (SELECT company_id FROM ats_csv_import)
ORDER BY id;

-- STEP 5: Clean up temp table (auto-dropped when session ends, but explicit is cleaner)
DROP TABLE IF EXISTS ats_csv_import;

-- STEP 6: Reset the serial sequence so new auto-inserted companies
-- don't clash with your manually-set IDs
SELECT setval(
    pg_get_serial_sequence('public.companies', 'id'),
    COALESCE((SELECT MAX(id) FROM public.companies), 1)
);

NOTIFY pgrst, 'reload schema';
