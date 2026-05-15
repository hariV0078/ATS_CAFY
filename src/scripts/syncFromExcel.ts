import { execSync } from 'child_process';
import * as path from 'path';
import * as xlsx from 'xlsx';

const XLSX_PATH = path.resolve(__dirname, '../../Testing_jobs_data.xlsx');

const BATCH_SIZE = 50;

async function run() {
    console.log(`Reading IDs from: ${XLSX_PATH}`);
    
    // Parse Excel file to get the IDs
    const workbook = xlsx.readFile(XLSX_PATH);
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const rows = xlsx.utils.sheet_to_json<Record<string, any>>(worksheet);

    const allIds = Array.from(new Set(
        rows
            .filter(r => r['Company ID'] && !isNaN(Number(r['Company ID'])))
            .map(r => Number(r['Company ID']))
    ));

    console.log(`Found ${allIds.length} unique company IDs to sync.\n`);

    for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
        const chunk = allIds.slice(i, i + BATCH_SIZE);
        console.log(`\n\n--- Running sync for batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(allIds.length / BATCH_SIZE)} ---`);
        try {
            execSync(`npx tsx src/scripts/syncAll.ts --ids ${chunk.join(',')}`, { stdio: 'inherit' });
        } catch (err: any) {
            console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err.message);
        }
    }
    console.log('\n✅ All batches finished! The jobs have been scraped and saved to your database.');
}

run();
