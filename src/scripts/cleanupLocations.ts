import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

(async () => {
    console.log('Cleaning up bad locations...');

    let allJobs: any[] = [];
    let from = 0;
    while (true) {
        const { data, error } = await supabase.from('jobs').select('id, title, location, company_id, company:companies(trading_name)').range(from, from + 999);
        if (error) {
            console.error('Fetch error:', error);
            break;
        }
        if (!data || data.length === 0) break;
        allJobs.push(...data);
        if (data.length < 1000) break;
        from += 1000;
    }

    const blockList = [
        'ukraine', 'new york', 'new jersey', 'united states', 'usa', 'india', 'canada',
        'australia', 'germany', 'france', 'ireland', 'dublin', 'paris', 'berlin',
        'amsterdam', 'massachusetts', 'washington', 'texas', 'california', 'chicago',
        'hong kong', 'singapore', 'sydney', 'tokyo'
    ];

    const usRegex = /\b(us|ny|nj|ca|tx|ma|il|wa|fl)\b/i;

    let toDelete: string[] = [];

    for (const j of allJobs) {
        if (!j.location) continue;
        const lowerLoc = j.location.toLowerCase();

        let isBad = false;

        if (blockList.some(b => lowerLoc.includes(b))) {
            isBad = true;
        } else if (usRegex.test(lowerLoc) && !lowerLoc.includes('australia')) {
            isBad = true;
        }

        if (isBad && !lowerLoc.includes('uk') && !lowerLoc.includes('united kingdom') && !lowerLoc.includes('london')) {
            toDelete.push(j.id);
            console.log('Bad job marking for delete:', j.company?.trading_name, '|', j.title, '|', j.location);
        }
    }

    console.log('Found', toDelete.length, 'bad jobs out of', allJobs.length);

    if (toDelete.length > 0) {
        // Delete in batches of 100
        for (let i = 0; i < toDelete.length; i += 100) {
            const batch = toDelete.slice(i, i + 100);
            const { error: delErr } = await supabase.from('jobs').delete().in('id', batch);
            if (delErr) {
                console.error('Delete error for batch:', delErr);
            }
        }
        console.log('Deleted successfully.');
    }
})();
