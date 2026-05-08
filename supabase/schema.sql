-- Drop existing tables if they exist
DROP TABLE IF EXISTS public.jobs CASCADE;
DROP TABLE IF EXISTS public.companies CASCADE;

-- Supabase Schema for poli-clone

-- Create Companies Table
CREATE TABLE public.companies (
    id SERIAL PRIMARY KEY,
    trading_name TEXT NOT NULL,
    companies_house_name TEXT,
    url TEXT,
    url_linkedin TEXT,
    description TEXT,
    policy TEXT,
    open_to_sponsorship INTEGER,
    active_jobs_count INTEGER,
    url_favicon TEXT,
    licensed_sponsor BOOLEAN DEFAULT true,
    estimated_num_employees_label TEXT,
    ats_provider TEXT,
    ats_board_token TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create Jobs Table
CREATE TABLE public.jobs (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES public.companies(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    location TEXT,
    department TEXT,
    description TEXT,
    salary TEXT,
    level TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX idx_jobs_company_id ON public.jobs(company_id);
CREATE INDEX idx_jobs_location ON public.jobs(location);
CREATE INDEX idx_jobs_last_seen_at ON public.jobs(last_seen_at DESC);
CREATE INDEX idx_jobs_company_last_seen ON public.jobs(company_id, last_seen_at);

-- Location filter audit table
CREATE TABLE IF NOT EXISTS public.location_filter_log (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    job_url TEXT,
    raw_location TEXT,
    source TEXT,
    decision TEXT NOT NULL,
    sync_run_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_location_filter_log_created_at ON public.location_filter_log(created_at DESC);
CREATE INDEX idx_location_filter_log_company_created ON public.location_filter_log(company_id, created_at DESC);
CREATE INDEX idx_location_filter_log_sync_run ON public.location_filter_log(sync_run_id);
CREATE INDEX idx_location_filter_log_decision ON public.location_filter_log(decision);

-- Force REST schema refresh so there are no cache issues right after recreating
NOTIFY pgrst, 'reload schema';
