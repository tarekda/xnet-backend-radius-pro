const { fetchAuthenticatedExport } = require('./dist/services/myispInvoiceService');
const fs = require('fs');

fetchAuthenticatedExport(1).then(r => {
    console.log("SUCCESS:", r.csv.length);
}).catch(e => {
    console.log("FAILED:", e.message);
    if (e.message === 'MyISP authentication failed') {
        console.log("Check logs...");
    }
});
