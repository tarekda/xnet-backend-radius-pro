const { AppDataSource } = require('./dist/db/config');
const { ExternalInvoice } = require('./dist/db/entities/ExternalInvoice');
const { expandArabicSqlToken } = require('./dist/services/whatsappPaymentGroupService');

async function debugSql() {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(ExternalInvoice);

  const testName = "علي الشعار";
  const tokens = ["علي", "الشعار"];
  const searchTokens = tokens.length >= 2 ? [tokens[0], tokens[tokens.length - 1]] : tokens;

  const statuses = ["unpaid", "pending"];
  let qb = repo
    .createQueryBuilder("i")
    .where("LOWER(i.status) IN (:...statuses)", { statuses })
    .andWhere("i.voidedAt IS NULL")
    .andWhere("(i.documentType IS NULL OR i.documentType = :docType)", { docType: "invoice" });

  searchTokens.forEach((tok, idx) => {
    const variants = expandArabicSqlToken(tok);
    const parts = variants.flatMap((_, vIdx) => [
      `LOWER(i.fullName) LIKE :tok${idx}v${vIdx}`,
      `LOWER(i.username) LIKE :tok${idx}v${vIdx}`,
    ]);
    const params = {};
    variants.forEach((v, vIdx) => {
      params[`tok${idx}v${vIdx}`] = `%${v}%`;
    });
    qb = qb.andWhere(`(${parts.join(" OR ")})`, params);
  });

  console.log("SQL:", qb.getSql());
  console.log("PARAMS:", qb.getParameters());

  const results = await qb.getMany();
  console.log("RESULTS COUNT:", results.length);
  console.log("RESULTS:", results.map(r => ({ id: r.id, fullName: r.fullName, username: r.username, status: r.status, billingMonth: r.billingMonth })));

  process.exit(0);
}

debugSql().catch(console.error);
