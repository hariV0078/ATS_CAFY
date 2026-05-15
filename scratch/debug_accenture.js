const fs = require('fs');
async function test() {
    const res = await fetch('https://accenture.wd103.myworkdayjobs.com/wday/cxs/accenture/accenturecareers/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appliedFacets: { locationCountry: ['29247e57dbaf46fb855b224e03170bc7'] },
            limit: 5, offset: 0, searchText: ''
        })
    });
    const data = await res.json();
    fs.writeFileSync('scratch/debug_accenture.json', JSON.stringify(data, null, 2));
    console.log('Total:', data.total);
    console.log('Postings:', data.jobPostings?.length);
}
test().catch(console.error);
