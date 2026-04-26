const fs = require('fs');
fetch('https://apply.workable.com/capitalise/').then(r=>r.text()).then(t=>{
    fs.writeFileSync('capitalise.html', t);
    console.log("Saved");
}).catch(console.error);
