import Link from 'next/link';
import { Lock } from 'lucide-react';
import { createClient } from '../../utils/supabase/server';
import Logo from '../../components/Logo';
import JobFeed from '../../components/JobFeed';
import { getJobs } from '../actions/jobActions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 5;

// Fix known bad URL patterns (SmartRecruiters API URL -> public page)
function fixJobUrl(url: string): string {
  if (!url) return '#';
  if (url.includes('api.smartrecruiters.com')) {
    const match = url.match(/\/companies\/([^/]+)\/postings\/([^/?#]+)/);
    if (match) return `https://jobs.smartrecruiters.com/${match[1]}/${match[2]}`;
  }
  return url;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ json?: string, page?: string, q?: string, loc?: string, tier2?: string, locs?: string | string[], type?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || '1'));
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Try to get logged-in user preferences
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();

  let userPrefs = null;
  const initialAppliedJobs: Record<string, string> = {};
  if (user) {
    const { data: prefs } = await serverSupabase
      .from('user_preferences')
      .select('*')
      .eq('user_id', user.id)
      .single();
    userPrefs = prefs;

    const { data: applied } = await serverSupabase
      .from('user_applied_jobs')
      .select('job_id, created_at')
      .eq('user_id', user.id);

    if (applied) {
      applied.forEach(a => {
        initialAppliedJobs[a.job_id] = a.created_at;
      });
    }
  }

  // Use the shared getJobs action for the initial load
  // This ensures stable sorting and company diversity
  const { jobs, totalPages } = await getJobs({
    page,
    q: params.q,
    loc: params.loc,
    tier2: params.tier2,
    locs: params.locs,
    userPrefs: userPrefs,
    type: params.type
  });

  const jobList = jobs || [];


  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Main Content */}
      <main className="pt-20 sm:pt-24 pb-20 sm:pb-16 px-4 sm:px-6 lg:px-12 max-w-full mx-auto">
        <div className="flex flex-col gap-6 sm:gap-8">

          {/* Banner */}
          <div className="bg-[#F8F5EE] border border-amber-100 text-[#6B5A40] text-sm px-4 py-3 mb-6 flex items-center rounded-sm">
            {user
              ? <>You're seeing jobs that match your preferences. You can <Link href="/account/preferences" className="underline font-medium ml-1">change these here</Link>.</>
              : <>You're seeing a preview of jobs. <Link href="/signup" className="underline font-medium ml-1">Create a free account</Link> to get a personalised feed and track applications.</>}
          </div>

          <div className="flex flex-col gap-4">
            {/* Tabs */}
            <div className="flex items-center gap-6 border-b border-[var(--border)] overflow-x-auto no-scrollbar">
              <Link
                href="/jobs"
                className={`pb-3 text-sm font-bold whitespace-nowrap border-b-2 transition-colors ${!params.type || params.type !== 'graduate' ? 'border-[#0066FF] text-[#0066FF]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
              >
                For You
              </Link>
              <Link
                href="/jobs?type=graduate"
                className={`pb-3 text-sm font-bold whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${params.type === 'graduate' ? 'border-[#0066FF] text-[#0066FF]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
              >
                Graduate Roles
                <Lock className="w-3.5 h-3.5 opacity-60" />
              </Link>
            </div>

            {/* Job Feed Area */}
            <div className="flex flex-col">
              {params.type === 'graduate' ? (
                <div className="text-center py-16 sm:py-24 bg-[var(--card)] rounded-none border border-dashed border-[var(--border)] px-6 relative z-10 w-full lg:w-[55%]">
                  <Lock className="w-12 h-12 text-slate-300 mx-auto mb-5" />
                  <h3 className="text-xl font-bold text-slate-900 mb-2">Coming Soon</h3>
                  <p className="text-slate-500 max-w-sm mx-auto leading-relaxed">
                    We're working hard to bring you the best verified UK graduate schemes with visa sponsorship. Stay tuned!
                  </p>
                </div>
              ) : (
                <JobFeed
                  key={`${params.q}-${params.loc}-${params.tier2}-${params.type}`}
                  initialJobs={jobList as any}
                  initialTotalPages={totalPages}
                  initialAppliedJobs={initialAppliedJobs}
                  isGuest={!user}
                  searchParams={{
                    q: params.q,
                    loc: params.loc,
                    tier2: params.tier2,
                    locs: params.locs,
                    userPrefs: userPrefs,
                    type: params.type
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
