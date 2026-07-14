import type { UserDetails } from '../../db/entities/UserDetails';
import { mapActiveRadiusUsers } from '../radiusInvoiceImportService';

describe('active RADIUS invoice mapping', () => {
  it('maps profile price and user details into external invoices', () => {
    const details = new Map<string, UserDetails>([
      [
        'alice',
        {
          username: 'alice',
          fullName: 'Alice Example',
          email: 'alice@example.com',
          phoneNumber: '70123456',
          address: 'Beirut',
        } as UserDetails,
      ],
    ]);

    const result = mapActiveRadiusUsers(
      [
        {
          username: 'alice',
          expiresAt: new Date('2099-07-31T23:59:59Z'),
          profile: { profileName: 'Fiber Gold', price: 45 },
        },
      ],
      details,
      '2026-07-01',
      'admin'
    );

    expect(result.preview).toMatchObject({
      sheetName: 'Active RADIUS users',
      totalRows: 1,
      validRowCount: 1,
      skippedRowCount: 0,
    });
    expect(result.invoices[0]).toMatchObject({
      username: 'alice',
      fullName: 'Alice Example',
      provider: 'radius',
      debitLabel: 'fiber gold',
      amount: 45,
      payDueDate: '2099-07-31',
      billingMonth: '2026-07-01',
      status: 'pending',
      modifiedBy: 'admin',
    });
  });

  it('skips users whose assigned profile price is invalid', () => {
    const result = mapActiveRadiusUsers(
      [{ username: 'alice', profile: null }],
      new Map(),
      '2026-07-01'
    );

    expect(result.invoices).toHaveLength(0);
    expect(result.preview.skippedRowCount).toBe(1);
    expect(result.preview.issues).toEqual([
      expect.objectContaining({ field: 'amount', severity: 'error' }),
    ]);
  });

  it('skips active-status rows whose expiry timestamp has passed', () => {
    const result = mapActiveRadiusUsers(
      [
        {
          username: 'expired-user',
          expiresAt: new Date('2000-01-01T00:00:00Z'),
          profile: { profileName: 'Plan', price: 30 },
        },
      ],
      new Map(),
      '2026-07-01'
    );

    expect(result.invoices).toHaveLength(0);
    expect(result.preview.issues).toEqual([
      expect.objectContaining({ field: 'expiresAt', severity: 'warning' }),
    ]);
  });
});
