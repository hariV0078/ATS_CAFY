import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function check() {
    const { data } = await supabase.from('company_ats_config').select('ats_provider, api_endpoint');

    const samples = {};
    for (const row of (data || [])) {
        if (!samples[row.ats_provider]) samples[row.ats_provider] = row.api_endpoint;
    }
    console.log(samples);
}

check();
