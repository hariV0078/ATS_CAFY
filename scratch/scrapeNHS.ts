import * as cheerio from 'cheerio';
import { supabase } from './src/lib/supabase';

// Helper to pause execution
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchPage(pageNumber: number): Promise<any[]> {
    const url = `https://www.jobs.nhs.uk/candidate/search/results?workingPattern=full-time&payRange=30-40%2C40-50%2C50-60%2C60-70%2C70-80%2C80-90%2C90-100%2C100&language=en&page=${pageNumber}`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`Page ${pageNumber} failed: ${res.status}`);
            return [];
        }

        const html = await res.text();
        const $ = cheerio.load(html);

        const jobs: any[] = [];
        $('.search-result').each((i, el) => {
            const titleEl = $(el).find('a').first();
            if (!titleEl.length) return;

            const title = titleEl.text().trim();
            let jobUrl = titleEl.attr('href');
            if (jobUrl && jobUrl.startsWith('/')) {
                jobUrl = 'https://www.jobs.nhs.uk' + jobUrl.split('?')[0]; // Remove complex query params from the job URL to maintain a clean tracking link
            }

            // The location in the NHS DOM can be formatted weirdly with lots of whitespace
            const rawLocation = $(el).find('[data-test="search-result-location"]').text().trim() ||
                $(el).find('.search-result-location').text().trim() ||
                $(el).find('li:contains("Location")').text().replace("Location:", "").trim() ||
                'United Kingdom';

            // NHS locations are often nested with newlines indicating the hospital
            const location = rawLocation.replace(/\n+/g, ', ').replace(/\s{2,}/g, ' ').trim();

            jobs.push({
                company_id: 1690,
                title,
                url: jobUrl,
                location,
                department: ''
            });
        });
        return jobs;
    } catch (e) {
        console.error(`Error fetching page ${pageNumber}:`, e);
        return [];
    }
}

async function run() {
    console.log("Starting massive NHS Job Extraction...");

    // As observed, there are 529 pages. We will dynamically extract it from Page 1 just in case it fluctuates
    const res = await fetch("https://www.jobs.nhs.uk/candidate/search/results?workingPattern=full-time&payRange=30-40%2C40-50%2C50-60%2C60-70%2C70-80%2C80-90%2C90-100%2C100&language=en");
    const html = await res.text();
    const $ = cheerio.load(html);

    // Parse the total pages from the UI
    let totalPages = 529; // Hard fallback
    const pageText = $('.nhsuk-pagination__link').text();
    const match = pageText.match(/Page \d+ of\s+(\d+)/);
    if (match && match[1]) {
        totalPages = parseInt(match[1]);
    }

    console.log(`Detected ${totalPages} total pages of NHS Jobs.`);

    let allJobs: any[] = [];
    const concurrency = 10;

    for (let i = 1; i <= totalPages; i += concurrency) {
        const batch = [];
        for (let j = 0; j < concurrency; j++) {
            if (i + j <= totalPages) {
                batch.push(fetchPage(i + j));
            }
        }

        const results = await Promise.all(batch);
        for (const pageJobs of results) {
            allJobs.push(...pageJobs);
        }

        console.log(`...Processed up to page ${Math.min(i + concurrency - 1, totalPages)} / ${totalPages} (Total accumulated jobs: ${allJobs.length})`);

        // Gentle sleep so we don't bring down the NHS servers
        await sleep(300);
    }

    console.log(`Finished extraction! Total jobs parsed: ${allJobs.length}`);

    // Now insert them into Supabase in chunks of 500
    if (allJobs.length > 0) {
        console.log("Saving exactly into Supabase jobs table...");
        let insertedCount = 0;

        // Deduplicate in memory by URL
        const uniqueJobsMap = new Map();
        for (const job of allJobs) {
            uniqueJobsMap.set(job.url, job);
        }
        const uniqueJobs = Array.from(uniqueJobsMap.values());
        console.log(`Deduplicated from ${allJobs.length} down to ${uniqueJobs.length} uniquely linked roles.`);

        for (let i = 0; i < uniqueJobs.length; i += 500) {
            const chunk = uniqueJobs.slice(i, i + 500);
            const { error } = await supabase.from('jobs').upsert(chunk, { onConflict: 'url' });
            if (error) {
                console.error("Supabase insert error:", error);
            } else {
                insertedCount += chunk.length;
                console.log(`...Inserted ${insertedCount} / ${uniqueJobs.length} into database`);
            }
        }

        // Update the NHS company 'active_jobs_count' column
        await supabase.from('companies').update({
            ats_provider: 'custom_nhs',
            active_jobs_count: uniqueJobs.length
        }).eq('id', 1690);

        console.log("Successfully updated NHS sponsor registry totals.");
    }
}

run();
