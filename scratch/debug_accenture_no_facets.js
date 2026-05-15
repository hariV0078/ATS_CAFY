const fs = require('fs');
async function test() {
    const res = await fetch('https://accenture.wd103.myworkdayjobs.com/wday/cxs/accenture/accenturecareers/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appliedFacets: {},
            limit: 5, offset: 0, searchText: ''
        })
    });
    const data = await res.json();
    fs.writeFileSync('scratch/debug_accenture_no_facets.json', JSON.stringify(data, null, 2));
    console.log('Total:', data.total);
    if (data.jobPostings) {
        console.log('Postings:', data.jobPostings.map(p => p.title));
    }
}
test().catch(console.error);
