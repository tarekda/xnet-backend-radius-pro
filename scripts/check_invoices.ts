import { AppDataSource } from "../src/db/config";

async function run() {
  try {
    await AppDataSource.initialize();
    console.log("Database initialized successfully");

    // 1. Check whatsapp_inbound_messages table columns
    const columns = await AppDataSource.query("DESCRIBE whatsapp_inbound_messages");
    console.log("whatsapp_inbound_messages columns:", columns.map((c: any) => c.Field));

    // 2. Search for any invoices with these names
    const names = ["شعار", "علي", "شحني", "عماد", "حكيم", "حسين"];
    for (const n of names) {
      const invs = await AppDataSource.query(
        `SELECT id, fullName, username, status, billingMonth, totalAmount, amount, documentType, voidedAt, deletedAt 
         FROM external_invoices 
         WHERE fullName LIKE ? OR username LIKE ? 
         LIMIT 5`,
        [`%${n}%`, `%${n}%`]
      );
      console.log(`\nMatches for '${n}':`, invs);
    }

    // 3. Check distinct statuses in external_invoices
    const statuses = await AppDataSource.query(
      "SELECT DISTINCT status, documentType, COUNT(*) as cnt FROM external_invoices GROUP BY status, documentType"
    );
    console.log("\nDistinct statuses in external_invoices:", statuses);

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

run();
