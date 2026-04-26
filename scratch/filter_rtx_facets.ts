
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
        if (facet) {
            const ukValues = facet.values.filter((v: any) => v.descriptor.includes('GB-') || v.descriptor.includes('United Kingdom') || v.descriptor.includes('UK'));
            console.log('UK Values:', JSON.stringify(ukValues, null, 2));
        }
    }
}

getFacets().catch(console.error);
