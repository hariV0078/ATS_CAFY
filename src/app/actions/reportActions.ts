'use server';

import { createClient } from '../../utils/supabase/server';
import { createAdminClient } from '../../utils/supabase/admin';

export async function reportJobAction(jobId: number, notes?: string) {
    const supabaseServer = await createClient();

    try {
        const { error } = await supabaseServer
            .from('reported_jobs')
            .insert({
                job_id: jobId,
                notes: notes || null
            });

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
