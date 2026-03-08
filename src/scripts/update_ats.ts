import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

(async () => {
    const updates = [
        { name: '10x Banking', ats: 'workable', token: '10xbanking' },
        { name: '1Global', ats: 'workable', token: '1global' },
        { name: '32Co', ats: 'lever', token: '32Co' },
        { name: '9fin', ats: 'ashby', token: '9fin' },
        { name: '10X', ats: 'workable', token: '10xbanking' } // alternative name
    ];

    for (const u of updates) {
        const { data: companies } = await supabase.from('companies').select('id, trading_name').ilike('trading_name', `%${u.name}%`);

        if (companies && companies.length > 0) {
            const company = companies[0];
            const { error } = await supabase.from('companies').update({
                ats_provider: u.ats,
                ats_board_token: u.token
            }).eq('id', company.id);

            if (error) {
                console.error(`Failed to update ${u.name}:`, error.message);
            } else {
                console.log(`Updated ${u.name} (${company.trading_name}) -> ${u.ats}: ${u.token}`);
            }
        } else {
            console.log(`Company ${u.name} not found in DB`);
        }
    }
})();
