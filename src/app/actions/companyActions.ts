'use server';

import { supabase } from '@/lib/supabase';
import { createClient } from '@/utils/supabase/server';
import { getSubscriptionStatus } from './subscriptionActions';

export interface Company {
    id: number;
    trading_name: string;
    companies_house_name: string | null;
    url: string | null;
    url_linkedin: string | null;
    url_favicon: string | null;
    description: string | null;
    estimated_num_employees_label: string | null;
    licensed_sponsor: boolean;
    active_jobs_count: number;
}

export async function getCompanies(params: {
    page?: number;
    q?: string;
    sort?: string;
    excludedCompanyIds?: number[];
    favoritesOnly?: boolean;
}) {
    const PAGE_SIZE = 5;
    const page = params.page || 1;

    const { isPro } = await getSubscriptionStatus();

    // Free users only get the first page
    if (!isPro && page > 1) {
        return { companies: [], totalPages: 1 };
    }

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const favoritesOnly = params.favoritesOnly;
    const supabaseServer = favoritesOnly ? await createClient() : null;
    const user = favoritesOnly ? (await supabaseServer!.auth.getUser()).data.user : null;

    if (favoritesOnly && !user) {
        return { companies: [], totalPages: 0 };
    }

    let query = supabase
        .from('companies')
        .select('*', { count: 'exact' });

    if (favoritesOnly && user) {
        const { data: favs, error: favError } = await supabaseServer!
            .from('user_favorite_companies')
            .select('company_id')
            .eq('user_id', user.id);

        if (favError || !favs || favs.length === 0) {
            return { companies: [], totalPages: 0 };
        }

        const favIds = favs.map(f => f.company_id);
        query = query.in('id', favIds);
    }

    if (params.excludedCompanyIds && params.excludedCompanyIds.length > 0) {
        query = query.not('id', 'in', `(${params.excludedCompanyIds.join(',')})`);
    }

    if (params.q) {
        query = query.ilike('trading_name', `%${params.q}%`);
    }

    // Apply sorting
    if (params.sort === 'alphabetical') {
        query = query.order('trading_name', { ascending: true });
    } else if (params.sort === 'alphabetical_desc') {
        query = query.order('trading_name', { ascending: false });
    } else if (params.sort === 'jobs_asc') {
        query = query
            .order('active_jobs_count', { ascending: true, nullsFirst: false })
            .order('trading_name', { ascending: true });
    } else {
        // Default: most jobs first
        query = query
            .order('active_jobs_count', { ascending: false, nullsFirst: false })
            .order('trading_name', { ascending: true });
    }

    query = query.range(from, to);

    const { data: rawCompanies, count, error } = await query;

    if (error) {
        console.error('getCompanies error:', error);
        return { companies: [], totalPages: 0 };
    }

    // Map back to Company[]
    const cleanCompanies = (rawCompanies || []).map(c => c as unknown as Company);

    let totalPages = count ? Math.ceil(count / PAGE_SIZE) : 0;
    if (!isPro) {
        totalPages = Math.min(totalPages, 1);
    }

    return { companies: cleanCompanies, totalPages };
}

export async function toggleFavoriteCompany(companyId: number) {
    const supabaseServer = await createClient();
    const { data: { user } } = await supabaseServer.auth.getUser();
    if (!user) throw new Error('Not logged in');

    const { data: existing } = await supabaseServer
        .from('user_favorite_companies')
        .select('id')
        .eq('user_id', user.id)
        .eq('company_id', companyId)
        .single();

    if (existing) {
        await supabaseServer
            .from('user_favorite_companies')
            .delete()
            .eq('id', existing.id);
        return { isFavorite: false };
    } else {
        await supabaseServer
            .from('user_favorite_companies')
            .insert({ user_id: user.id, company_id: companyId });
        return { isFavorite: true };
    }
}

export async function getFavoriteCompanyIds() {
    const supabaseServer = await createClient();
    const { data: { user } } = await supabaseServer.auth.getUser();
    if (!user) return [];

    const { data } = await supabaseServer
        .from('user_favorite_companies')
        .select('company_id')
        .eq('user_id', user.id);

    return (data || []).map(f => f.company_id);
}
