export {};

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
        const facet = data.facets.find((f: any) => f.facetParameter === 'locationMainGroup');
        if (facet && facet.values[0] && facet.values[0].values) {
            console.log('Nested locations sample:', facet.values[0].values.slice(0, 10).map((v: any) => v.descriptor).join(' | '));
            const uk = facet.values[0].values.find((v: any) => v.descriptor.includes('United Kingdom') || v.descriptor.includes('GB-'));
            if (uk) {
                console.log('UK Match:', uk.descriptor, 'ID:', uk.id);
            }
        }
    }
}

getFacets().catch(console.error);
