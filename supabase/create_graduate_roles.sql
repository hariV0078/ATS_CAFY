-- Create a dedicated table for graduate roles fetched from external sources like Reed
CREATE TABLE IF NOT EXISTS public.graduate_roles (
    id TEXT PRIMARY KEY,
    company_id INTEGER DEFAULT 0, -- 0 for unknown/external companies
    trading_name TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    url TEXT NOT NULL,
    department TEXT,
    level TEXT DEFAULT 'Graduate',
    salary TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    sync_run_id TEXT
);

-- RLS Policies
ALTER TABLE public.graduate_roles ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read graduate roles
CREATE POLICY "Allow public read access to graduate_roles" ON public.graduate_roles
    FOR SELECT USING (true);

-- Allow service role to insert/update/delete graduate roles
CREATE POLICY "Allow service role all access to graduate_roles" ON public.graduate_roles
    FOR ALL USING (auth.role() = 'service_role');
