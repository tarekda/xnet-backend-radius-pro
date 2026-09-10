const mysql = require('mysql2/promise');

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'host.docker.internal',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || process.env.DB_USER || 'radius',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'radius',
  });

  const [ali] = await conn.query("SELECT id, fullName, username, status, billingMonth, amount, deletedAt FROM external_invoices WHERE fullName LIKE '%شعار%' OR username = 'itnet48'");
  console.log("\n--- Ali Shaar ---", ali);

  const [emad] = await conn.query("SELECT id, fullName, username, status, billingMonth, amount, deletedAt FROM external_invoices WHERE fullName LIKE '%شحني%'");
  console.log("\n--- Emad Shehni ---", emad);

  const [hussein] = await conn.query("SELECT id, fullName, username, status, billingMonth, amount, deletedAt FROM external_invoices WHERE fullName LIKE '%حسين%احمد%' OR fullName LIKE '%احمد%حسين%'");
  console.log("\n--- Hussein Ahmad ---", hussein);

  const [hakim] = await conn.query("SELECT id, fullName, username, status, billingMonth, amount, deletedAt FROM external_invoices WHERE fullName LIKE '%محمد%حكيم%' OR fullName LIKE '%حكيم%محمد%'");
  console.log("\n--- Mohammad Hakim ---", hakim);

  await conn.end();
}

run().catch(console.error);
