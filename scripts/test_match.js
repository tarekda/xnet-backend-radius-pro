const { AppDataSource } = require('./dist/db/config');
const { fetchUnpaidCandidatesForCollectorName, resolveUnpaidExternalInvoicesForCollectorName } = require('./dist/services/whatsappPaymentGroupService');

async function test() {
  await AppDataSource.initialize();

  const testNames = ["علي الشعار", "عماد شحني", "حسين احمد", "محمد حكيم"];
  for (const name of testNames) {
    console.log(`\n================ Testing '${name}' ================`);
    const candidates = await fetchUnpaidCandidatesForCollectorName(name);
    console.log(`Candidates count for '${name}':`, candidates.length);
    console.log(`Candidates:`, candidates.map(c => ({ id: c.id, fullName: c.fullName, username: c.username, status: c.status, billingMonth: c.billingMonth, amount: c.amount })));

    const resolved = await resolveUnpaidExternalInvoicesForCollectorName(name);
    console.log(`Resolved kind:`, resolved.kind);
    if (resolved.kind !== 'none') {
      console.log(`Resolved invoices:`, resolved.invoices.map(i => ({ id: i.id, fullName: i.fullName, username: i.username })));
    }
  }

  process.exit(0);
}

test().catch(console.error);
