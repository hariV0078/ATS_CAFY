const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.goto('https://www.jobs.nhs.uk/candidate/search/results?workingPattern=full-time&contractType=Permanent&payRange=30-40%2C40-50%2C50-60%2C60-70%2C70-80%2C80-90%2C90-100%2C100&language=en#', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000);
        const jobs = await page.$$eval('.search-result', el => el.length);
        console.log('Jobs found with .search-result:', jobs);
        
        const html = await page.content();
        const fs = require('fs');
        fs.writeFileSync('nhs_sample.html', html);
        
        // Let's try finding the title selector
        const firstTitle = await page.evaluate(() => {
            const h3 = document.querySelector('h3 a');
            return h3 ? { text: h3.innerText, href: h3.href } : null;
        });
        console.log('First title found:', firstTitle);
        
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
})();
