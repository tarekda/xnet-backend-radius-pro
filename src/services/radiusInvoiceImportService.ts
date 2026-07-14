import { In } from 'typeorm';
import { AppDataSource } from '../db/config';
import type { ExternalInvoice } from '../db/entities/ExternalInvoice';
import { Raduserprofile } from '../db/entities/Raduserprofile';
import { UserDetails } from '../db/entities/UserDetails';
import type { ImportPreviewIssue, ImportPreviewResult } from './externalInvoiceImportParser';
import { normalizeDebitLabel } from './invoiceService';

export type RadiusInvoiceImportResult = {
  invoices: Partial<ExternalInvoice>[];
  preview: ImportPreviewResult;
};

type ActiveRadiusUser = Pick<Raduserprofile, 'username'> & {
  expiresAt?: Date | null;
  profile?: {
    profileName?: string | null;
    price?: number | null;
  } | null;
};

export function mapActiveRadiusUsers(
  users: ActiveRadiusUser[],
  detailsByUsername: Map<string, UserDetails>,
  billingMonth: string,
  actorUsername?: string
): RadiusInvoiceImportResult {
  const invoices: Partial<ExternalInvoice>[] = [];
  const issues: ImportPreviewIssue[] = [];

  users.forEach((user, index) => {
    const row = index + 1;
    const username = String(user.username ?? '').trim();
    if (user.expiresAt && new Date(user.expiresAt).getTime() <= Date.now()) {
      issues.push({
        row,
        field: 'expiresAt',
        message: 'Skipped expired user',
        severity: 'warning',
      });
      return;
    }
    const price = Number(user.profile?.price);
    if (!username) {
      issues.push({ row, field: 'username', message: 'Missing username', severity: 'error' });
    }
    if (!Number.isFinite(price)) {
      issues.push({ row, field: 'amount', message: 'Assigned profile has no valid price', severity: 'error' });
    }
    if (!username || !Number.isFinite(price)) return;

    const details = detailsByUsername.get(username.toLowerCase());
    const expiryPayDueDate = user.expiresAt
      ? new Date(user.expiresAt).toISOString().slice(0, 10)
      : null;
    invoices.push({
      username,
      fullName: details?.fullName?.trim() || '',
      email: details?.email?.trim() || '',
      phoneNumber: details?.phoneNumber?.trim() || '',
      address: details?.address?.trim() || null,
      provider: 'radius',
      amount: price,
      payDueDate: expiryPayDueDate,
      billingMonth,
      status: 'pending',
      debitLabel: normalizeDebitLabel(user.profile?.profileName),
      paidAt: null,
      modifiedBy: actorUsername,
      modifiedAt: new Date(),
      lastAction: 'UPLOAD',
    });
  });

  return {
    invoices,
    preview: {
      sheetName: 'Active RADIUS users',
      headers: ['username', 'fullName', 'profileName', 'price', 'phoneNumber'],
      suggestedMapping: {},
      rawPreview: [],
      mappedPreview: invoices.slice(0, 10),
      totalRows: users.length,
      issues: issues.slice(0, 50),
      validRowCount: invoices.length,
      skippedRowCount: users.length - invoices.length,
    },
  };
}

export async function fetchActiveRadiusInvoices(
  billingMonth: string,
  actorUsername?: string
): Promise<RadiusInvoiceImportResult> {
  const userProfileRepo = AppDataSource.getRepository(Raduserprofile);
  const userDetailsRepo = AppDataSource.getRepository(UserDetails);
  const users = await userProfileRepo.find({
    relations: ['profile'],
    where: { accountStatus: 'active' },
    order: { username: 'ASC' },
  });

  const usernames = users.map((user) => String(user.username ?? '').trim()).filter(Boolean);
  const details = usernames.length
    ? await userDetailsRepo.find({ where: { username: In(usernames) } })
    : [];
  const detailsByUsername = new Map(
    details.map((item) => [item.username.trim().toLowerCase(), item])
  );

  return mapActiveRadiusUsers(users, detailsByUsername, billingMonth, actorUsername);
}
