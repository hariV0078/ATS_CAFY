import { supabase } from '../lib/supabase';

async function check() {
    const { data } = await supabase.from('company_ats_config').select('ats_provider, api_endpoint');

    const samples: Record<string, string> = {};
    for (const row of (data || [])) {
        if (!samples[row.ats_provider]) samples[row.ats_provider] = row.api_endpoint;
    }
    console.log(samples);
}

check();
