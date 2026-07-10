const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: false,
  });
  const [t] = await c.query("SHOW TABLES LIKE 'whish_payment_claims'");
  const [cols] = await c.query("SHOW COLUMNS FROM external_invoices LIKE 'payment_reference'");
  const [mig] = await c.query("SELECT id, timestamp, name FROM migrations ORDER BY id DESC LIMIT 8");
  console.log(JSON.stringify({ table: t, cols, mig }, null, 2));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
