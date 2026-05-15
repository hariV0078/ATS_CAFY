-- DIAGNOSTIC SQL QUERIES FOR ATS SYNC ISSUES
-- Run these in Supabase SQL editor to quantify impact of each problem
-- ══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- ISSUE 1: TURNER & TOWNSEND CLEANUP ERROR
-- ─────────────────────────────────────────────────────────────────────────────
-- Problem: 2644 jobs fetched but cleanup error may have deleted them after saving
-- Run this to see if T&T jobs survived in the DB

SELECT 
    c.id,
    c.trading_name,
    COUNT(j.id) as jobs_in_db,
    MAX(j.created_at) as most_recent_job
FROM companies c
LEFT JOIN jobs j ON j.company_id = c.id
WHERE c.trading_name ILIKE '%turner%townsend%'
   OR c.trading_name ILIKE '%turner and townsend%'
GROUP BY c.id, c.trading_name
ORDER BY jobs_in_db DESC;

-- If jobs_in_db is 0 or very small compared to 2644 fetched, cleanup ate them
-- Expected: Should be close to 2644 if cleanup chunking worked


-- ─────────────────────────────────────────────────────────────────────────────
-- ISSUE 2: VISA ZERO UK JOBS
-- ─────────────────────────────────────────────────────────────────────────────
-- Problem: Fetched 956 jobs but 0 passed UK location filter
-- Check what location formats Visa actually uses

SELECT 
    DISTINCT location,
    COUNT(*) as job_count
FROM jobs j
JOIN companies c ON c.id = j.company_id
WHERE c.trading_name ILIKE '%visa%'
GROUP BY location
ORDER BY job_count DESC
LIMIT 50;

-- Look at the location strings — if they show "London", "England", "United Kingdom", 
-- etc that don't match our filter, we found the problem.

-- Also check if Visa has ANY jobs at all:
SELECT 
    c.id,
    c.trading_name,
    c.ats_provider,
    COUNT(j.id) as jobs_in_db
FROM companies c
LEFT JOIN jobs j ON j.company_id = c.id
WHERE c.trading_name ILIKE '%visa%'
GROUP BY c.id, c.trading_name, c.ats_provider;

-- If jobs_in_db is 0, they were filtered out. If > 0, they survived.


-- ─────────────────────────────────────────────────────────────────────────────
-- ISSUE 3: NULL PROVIDER COMPANIES
-- ─────────────────────────────────────────────────────────────────────────────
-- Problem: ~1000+ companies have no ATS provider configured and are silently skipped
-- This is where most missing 9k jobs are hiding

-- Count of null-provider companies
SELECT COUNT(*) as companies_without_ats_provider
FROM companies 
WHERE ats_provider IS NULL 
  AND ats_board_token IS NULL;

-- Sample of null-provider companies with careers URLs (these should be configured)
SELECT 
    id,
    trading_name,
    careers_url,
    ats_provider,
    ats_board_token
FROM companies 
WHERE ats_provider IS NULL 
  AND careers_url IS NOT NULL
ORDER BY trading_name
LIMIT 50;

-- Estimate: how many of these have careers URLs (clue they might be ATS-capable)?
SELECT 
    CASE 
        WHEN careers_url IS NOT NULL THEN 'Has careers_url'
        ELSE 'No careers_url'
    END as config_status,
    COUNT(*) as company_count
FROM companies 
WHERE ats_provider IS NULL
GROUP BY config_status;

-- Check what happens when we try to identify the ATS from their careers URL
-- Common patterns: greenhouse, workable, lever, ashby, etc in the URL
SELECT 
    id,
    trading_name,
    careers_url,
    CASE 
        WHEN careers_url ILIKE '%greenhouse%' THEN 'greenhouse'
        WHEN careers_url ILIKE '%workable%' THEN 'workable'
        WHEN careers_url ILIKE '%lever%' THEN 'lever'
        WHEN careers_url ILIKE '%ashby%' THEN 'ashby'
        WHEN careers_url ILIKE '%teamtailor%' THEN 'teamtailor'
        WHEN careers_url ILIKE '%bamboohr%' THEN 'bamboohr'
        WHEN careers_url ILIKE '%breezy%' THEN 'breezy'
        WHEN careers_url ILIKE '%smartrecruiters%' THEN 'smartrecruiters'
        WHEN careers_url ILIKE '%icims%' THEN 'icims'
        WHEN careers_url ILIKE '%workday%' THEN 'workday'
        WHEN careers_url ILIKE '%personio%' THEN 'personio'
        WHEN careers_url ILIKE '%pinpoint%' THEN 'pinpoint'
        WHEN careers_url ILIKE '%jobvite%' THEN 'jobvite'
        WHEN careers_url ILIKE '%avature%' THEN 'avature'
        ELSE 'UNKNOWN'
    END as likely_ats
FROM companies 
WHERE ats_provider IS NULL 
  AND careers_url IS NOT NULL
ORDER BY likely_ats, trading_name
LIMIT 100;


-- ─────────────────────────────────────────────────────────────────────────────
-- SUMMARY: JOBS LOST TO EACH ISSUE
-- ─────────────────────────────────────────────────────────────────────────────

-- Total jobs currently in DB by provider (baseline)
SELECT 
    c.ats_provider,
    COUNT(DISTINCT c.id) as company_count,
    COUNT(DISTINCT j.id) as total_jobs,
    COUNT(DISTINCT CASE WHEN j.id IS NULL THEN c.id END) as companies_with_zero_jobs
FROM companies c
LEFT JOIN jobs j ON j.company_id = c.id
WHERE c.ats_provider IS NOT NULL
GROUP BY c.ats_provider
ORDER BY total_jobs DESC;

-- Null provider companies (complete loss, not synced at all)
SELECT 
    COUNT(DISTINCT c.id) as null_provider_companies,
    COUNT(DISTINCT CASE WHEN c.careers_url IS NOT NULL THEN c.id END) as with_careers_url
FROM companies c
WHERE c.ats_provider IS NULL;
