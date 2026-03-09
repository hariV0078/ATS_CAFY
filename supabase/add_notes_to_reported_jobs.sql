-- Add notes column to reported_jobs table
ALTER TABLE public.reported_jobs ADD COLUMN notes TEXT;

-- Update comment for clarity
COMMENT ON COLUMN public.reported_jobs.notes IS 'User provided reason for reporting the job (e.g. expired, incorrect details)';
