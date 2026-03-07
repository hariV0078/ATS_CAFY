import fs from 'fs';
import path from 'path';
import { supabase } from '../lib/supabase';

async function run() {
    const jsonPath = path.resolve('/Users/shami/Downloads/JOBS/companies.json');
    console.log(`Reading companies from: ${jsonPath}`);

    if (!fs.existsSync(jsonPath)) {
        console.error("Error: companies.json not found!");
        return;
    }

    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(rawData);
    const companies = parsed.data?.companies || [];

    console.log(`Found ${companies.length} companies in JSON.`);

    if (companies.length === 0) {
        console.log("No companies to ingest.");
        return;
    }

    const BATCH_SIZE = 100;
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < companies.length; i += BATCH_SIZE) {
        const batch = companies.slice(i, i + BATCH_SIZE).map((c: any) => ({
            id: c.id,
            trading_name: c.trading_name,
            companies_house_name: c.companies_house_name,
            url: c.url,
            url_linkedin: c.url_linkedin,
            description: c.description,
            policy: c.policy,
            open_to_sponsorship: c.open_to_sponsorship,
            active_jobs_count: c.active_jobs_count,
            url_favicon: c.url_favicon,
            licensed_sponsor: c.licensed_sponsor !== undefined ? c.licensed_sponsor : true,
            estimated_num_employees_label: c.estimated_num_employees_label,
            ats_provider: c.ats_provider || null,
            ats_board_token: c.ats_board_token || null
        }));

        const { error } = await supabase
            .from('companies')
            .upsert(batch, { onConflict: 'id' });

        if (error) {
            console.error(`Error in batch ${i / BATCH_SIZE + 1}:`, error);
            errorCount += batch.length;
        } else {
            successCount += batch.length;
            console.log(`[${successCount}/${companies.length}] Successfully upserted batch...`);
        }
    }

    console.log("\n--- Ingestion Complete ---");
    console.log(`Total processed: ${companies.length}`);
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${errorCount}`);
}

run().catch(err => {
    console.error("Fatal error during ingestion:", err);
});
