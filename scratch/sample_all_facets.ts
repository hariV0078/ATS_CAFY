
async function getFacets() {
    const slug = 'globalhr';
    const board = 'REC_RTX_Ext_Gateway';
    const apiUrl = `https://globalhr.wd5.myworkdayjobs.com/wday/cxs/${slug}/${board}/jobs`;

    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' })
    });
    
    if (res.ok) {
        const data: any = await res.json();
        for (const facet of data.facets) {
            console.log(`Facet: ${facet.facetParameter}`);
            console.log(`  Sample: ${facet.values.slice(0, 5).map((v: any) => v.descriptor).join(', ')}`);
        }
    }
}

getFacets().catch(console.error);
