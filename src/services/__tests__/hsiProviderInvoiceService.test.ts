import * as XLSX from 'xlsx';
import { mapHsiRows, parseHsiWorkbook } from '../hsiProviderInvoiceService';

describe('IDM/Terra invoice export mapping', () => {
  it('maps the shared HSI workbook schema and excludes passwords from preview', () => {
    const sheet = XLSX.utils.json_to_sheet([
      {
        Username: 'alice',
        Name: 'Alice Example',
        Password: 'do-not-expose',
        Address: 'Beirut',
        Mobile: '70123456',
        Expiry: '2099-07-31',
        Service: 'Fiber Gold',
        Price: '$45.50',
      },
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Users');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const parsed = parseHsiWorkbook(buffer);
    const result = mapHsiRows('idm', parsed.rows, parsed.headers, '2026-07-01', 'admin');

    expect(result.invoices[0]).toMatchObject({
      username: 'alice',
      fullName: 'Alice Example',
      phoneNumber: '70123456',
      provider: 'idm',
      amount: 45.5,
      payDueDate: '2099-07-31',
      billingMonth: '2026-07-01',
      debitLabel: 'fiber gold',
      modifiedBy: 'admin',
    });
    expect(result.preview.headers).not.toContain('Password');
    expect(result.preview.rawPreview).toEqual([]);
    expect(JSON.stringify(result.preview)).not.toContain('do-not-expose');
  });

  it('skips rows with missing usernames or invalid prices', () => {
    const result = mapHsiRows(
      'terra',
      [
        { Username: '', Price: 30, Expiry: '2099-07-31' },
        { Username: 'bob', Price: 'invalid', Expiry: '2099-07-31' },
        { Username: 'blocked-user', Price: 25, Blocked: 1 },
        { Username: 'carol', Price: 40, Expiry: '2099-07-31' },
      ],
      ['Username', 'Price'],
      '2026-07-01'
    );

    expect(result.invoices.map((invoice) => invoice.username)).toEqual(['carol']);
    expect(result.preview).toMatchObject({
      totalRows: 4,
      validRowCount: 1,
      skippedRowCount: 3,
    });
  });

  it('includes Terra accounts expiring today but excludes them for IDM', () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [{ Username: 'alice', Price: 30, Expiry: today, Blocked: 0 }];

    expect(mapHsiRows('terra', rows, ['Username', 'Price', 'Expiry'], '2026-07-01').invoices).toHaveLength(1);
    expect(mapHsiRows('idm', rows, ['Username', 'Price', 'Expiry'], '2026-07-01').invoices).toHaveLength(0);
  });
});
