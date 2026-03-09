-- Enable RLS for reported_jobs
ALTER TABLE public.reported_jobs ENABLE ROW LEVEL SECURITY;

-- 1. Allow anyone to INSERT (to report a job)
CREATE POLICY "Allow public insert to reported_jobs" 
ON public.reported_jobs FOR INSERT 
WITH CHECK (true);

-- 2. Allow only service role (admin) to SELECT/DELETE
-- Note: Our admin server actions use the service_role key, so this is sufficient.
CREATE POLICY "Allow service role full access to reported_jobs" 
ON public.reported_jobs FOR ALL 
USING (auth.role() = 'service_role');

-- Ensure REST API can see it
NOTIFY pgrst, 'reload schema';
