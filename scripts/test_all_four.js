const { AppDataSource } = require('./dist/db/config');
const { resolveUnpaidExternalInvoicesForCollectorName } = require('./dist/services/whatsappPaymentGroupService');

async function testAll() {
  await AppDataSource.initialize();

  const testCases = [
    { name: "علي الشعار", amount: 35 },
    { name: "عماد شحني", amount: 40 },
    { name: "حسين احمد", amount: 35 },
    { name: "محمد حكيم", amount: 35 },
  ];

  for (const tc of testCases) {
    console.log(`\n================ Testing '${tc.name}' (amount: ${tc.amount}) ================`);
    const match = await resolveUnpaidExternalInvoicesForCollectorName(tc.name);
    console.log("Match Result:", {
      kind: match.kind,
      billingMonth: match.billingMonth,
      invoices: (match.invoices || []).map(i => ({
        id: i.id,
        fullName: i.fullName,
        username: i.username,
        amount: i.amount,
        status: i.status,
        billingMonth: i.billingMonth
      }))
    });
  }

  process.exit(0);
}

testAll().catch(console.error);
