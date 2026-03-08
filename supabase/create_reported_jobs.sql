CREATE TABLE public.reported_jobs (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES public.jobs(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster admin queries
CREATE INDEX idx_reported_jobs_job_id ON public.reported_jobs(job_id);

-- Optional RLS policies if needed, allowing insert for everyone but select for admins only
-- But assuming it's mostly server-side driven, we can skip complex RLS or just enable it.
