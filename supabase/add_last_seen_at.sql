-- Add last_seen_at column to jobs table for stale job resilience
-- This prevents jobs from being deleted due to transient ATS downtime

ALTER TABLE public.jobs
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Index for efficient stale job cleanup queries
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen_at ON public.jobs(last_seen_at DESC);

-- Index for finding stale jobs (not seen in 48+ hours)
CREATE INDEX IF NOT EXISTS idx_jobs_company_last_seen ON public.jobs(company_id, last_seen_at);

-- Update existing jobs to have last_seen_at = updated_at (backfill)
UPDATE public.jobs
SET last_seen_at = COALESCE(updated_at, created_at, NOW())
WHERE last_seen_at IS NULL;

-- Cleanup procedure: Delete jobs not seen in 48+ hours
-- Run this as a separate cron job or after each sync
-- DELETE FROM public.jobs WHERE last_seen_at < NOW() - INTERVAL '48 hours';
