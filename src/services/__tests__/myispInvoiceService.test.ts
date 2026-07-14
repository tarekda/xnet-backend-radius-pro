import { mapMyISPRows, parseMyISPCsv } from '../myispInvoiceService';

describe('MyISP invoice CSV mapping', () => {
  it('parses UTF-8 CSV with quoted commas and embedded newlines', () => {
    const csv = [
      '\uFEFFusername,userfname,userlname,email,mobile,phone,address,address2,building,sellingprice,planname,expirydate,password',
      'alice,"Alice, Marie",Smith,alice@example.com,70123456,01123456,"Main Street',
      'Apartment 4",Beirut,Blue Tower,45.50,Fiber Gold,2099-07-31,do-not-import',
    ].join('\n');

    const parsed = parseMyISPCsv(Buffer.from(csv, 'utf8'));

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].userfname).toBe('Alice, Marie');
    expect(parsed.rows[0].address).toBe('Main Street\nApartment 4');

    const result = mapMyISPRows(
      parsed.rows,
      parsed.headers,
      '2026-07-01',
      'admin'
    );

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]).toMatchObject({
      username: 'alice',
      fullName: 'Alice, Marie Smith',
      phoneNumber: '70123456',
      address: 'Main Street\nApartment 4 Beirut Blue Tower',
      provider: 'myisp',
      amount: 45.5,
      billingMonth: '2026-07-01',
      status: 'pending',
      debitLabel: 'fiber gold',
      modifiedBy: 'admin',
    });
    expect(result.preview.headers).not.toContain('password');
    expect(result.preview.rawPreview).toEqual([]);
    expect(JSON.stringify(result.preview)).not.toContain('do-not-import');
  });

  it('skips missing usernames and invalid amounts with preview issues', () => {
    const rows = [
      { username: '', sellingprice: '20', expirydate: '2099-08-31' },
      { username: 'bob', sellingprice: 'not-a-number', expirydate: '2099-08-31' },
      { username: 'blocked-user', sellingprice: '25', blockuser: '1' },
      { username: 'carol', sellingprice: '30', expirydate: '2099-08-31' },
    ];

    const result = mapMyISPRows(
      rows,
      ['username', 'sellingprice'],
      '2026-08-01'
    );

    expect(result.invoices.map((invoice) => invoice.username)).toEqual(['carol']);
    expect(result.preview).toMatchObject({
      sheetName: 'MyISP',
      totalRows: 4,
      validRowCount: 1,
      skippedRowCount: 3,
      rawPreview: [],
    });
    expect(result.preview.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, field: 'username', severity: 'error' }),
        expect.objectContaining({ row: 3, field: 'amount', severity: 'error' }),
        expect.objectContaining({ row: 4, field: 'blockuser', severity: 'warning' }),
      ])
    );
  });
});
