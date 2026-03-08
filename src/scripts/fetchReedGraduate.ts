import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const REED_API_KEY = process.env.REED_API_KEY;
const RESULTS_PER_PAGE = 100;
const BASE_URL = 'https://www.reed.co.uk/api/1.0/search';
const MAX_PAGES = 100; // Cap at 10,000 jobs
const REQUEST_DELAY_MS = 1000;

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

interface ReedJobResult {
    jobId?: number;
    jobTitle?: string;
    employerName?: string;
    locationName?: string;
    jobUrl?: string;
    [k: string]: unknown;
}

// Function to safely slice strings for DB
function safeStr(str: string | undefined | null, max = 500) {
    if (!str) return '';
    return str.substring(0, max);
}

function buildRows(jobs: ReedJobResult[], syncRunId: string) {
    const uniqueByUrl = Array.from(
        new Map(jobs.filter((j) => j.jobUrl).map((j) => [j.jobUrl!, j])).values()
    );

    return uniqueByUrl.map((j) => ({
        id: `reed-${j.jobId}`,
        company_id: 0,
        trading_name: safeStr(j.employerName, 200),
        title: safeStr(j.jobTitle, 500),
        location: safeStr(j.locationName, 500),
        url: safeStr(j.jobUrl),
        department: null,
        level: 'Graduate',
        salary: j.minimumSalary ? `£${j.minimumSalary} - £${j.maximumSalary}` : null,
        sync_run_id: syncRunId,
        last_seen_at: new Date().toISOString()
    }));
}

async function fetchReedGraduate() {
    console.log('\n🎓 --- Fetching Reed UK Graduate Jobs --- 🎓\n');

    if (!REED_API_KEY?.trim()) {
        console.error('Missing REED_API_KEY in .env.local. Get an API key from https://www.reed.co.uk/developers/Jobseeker');
        process.exit(1);
    }

    const authHeader = 'Basic ' + Buffer.from(REED_API_KEY.trim() + ':', 'utf8').toString('base64');
    const allJobs: ReedJobResult[] = [];
    let resultsToSkip = 0;
    let pageNum = 0;

    // We use a single syncRunId to mark all jobs that are still live
    const syncRunId = crypto.randomUUID();

    while (pageNum < MAX_PAGES) {
        pageNum += 1;
        const url = new URL(BASE_URL);
        url.searchParams.set('graduate', 'true');
        url.searchParams.set('resultsToTake', String(RESULTS_PER_PAGE));
        url.searchParams.set('resultsToSkip', String(resultsToSkip));

        try {
            const res = await fetch(url.toString(), {
                headers: {
                    'Authorization': authHeader,
                    'Accept': 'application/json',
                    'User-Agent': 'GetLanded/1.0 (UK graduate jobs aggregator)',
                },
            });

            if (!res.ok) {
                console.error(`Reed API error: ${res.status} ${res.statusText}`);
                if (res.status === 401) console.error('Check REED_API_KEY is correct.');
                break;
            }

            const data = await res.json();
            const results = Array.isArray(data) ? data : (data?.results ?? []);
            if (results.length === 0) break;

            allJobs.push(...results);

            // Insert incrementally to DB so UI updates live
            const rows = buildRows(results, syncRunId);
            const { error } = await supabase.from('graduate_roles').upsert(rows, { onConflict: 'id' });

            if (error) {
                console.error(`Error saving page ${pageNum}:`, error.message);
            } else {
                console.log(`  Page ${pageNum}: Saved ${rows.length} jobs to DB (Total so far: ${allJobs.length})`);
            }

            if (results.length < RESULTS_PER_PAGE) {
                console.log('  No more pages — fetched all UK graduate jobs.');
                break;
            }

            resultsToSkip += RESULTS_PER_PAGE;
            await sleep(REQUEST_DELAY_MS);
        } catch (e: any) {
            console.error('Request error:', e.message);
            break;
        }
    }

    if (pageNum >= MAX_PAGES && allJobs.length > 0) {
        console.warn(`  Reached safety cap of ${MAX_PAGES} pages. If Reed has more, increase MAX_PAGES.`);
    }

    const finalCount = buildRows(allJobs, syncRunId).length;
    console.log(`\n✅ Fetch complete. Total UK graduate jobs synced: ${finalCount}`);

    // Delete stale jobs that were not seen in this run
    if (finalCount > 0) {
        console.log('🧹 Cleaning up expired roles from database...');
        const { error: delError, count: delCount } = await supabase
            .from('graduate_roles')
            .delete({ count: 'exact' })
            .neq('sync_run_id', syncRunId);

        if (delError) {
            console.error('Error cleaning up:', delError);
        } else {
            console.log(`Removed ${delCount || 0} expired graduate roles.`);
        }
    }
}

fetchReedGraduate().catch(console.error);
