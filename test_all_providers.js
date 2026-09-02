const { fetchHsiRawUsers } = require('./dist/services/hsiProviderInvoiceService');
const { fetchMyISPRawUsers } = require('./dist/services/myispInvoiceService');

async function testAll() {
  console.log('Testing raw subscriber fetch across all providers...\n');

  const myisp1 = await fetchMyISPRawUsers(1);
  console.log(`MyISP 1: ${myisp1.length} total, ${myisp1.filter(u => u.online).length} online`);

  const myisp2 = await fetchMyISPRawUsers(2);
  console.log(`MyISP 2: ${myisp2.length} total, ${myisp2.filter(u => u.online).length} online`);

  for (const p of ['idm', 'terra', 'terra2', 'misp']) {
    try {
      const rows = await fetchHsiRawUsers(p);
      const online = rows.filter(u => u.online).length;
      console.log(`${p.toUpperCase()}: ${rows.length} total, ${online} online`);
      if (rows.length > 0) {
        const sampleOnline = rows.find(u => u.online) || rows[0];
        console.log(`   Sample: username=${sampleOnline.username}, online=${sampleOnline.online}, ip=${sampleOnline.sessionIp}`);
      }
    } catch (e) {
      console.error(`${p.toUpperCase()} FAILED:`, e.message);
    }
  }
}

testAll().catch(e => console.error('FAILED:', e.message));
