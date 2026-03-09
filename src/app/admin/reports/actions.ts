'use server';

import { createAdminClient } from '@/utils/supabase/admin';
import { createClient } from '@/utils/supabase/server';
import { isAdmin } from '@/utils/auth';

export async function getReportedJobsAdmin() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!isAdmin(user?.email)) {
        return { success: false, error: 'Unauthorized' };
    }

    const adminClient = createAdminClient();

    try {
        const { data, error } = await adminClient
            .from('reported_jobs')
            .select(`
                id,
                created_at,
                job_id,
                jobs:job_id (
                    id,
                    title,
                    url,
                    company_id,
                    companies:company_id (
                        trading_name
                    )
                )
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;

        return { success: true, data };
    } catch (error) {
        console.error('Error fetching reported jobs:', error);
        return { success: false, error: 'Failed to load reported jobs.' };
    }
}

export async function deleteJobAdmin(jobId: number) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!isAdmin(user?.email)) {
        return { success: false, error: 'Unauthorized' };
    }

    const adminClient = createAdminClient();

    try {
        const { error } = await adminClient
            .from('jobs')
            .delete()
            .eq('id', jobId);

        if (error) throw error;
        return { success: true, message: 'Job deleted successfully.' };
    } catch (error) {
        console.error('Error deleting job:', error);
        return { success: false, error: 'Failed to delete job.' };
    }
}

export async function dismissReportAdmin(reportId: number) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!isAdmin(user?.email)) {
        return { success: false, error: 'Unauthorized' };
    }

    const adminClient = createAdminClient();

    try {
        const { error } = await adminClient
            .from('reported_jobs')
            .delete()
            .eq('id', reportId);

        if (error) throw error;
        return { success: true, message: 'Report dismissed successfully.' };
    } catch (error) {
        console.error('Error dismissing report:', error);
        return { success: false, error: 'Failed to dismiss report.' };
    }
}
