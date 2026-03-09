-- Data Privacy Hardening
-- Disable public READ access for 'anon' role on core data tables

-- 1. Tighten 'companies' access
DROP POLICY IF EXISTS "Allow public read access to companies" ON public.companies;
CREATE POLICY "Deny public select to companies" ON public.companies FOR SELECT TO anon USING (false);

-- 2. Tighten 'jobs' access
DROP POLICY IF EXISTS "Allow public read access to jobs" ON public.jobs;
CREATE POLICY "Deny public select to jobs" ON public.jobs FOR SELECT TO anon USING (false);

-- 3. (Double check) Ensure service role still has access
-- This should already be correct from enable_rls.sql, but here it is for certainty:
DROP POLICY IF EXISTS "Allow service role full access to companies" ON public.companies;
CREATE POLICY "Allow service role full access to companies" ON public.companies FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Allow service role full access to jobs" ON public.jobs;
CREATE POLICY "Allow service role full access to jobs" ON public.jobs FOR ALL TO service_role USING (true);

-- Refresh
NOTIFY pgrst, 'reload schema';
