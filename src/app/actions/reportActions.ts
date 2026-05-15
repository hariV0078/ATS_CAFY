'use server';

import { createClient } from '../../utils/supabase/server';

const POSTGRES_UNDEFINED_COLUMN = '42703';

export async function reportJobAction(jobId: number, notes?: string) {
    const supabaseServer = await createClient();

    // Ensure the caller is authenticated. With RLS enabled most tables
    // will only allow inserts where `user_id = auth.uid()` so include it.
    const { data: { user }, error: userError } = await supabaseServer.auth.getUser();
    if (userError || !user) {
        return { success: false, error: 'Not authenticated.' };
    }

    try {
        let { error } = await supabaseServer
            .from('reported_jobs')
            .insert({
                user_id: user.id,
                job_id: jobId,
                notes: notes || null
            });

        const missingUserIdColumn =
            (error as { code?: string } | null)?.code === POSTGRES_UNDEFINED_COLUMN &&
            error?.message?.toLowerCase().includes('user_id');

        if (missingUserIdColumn) {
            const fallback = await supabaseServer
                .from('reported_jobs')
                .insert({
                    job_id: jobId,
                    notes: notes || null
                });
            error = fallback.error;
        }

        if (error) {
            console.error('Error reporting job:', error);
            return { success: false, error: 'Failed to report job.' };
        }

        return { success: true, message: 'Job reported successfully.' };
    } catch (e) {
        console.error('Exception reporting job:', e);
        return { success: false, error: 'An unexpected error occurred.' };
    }
}
