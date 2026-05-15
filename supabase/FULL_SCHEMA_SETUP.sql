-- =============================================================================
-- ATS CAFY — COMPLETE SUPABASE SCHEMA SETUP
-- Run this ONCE in the Supabase SQL Editor (new project, clean slate).
-- All tables, indexes, RLS policies, and types are created in the correct order.
-- Supports full CRUD for companies, jobs, users, subscriptions, and audit data.
-- =============================================================================

-- =============================================================================
-- STEP 1: CLEAN SLATE — Drop existing objects (safe on first run)
-- =============================================================================
DROP TABLE IF EXISTS public.ats_import_audit        CASCADE;
DROP TABLE IF EXISTS public.graduate_roles          CASCADE;
DROP TABLE IF EXISTS public.reported_jobs           CASCADE;
DROP TABLE IF EXISTS public.user_applied_jobs       CASCADE;
DROP TABLE IF EXISTS public.user_favorite_companies CASCADE;
DROP TABLE IF EXISTS public.user_preferences        CASCADE;
DROP TABLE IF EXISTS public.subscriptions           CASCADE;
DROP TABLE IF EXISTS public.customers               CASCADE;
DROP TABLE IF EXISTS public.jobs                    CASCADE;
DROP TABLE IF EXISTS public.companies               CASCADE;

DROP TYPE IF EXISTS public.subscription_status;

-- =============================================================================
-- STEP 2: CUSTOM TYPES
-- =============================================================================
CREATE TYPE public.subscription_status AS ENUM (
  'active',
  'canceled',
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'trialing'
);

-- =============================================================================
-- STEP 3: CORE TABLES — companies & jobs
-- =============================================================================

CREATE TABLE public.companies (
    id                             SERIAL PRIMARY KEY,
    trading_name                   TEXT NOT NULL,
    companies_house_name           TEXT,
    url                            TEXT,
    url_linkedin                   TEXT,
    description                    TEXT,
    policy                         TEXT,
    open_to_sponsorship            INTEGER,
    active_jobs_count              INTEGER,
    url_favicon                    TEXT,
    licensed_sponsor               BOOLEAN DEFAULT true,
    estimated_num_employees_label  TEXT,
    ats_provider                   TEXT,
    ats_board_token                TEXT,
    careers_url                    TEXT,
    linkedin_id                    TEXT,
    -- ATS health tracking
    ats_status                     TEXT,
    ats_last_validated             TIMESTAMPTZ,
    ats_failure_count              INTEGER NOT NULL DEFAULT 0,
    created_at                     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at                     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE public.jobs (
    id          SERIAL PRIMARY KEY,
    company_id  INTEGER REFERENCES public.companies(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    url         TEXT UNIQUE NOT NULL,
    location    TEXT,
    department  TEXT,
    description TEXT,
    salary      TEXT,
    level       TEXT DEFAULT NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- STEP 4: USER-LINKED TABLES
-- =============================================================================

-- Stripe customer mapping
CREATE TABLE public.customers (
    id                 UUID REFERENCES auth.users(id) PRIMARY KEY,
    stripe_customer_id TEXT UNIQUE
);

-- Subscriptions (Stripe-linked)
CREATE TABLE public.subscriptions (
    id                    TEXT PRIMARY KEY,           -- Stripe subscription ID
    user_id               UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
    status                public.subscription_status NOT NULL,
    price_id              TEXT,
    quantity              INTEGER,
    cancel_at_period_end  BOOLEAN,
    cancel_at             TIMESTAMP WITH TIME ZONE,
    canceled_at           TIMESTAMP WITH TIME ZONE,
    current_period_start  TIMESTAMP WITH TIME ZONE NOT NULL,
    current_period_end    TIMESTAMP WITH TIME ZONE NOT NULL,
    created               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
    ended_at              TIMESTAMP WITH TIME ZONE,
    trial_start           TIMESTAMP WITH TIME ZONE,
    trial_end             TIMESTAMP WITH TIME ZONE
);

-- User preferences
CREATE TABLE public.user_preferences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
    job_types           TEXT[] DEFAULT '{}',
    locations           TEXT[] DEFAULT '{}',
    sponsorship_needed  BOOLEAN DEFAULT false,
    sectors             TEXT[] DEFAULT '{}',
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Applied jobs
CREATE TABLE public.user_applied_jobs (
    id         SERIAL PRIMARY KEY,
    user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    job_id     INTEGER REFERENCES public.jobs(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, job_id)
);

-- Favourite companies
CREATE TABLE public.user_favorite_companies (
    id         SERIAL PRIMARY KEY,
    user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id INTEGER REFERENCES public.companies(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, company_id)
);

-- Reported jobs
CREATE TABLE public.reported_jobs (
    id         SERIAL PRIMARY KEY,
    job_id     INTEGER REFERENCES public.jobs(id) ON DELETE CASCADE,
    notes      TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON COLUMN public.reported_jobs.notes IS 'User provided reason for reporting the job (e.g. expired, incorrect details)';

-- Graduate roles (external sources like Reed)
CREATE TABLE public.graduate_roles (
    id            TEXT PRIMARY KEY,
    company_id    INTEGER DEFAULT 0,
    trading_name  TEXT NOT NULL,
    title         TEXT NOT NULL,
    location      TEXT NOT NULL,
    url           TEXT NOT NULL,
    department    TEXT,
    level         TEXT DEFAULT 'Graduate',
    salary        TEXT,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
    last_seen_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
    sync_run_id   TEXT
);

-- ATS import audit log
CREATE TABLE public.ats_import_audit (
    company_id          INTEGER PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
    source_file         TEXT NOT NULL,
    source_company_name TEXT,
    sync_provider       TEXT,
    provider_raw        TEXT,
    board_token_raw     TEXT,
    careers_url_raw     TEXT,
    verification        TEXT,
    status              TEXT,
    imported_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ATS config / routing table (used by sync scripts to know WHICH API to call per company)
CREATE TABLE public.company_ats_config (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    INTEGER REFERENCES public.companies(id) ON DELETE CASCADE,
    ats_provider  TEXT NOT NULL,
    api_endpoint  TEXT NOT NULL,
    req_method    TEXT NOT NULL DEFAULT 'GET',
    req_payload   TEXT,                     -- JSON body for POST requests (stored as TEXT)
    is_active     BOOLEAN DEFAULT true,
    last_sync_at  TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    company_name  TEXT
);

-- =============================================================================
-- STEP 5: INDEXES (performance)
-- =============================================================================

-- jobs
CREATE INDEX IF NOT EXISTS idx_jobs_company_id   ON public.jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_location     ON public.jobs(location);
CREATE INDEX IF NOT EXISTS idx_jobs_level        ON public.jobs(level);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at   ON public.jobs(created_at DESC);

-- companies
CREATE INDEX IF NOT EXISTS idx_companies_trading_name      ON public.companies(trading_name);
CREATE INDEX IF NOT EXISTS idx_companies_licensed_sponsor  ON public.companies(licensed_sponsor);
CREATE INDEX IF NOT EXISTS idx_companies_ats_status        ON public.companies(ats_status);
CREATE INDEX IF NOT EXISTS idx_companies_ats_last_validated ON public.companies(ats_last_validated DESC);

-- subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id_status ON public.subscriptions(user_id, status);

-- user tables
CREATE INDEX IF NOT EXISTS idx_user_applied_jobs_user_id          ON public.user_applied_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_favorite_companies_user_id    ON public.user_favorite_companies(user_id);
CREATE INDEX IF NOT EXISTS idx_user_favorite_companies_company_id ON public.user_favorite_companies(company_id);

-- reported jobs
CREATE INDEX IF NOT EXISTS idx_reported_jobs_job_id ON public.reported_jobs(job_id);

-- ats import audit
CREATE INDEX IF NOT EXISTS idx_ats_import_audit_status       ON public.ats_import_audit(status);
CREATE INDEX IF NOT EXISTS idx_ats_import_audit_provider_raw ON public.ats_import_audit(provider_raw);

-- company_ats_config
CREATE INDEX IF NOT EXISTS idx_company_ats_config_company_id   ON public.company_ats_config(company_id);
CREATE INDEX IF NOT EXISTS idx_company_ats_config_ats_provider ON public.company_ats_config(ats_provider);
CREATE INDEX IF NOT EXISTS idx_company_ats_config_is_active    ON public.company_ats_config(is_active);

-- =============================================================================
-- STEP 6: ROW LEVEL SECURITY (RLS)
-- =============================================================================

-- ── companies ── (RLS OFF so sync scripts using anon/publishable key work freely)
ALTER TABLE public.companies DISABLE ROW LEVEL SECURITY;

-- ── jobs ── (RLS OFF — public data, sync scripts need full write access)
ALTER TABLE public.jobs DISABLE ROW LEVEL SECURITY;

-- ── customers ──
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own customer record"
  ON public.customers FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own customer record"
  ON public.customers FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ── subscriptions ──
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own subscription"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- ── user_preferences ──
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own preferences"
  ON public.user_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own preferences"
  ON public.user_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own preferences"
  ON public.user_preferences FOR UPDATE
  USING (auth.uid() = user_id);

-- ── user_applied_jobs ──
ALTER TABLE public.user_applied_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only read their own applied jobs"
  ON public.user_applied_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own applied jobs"
  ON public.user_applied_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own applied jobs"
  ON public.user_applied_jobs FOR DELETE
  USING (auth.uid() = user_id);

-- ── user_favorite_companies ──
ALTER TABLE public.user_favorite_companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only read their own favorite companies"
  ON public.user_favorite_companies FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own favorite companies"
  ON public.user_favorite_companies FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own favorite companies"
  ON public.user_favorite_companies FOR DELETE
  USING (auth.uid() = user_id);

-- ── reported_jobs ──
ALTER TABLE public.reported_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public insert to reported_jobs"
  ON public.reported_jobs FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow service role full access to reported_jobs"
  ON public.reported_jobs FOR ALL
  USING (auth.role() = 'service_role');

-- ── graduate_roles ──
ALTER TABLE public.graduate_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to graduate_roles"
  ON public.graduate_roles FOR SELECT
  USING (true);

CREATE POLICY "Allow service role all access to graduate_roles"
  ON public.graduate_roles FOR ALL
  USING (auth.role() = 'service_role');

-- ── ats_import_audit ── (service role only — internal audit table)
ALTER TABLE public.ats_import_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access to ats_import_audit"
  ON public.ats_import_audit FOR ALL
  USING (auth.role() = 'service_role');

-- ── company_ats_config ── (RLS OFF — sync scripts need full read/write via anon/service key)
ALTER TABLE public.company_ats_config DISABLE ROW LEVEL SECURITY;

-- =============================================================================
-- STEP 7: Notify PostgREST to reload schema cache
-- =============================================================================
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- DONE ✓
-- Tables created: companies, jobs, customers, subscriptions, user_preferences,
--                 user_applied_jobs, user_favorite_companies, reported_jobs,
--                 graduate_roles, ats_import_audit, company_ats_config
-- All CRUD operations are supported for each table.
-- =============================================================================
