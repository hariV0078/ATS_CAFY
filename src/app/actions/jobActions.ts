'use server';

import { createClient } from '../../utils/supabase/server';
import { createAdminClient } from '../../utils/supabase/admin';
import { getSubscriptionStatus } from './subscriptionActions';

export interface Job {
    id: string;
    title: string;
    url: string;
    location: string;
    department?: string;
    level?: string | null;
    created_at: string;
    company_id: number;
    company?: {
        trading_name: string;
        companies_house_name: string | null;
        url: string | null;
        url_linkedin: string | null;
        url_favicon: string | null;
        description: string | null;
        licensed_sponsor: boolean;
        active_jobs_count: number;
    };
}

export async function getJobs(params: {
    page?: number;
    q?: string;
    loc?: string;
    tier2?: string;
    locs?: string | string[];
    userPrefs?: any;
    excludedJobIds?: string[];
    excludedCompanyIds?: number[];
    company_id?: number;
    sort?: string;
    type?: string;
} = {}) {
    const PAGE_SIZE = 5;
    const page = params.page || 1;
    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const supabaseServer = await createClient();

    const { isPro } = await getSubscriptionStatus();

    // Free users can only access the first page
    if (!isPro && page > 1) {
        return { jobs: [], totalPages: 1 };
    }

    const isGraduate = params.type === 'graduate';

    const adminClient = createAdminClient();

    let query = isGraduate
        ? adminClient.from('graduate_roles').select('*', { count: 'exact' })
        : adminClient.from('jobs').select('*, level, company:companies!inner(*)', { count: 'exact' });

    // 0. Exclusions for stability and diversity
    if (params.excludedJobIds && params.excludedJobIds.length > 0) {
        query = query.not('id', 'in', `(${params.excludedJobIds.join(',')})`);
    }
    if (!isGraduate && params.excludedCompanyIds && params.excludedCompanyIds.length > 0) {
        query = query.not('company_id', 'in', `(${params.excludedCompanyIds.join(',')})`);
    }
    if (params.company_id) {
        query = query.eq('company_id', params.company_id);
    }

    // 1. Text Search (Two-step for robustness)
    if (params.q?.trim()) {
        const searchTerm = params.q.trim().slice(0, 100).replace(/[(),]/g, '');

        if (isGraduate) {
            query = query.or(`title.ilike.%${searchTerm}%,trading_name.ilike.%${searchTerm}%`);
        } else {
            // Find matching companies first
            const { data: matchedCompanies } = await adminClient
                .from('companies')
                .select('id')
                .ilike('trading_name', `%${searchTerm}%`);

            const companyIds = matchedCompanies?.map((c: any) => c.id) || [];

            // Build OR conditions
            const orConditions = [`title.ilike.%${searchTerm}%`];
            if (companyIds.length > 0) {
                orConditions.push(`company_id.in.(${companyIds.join(',')})`);
            }

            query = query.or(orConditions.join(','));
        }
    }

    // 2. City Filter
    if (params.loc?.trim()) {
        const locTerm = params.loc.trim();
        query = query.ilike('location', `%${locTerm}%`);
    }

    // 3. Dropdown Checkbox Locations
    if (params.locs) {
        const locArray = Array.isArray(params.locs) ? params.locs : [params.locs];
        if (locArray.length > 0) {
            const locFilter = locArray.map(l => `location.ilike.%${l}%`).join(',');
            query = query.or(locFilter);
        }
    } else if (!params.q && !params.loc && (params.userPrefs?.locations && params.userPrefs.locations.length > 0)) {
        const expandedLocations: string[] = [];
        params.userPrefs.locations.forEach((l: string) => {
            if (l === 'Rest of UK' || l === 'Rest of the UK') {
                expandedLocations.push('Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Sheffield', 'Bristol', 'Liverpool', 'Newcastle', 'Nottingham', 'Southampton', 'Reading');
            } else {
                expandedLocations.push(l);
            }
        });
        const locFilter = expandedLocations.map(l => `location.ilike.%${l}%`).join(',');
        query = query.or(locFilter);
    }

    // 4. Sponsor Visa check (Only for non-graduate roles which have a company relationship)
    if (!isGraduate) {
        if (params.tier2 === 'true') {
            query = query.eq('company.licensed_sponsor', true);
        } else if (!params.q && !params.loc && !params.tier2 && params.userPrefs?.sponsorship_needed) {
            query = query.eq('company.licensed_sponsor', true);
        }
    }

    // 5. Job Type matching
    if (!params.q && params.userPrefs?.job_types?.length > 0) {
        const typeKeywords: Record<string, string[]> = {
            'Internship': ['intern', 'placement', 'internship', 'student', 'graduate'],
            'Placement scheme': ['placement', 'scheme', 'internship'],
            'Part-time': ['part-time', 'part time', 'hourly', 'flexible'],
            'Full-time': ['full-time', 'full time', 'permanent']
        };

        let allTypeKeywords: string[] = [];
        let hasNonFullTime = false;

        params.userPrefs.job_types.forEach((type: string) => {
            if (type !== 'Full-time' && typeKeywords[type]) {
                allTypeKeywords.push(...typeKeywords[type]);
                hasNonFullTime = true;
            }
        });

        if (hasNonFullTime && allTypeKeywords.length > 0) {
            const typeFilter = allTypeKeywords.map(k => `title.ilike.%${k}%`).join(',');
            query = query.or(typeFilter);
        }
    }

    // 6. Category preference
    if (!params.q && params.userPrefs?.sectors?.length > 0) {
        const sectorKeywords: Record<string, string[]> = {
            'Business & Strategy': ['business', 'strategy', 'consultant', 'analyst', 'corporate', 'planning'],
            'Customer Success': ['customer', 'success', 'support', 'account', 'client'],
            'Data': ['data', 'analytics', 'statistics', 'machine learning', 'ai', 'sql', 'python', 'bi', 'business intelligence'],
            'Design': ['design', 'ui', 'ux', 'product designer', 'graphic', 'creative', 'art'],
            'Engineering (Hardware)': ['hardware', 'electrical', 'electronics', 'mechanical', 'manufacturing', 'firmware'],
            'Engineering (Other)': ['engineering', 'engineer', 'civil', 'chemical', 'biomedical', 'systems'],
            'Engineering (Software)': ['software', 'developer', 'engineer', 'frontend', 'backend', 'fullstack', 'ios', 'android', 'web', 'devops', 'cloud'],
            'Finance': ['finance', 'accounting', 'tax', 'audit', 'financial', 'quant', 'trading', 'investment'],
            'Healthcare': ['health', 'medical', 'clinical', 'nurse', 'doctor', 'pharma', 'biotech'],
            'HR / People': ['hr', 'human resources', 'people', 'talent', 'recruiter', 'recruiting', 'acquisition'],
            'Legal': ['legal', 'counsel', 'lawyer', 'attorney', 'law', 'compliance'],
            'Marketing & PR': ['marketing', 'pr', 'public relations', 'brand', 'content', 'social media', 'communications', 'seo', 'growth'],
            'Media & Journalism': ['media', 'journalism', 'writer', 'editor', 'reporter', 'news', 'broadcast'],
            'Operations': ['operations', 'logistics', 'supply chain', 'facilities', 'admin'],
            'Other': [],
            'Product Management': ['product', 'pm', 'product manager', 'owner'],
            'Project Management': ['project', 'program', 'scrum', 'agile', 'delivery'],
            'Research (Non-technical)': ['research', 'market research', 'user research', 'ur'],
            'Research (Technical)': ['research', 'r&d', 'scientist', 'phd', 'investigator'],
            'Sales & Partnerships': ['sales', 'partnerships', 'bd', 'business development', 'account executive', 'bdr', 'sdr']
        };

        let allKeywords: string[] = [];
        params.userPrefs.sectors.forEach((sector: string) => {
            if (sectorKeywords[sector]) {
                allKeywords.push(...sectorKeywords[sector]);
            }
        });
        allKeywords.push(...params.userPrefs.sectors);
        allKeywords = [...new Set(allKeywords)].filter(k => k.trim().length > 0);

        if (allKeywords.length > 0) {
            const filterConditions = allKeywords.map(keyword => `title.ilike.%${keyword}%,department.ilike.%${keyword}%`).join(',');
            query = query.or(filterConditions);
        }
    }

    // Stable sorting
    if (params.sort === 'oldest') {
        query = query.order('created_at', { ascending: true }).order('id', { ascending: true });
    } else if (params.sort === 'title_asc') {
        query = query.order('title', { ascending: true }).order('id', { ascending: false });
    } else if (params.sort === 'title_desc') {
        query = query.order('title', { ascending: false }).order('id', { ascending: false });
    } else {
        // Default: newest first
        query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
    }

    let rawJobs;
    let count;

    if (params.company_id) {
        const from = (page - 1) * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        const result = await query.range(from, to);
        rawJobs = result.data;
        count = result.count;
    } else {
        const result = await query.range(0, 49);
        if (result.error) {
            console.error('getJobs error:', result.error);
            return { jobs: [], totalPages: 0 };
        }
        rawJobs = result.data;

        // If we are excluding seen jobs/companies (page > 1), the exact count returned 
        // by Supabase shrinks. We need to artificially inflate the count by the number
        // of excluded items so `totalPages` stays constant and pagination doesn't break.
        count = result.count;
        if (count !== null && params.excludedJobIds && params.excludedJobIds.length > 0) {
            count += params.excludedJobIds.length;
        }
    }

    if (!rawJobs) return { jobs: [], totalPages: 0 };

    let finalJobs: Job[] = [];

    if (params.company_id || isGraduate) {
        // If fetching for a specific company or if graduate roles (which all have company_id=0),
        // skip the company diversity logic and just map directly
        finalJobs = rawJobs.map((job: any) => {
            if (isGraduate && !job.company) {
                // Synthesize a dummy company for the UI to prevent crashes
                return {
                    ...job,
                    company: {
                        trading_name: job.trading_name || 'Employer',
                        companies_house_name: null,
                        url: null,
                        url_linkedin: null,
                        url_favicon: null,
                        description: null,
                        licensed_sponsor: false,
                        active_jobs_count: 0
                    }
                };
            }
            return job;
        });
    } else {
        const seenCompaniesThisBatch = new Set();
        for (const job of rawJobs) {
            if (!seenCompaniesThisBatch.has(job.company_id)) {
                finalJobs.push(job);
                seenCompaniesThisBatch.add(job.company_id);
            }
            if (finalJobs.length >= PAGE_SIZE) break;
        }
    }

    // Fallback if we have very few companies but many jobs
    if (!isGraduate && finalJobs.length < PAGE_SIZE && rawJobs.length > 0) {
        for (const job of rawJobs) {
            if (!finalJobs.find(j => j.id === job.id)) {
                finalJobs.push(job);
            }
            if (finalJobs.length >= PAGE_SIZE) break;
        }
    }

    const total = count || 0;
    let totalPages = Math.ceil(total / PAGE_SIZE);

    if (!isPro) {
        totalPages = 1;
    }

    return { jobs: finalJobs, totalPages };
}

export async function markJobAsApplied(jobId: string) {
    const supabaseServer = await createClient();
    const { data: { user } } = await supabaseServer.auth.getUser();
    if (!user) {
        throw new Error('You must be logged in to apply for jobs.');
    }

    try {
        const { error } = await supabaseServer
            .from('user_applied_jobs')
            .insert({ user_id: user.id, job_id: Number(jobId) });

        if (error) {
            if (error.code === '23505') {
                return { success: true, message: 'Already marked as applied' };
            }
            console.error('Error marking job as applied:', error);
            return { success: false, error: 'Failed to mark job as applied.' };
        }

        return { success: true, message: 'Job marked as applied.' };
    } catch (e) {
        console.error('Exception marking job as applied:', e);
        return { success: false, error: 'An unexpected error occurred.' };
    }
}

export async function getAppliedJobs() {
    const supabaseServer = await createClient();
    const { data: { user } } = await supabaseServer.auth.getUser();
    if (!user) {
        return { success: false, error: 'Not logged in', jobs: [] };
    }

    try {
        const { data, error } = await supabaseServer
            .from('user_applied_jobs')
            .select(`
                id,
                created_at,
                job_id,
                jobs:job_id (
                    id,
                    title,
                    url,
                    location,
                    department,
                    created_at,
                    company_id,
                    companies:company_id (
                        trading_name,
                        companies_house_name,
                        url,
                        url_linkedin,
                        url_favicon,
                        licensed_sponsor
                    )
                )
            `)
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Map data to Job format
        const formattedJobs = (data || []).map(record => {
            const jobData = record.jobs as any;
            if (!jobData) return null;

            return {
                id: jobData.id,
                title: jobData.title,
                url: jobData.url,
                location: jobData.location,
                department: jobData.department,
                created_at: jobData.created_at,
                company_id: jobData.company_id,
                company: jobData.companies ? {
                    trading_name: jobData.companies.trading_name,
                    companies_house_name: jobData.companies.companies_house_name,
                    url: jobData.companies.url,
                    url_linkedin: jobData.companies.url_linkedin,
                    url_favicon: jobData.companies.url_favicon,
                    licensed_sponsor: jobData.companies.licensed_sponsor,
                    active_jobs_count: 0 // Default fallback for UI
                } : undefined,
                applied_at: record.created_at
            };
        }).filter(Boolean);

        return { success: true, jobs: formattedJobs };
    } catch (error) {
        console.error('Error fetching applied jobs:', error);
        return { success: false, error: 'Failed to load applied jobs.', jobs: [] };
    }
}
