jest.mock('../../db/config', () => ({
    AppDataSource: { getRepository: jest.fn() },
}));
jest.mock('../../events/invoiceEvents', () => ({
    invoiceEvents: { emitModification: jest.fn() },
}));

import { AppDataSource } from '../../db/config';
import { invoiceEvents } from '../../events/invoiceEvents';
import { ExternalInvoice } from '../../db/entities/ExternalInvoice';
import {
    applyDefaultPayDueDates,
    inheritCarryoverLinesFromPriorMonth,
    inheritPayDueDatesFromPrior,
    isCarryoverDebitLabel,
    mergeDuplicateIncomingInvoices,
    normalizeBillingMonthKey,
    normalizeDebitLabel,
    previousBillingMonthKey,
    upsertExternalInvoices,
} from '../invoiceService';

function invoice(overrides: Partial<ExternalInvoice> = {}): ExternalInvoice {
    return {
        username: 'user1',
        email: '',
        address: null,
        amount: 25,
        status: 'pending',
        fullName: 'User One',
        phoneNumber: '',
        billingMonth: '2026-07-01',
        payDueDate: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        paidAt: null,
        paymentMethod: null,
        collectedBy: null,
        collectedAt: null,
        cashReconciled: false,
        reconciledBy: null,
        reconciledAt: null,
        lastAction: null,
        provider: 'idm',
        debitLabel: '',
        ...overrides,
    } as ExternalInvoice;
}

describe('normalizeDebitLabel', () => {
    it('lowercases, trims, and caps at 64 chars', () => {
        expect(normalizeDebitLabel('  CarryOver  ')).toBe('carryover');
        expect(normalizeDebitLabel('x'.repeat(100))).toHaveLength(64);
    });

    it('returns empty string for null/undefined', () => {
        expect(normalizeDebitLabel(null)).toBe('');
        expect(normalizeDebitLabel(undefined)).toBe('');
    });
});

describe('normalizeBillingMonthKey', () => {
    it('normalizes YYYY-MM and full dates to the first of the month', () => {
        expect(normalizeBillingMonthKey('2026-07')).toBe('2026-07-01');
        expect(normalizeBillingMonthKey('2026-07-19')).toBe('2026-07-01');
    });

    it('falls back to the current month for empty/invalid input', () => {
        const now = new Date();
        const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        expect(normalizeBillingMonthKey('')).toBe(expected);
        expect(normalizeBillingMonthKey('not-a-date')).toBe(expected);
    });
});

describe('previousBillingMonthKey', () => {
    it('steps back one month', () => {
        expect(previousBillingMonthKey('2026-07-01')).toBe('2026-06-01');
    });

    it('rolls over the year boundary', () => {
        expect(previousBillingMonthKey('2026-01-15')).toBe('2025-12-01');
    });
});

describe('isCarryoverDebitLabel', () => {
    it('matches carryover in any casing and ignores other labels', () => {
        expect(isCarryoverDebitLabel(' Carryover ')).toBe(true);
        expect(isCarryoverDebitLabel('second debit')).toBe(false);
        expect(isCarryoverDebitLabel(null)).toBe(false);
    });
});

describe('mergeDuplicateIncomingInvoices', () => {
    it('merges rows with same username/full name/month/provider/label by summing amounts', () => {
        const { invoices, merged } = mergeDuplicateIncomingInvoices([
            invoice({ amount: 10, payDueDate: '2026-07-10' }),
            invoice({ amount: 15, payDueDate: '2026-07-20' }),
        ]);
        expect(merged).toBe(1);
        expect(invoices).toHaveLength(1);
        expect(invoices[0].amount).toBe(25);
        expect(invoices[0].payDueDate).toBe('2026-07-20'); // latest due date wins
    });

    it('does not merge rows that differ by full name or debit label', () => {
        const { invoices, merged } = mergeDuplicateIncomingInvoices([
            invoice({ fullName: 'User One' }),
            invoice({ fullName: 'User Two' }),
            invoice({ debitLabel: 'carryover' }),
        ]);
        expect(merged).toBe(0);
        expect(invoices).toHaveLength(3);
    });

    it('backfills missing contact fields from later duplicates', () => {
        const { invoices } = mergeDuplicateIncomingInvoices([
            invoice({ email: '', phoneNumber: '', address: null }),
            invoice({ email: 'a@b.c', phoneNumber: '+96170123456', address: 'Beirut' }),
        ]);
        expect(invoices[0].email).toBe('a@b.c');
        expect(invoices[0].phoneNumber).toBe('+96170123456');
        expect(invoices[0].address).toBe('Beirut');
    });

    it('keeps a merged record open when any source row is unpaid', () => {
        const { invoices } = mergeDuplicateIncomingInvoices([
            invoice({ status: 'paid' }),
            invoice({ status: 'pending' }),
        ]);
        expect(invoices[0].status).toBe('pending');
    });

    it('preserves the first-seen order of records', () => {
        const { invoices } = mergeDuplicateIncomingInvoices([
            invoice({ username: 'b' }),
            invoice({ username: 'a' }),
            invoice({ username: 'b', amount: 5 }),
        ]);
        expect(invoices.map((i) => i.username)).toEqual(['b', 'a']);
    });
});

describe('inheritPayDueDatesFromPrior', () => {
    it('carries the due day-of-month forward from the latest prior line', () => {
        const incoming = [invoice({ billingMonth: '2026-07-01', payDueDate: null })];
        const existing = [
            invoice({ billingMonth: '2026-05-01', payDueDate: '2026-05-05' }),
            invoice({ billingMonth: '2026-06-01', payDueDate: '2026-06-18' }),
        ];
        const inherited = inheritPayDueDatesFromPrior(incoming, existing);
        expect(inherited).toBe(1);
        expect(incoming[0].payDueDate).toBe('2026-07-18');
    });

    it('does not override an incoming due date by default', () => {
        const incoming = [invoice({ payDueDate: '2026-07-03' })];
        const existing = [invoice({ billingMonth: '2026-06-01', payDueDate: '2026-06-18' })];
        expect(inheritPayDueDatesFromPrior(incoming, existing)).toBe(0);
        expect(incoming[0].payDueDate).toBe('2026-07-03');
    });

    it('clamps the inherited day to the last day of shorter months', () => {
        const incoming = [invoice({ billingMonth: '2026-02-01', payDueDate: null })];
        const existing = [invoice({ billingMonth: '2026-01-01', payDueDate: '2026-01-31' })];
        inheritPayDueDatesFromPrior(incoming, existing);
        expect(incoming[0].payDueDate).toBe('2026-02-28');
    });

    it('prefers a prior line with the same debit label', () => {
        const incoming = [invoice({ billingMonth: '2026-07-01', debitLabel: 'carryover', payDueDate: null })];
        const existing = [
            invoice({ billingMonth: '2026-06-01', debitLabel: '', payDueDate: '2026-06-10' }),
            invoice({ billingMonth: '2026-06-01', debitLabel: 'carryover', payDueDate: '2026-06-25' }),
        ];
        inheritPayDueDatesFromPrior(incoming, existing);
        expect(incoming[0].payDueDate).toBe('2026-07-25');
    });

    it('ignores soft-deleted prior rows and other accounts', () => {
        const incoming = [invoice({ billingMonth: '2026-07-01', payDueDate: null })];
        const existing = [
            invoice({ billingMonth: '2026-06-01', payDueDate: '2026-06-18', deletedAt: new Date() }),
            invoice({ username: 'someone-else', billingMonth: '2026-06-01', payDueDate: '2026-06-09' }),
        ];
        expect(inheritPayDueDatesFromPrior(incoming, existing)).toBe(0);
        expect(incoming[0].payDueDate).toBeNull();
    });
});

describe('inheritCarryoverLinesFromPriorMonth', () => {
    it('adds a pending carryover line when the prior month has an unpaid carryover', () => {
        const incoming = [invoice({ billingMonth: '2026-07-01' })];
        const existing = [
            invoice({ billingMonth: '2026-06-01', debitLabel: 'carryover', status: 'pending', amount: 40 }),
        ];
        const { invoices, added } = inheritCarryoverLinesFromPriorMonth(incoming, existing);
        expect(added).toBe(1);
        expect(invoices).toHaveLength(2);
        const carry = invoices[1];
        expect(carry.debitLabel).toBe('carryover');
        expect(carry.amount).toBe(40);
        expect(carry.status).toBe('pending');
        expect(carry.billingMonth).toBe('2026-07-01');
        expect(carry.lastAction).toBe('IMPORT_CARRYOVER');
    });

    it('does not add a line when the prior carryover was paid', () => {
        const incoming = [invoice({ billingMonth: '2026-07-01' })];
        const existing = [
            invoice({ billingMonth: '2026-06-01', debitLabel: 'carryover', status: 'paid', amount: 40 }),
        ];
        const { added } = inheritCarryoverLinesFromPriorMonth(incoming, existing);
        expect(added).toBe(0);
    });

    it('does not duplicate a carryover line already present in the import', () => {
        const incoming = [
            invoice({ billingMonth: '2026-07-01' }),
            invoice({ billingMonth: '2026-07-01', debitLabel: 'carryover', amount: 40 }),
        ];
        const existing = [
            invoice({ billingMonth: '2026-06-01', debitLabel: 'carryover', status: 'pending', amount: 40 }),
        ];
        const { invoices, added } = inheritCarryoverLinesFromPriorMonth(incoming, existing);
        expect(added).toBe(0);
        expect(invoices).toHaveLength(2);
    });

    it('adds at most one carryover line per account', () => {
        const incoming = [
            invoice({ billingMonth: '2026-07-01', debitLabel: '' }),
            invoice({ billingMonth: '2026-07-01', debitLabel: 'second debit', amount: 10 }),
        ];
        const existing = [
            invoice({ billingMonth: '2026-06-01', debitLabel: 'carryover', status: 'unpaid', amount: 15 }),
        ];
        const { invoices, added } = inheritCarryoverLinesFromPriorMonth(incoming, existing);
        expect(added).toBe(1);
        expect(invoices.filter((i) => i.debitLabel === 'carryover')).toHaveLength(1);
    });
});

describe('applyDefaultPayDueDates', () => {
    it('fills missing due dates as billing month start plus the offset', () => {
        const rows = [invoice({ billingMonth: '2026-07-01', payDueDate: null })];
        applyDefaultPayDueDates(rows, 14);
        expect(rows[0].payDueDate).toBe('2026-07-15');
    });

    it('leaves existing due dates and skips invalid offsets', () => {
        const rows = [invoice({ payDueDate: '2026-07-03' }), invoice({ payDueDate: null })];
        applyDefaultPayDueDates(rows, null);
        expect(rows[0].payDueDate).toBe('2026-07-03');
        expect(rows[1].payDueDate).toBeNull();
    });
});

describe('upsertExternalInvoices', () => {
    const getRepositoryMock = AppDataSource.getRepository as jest.Mock;

    function mockRepo(existingRows: ExternalInvoice[]) {
        const repo = {
            find: jest.fn().mockResolvedValue(existingRows),
            save: jest.fn().mockImplementation(async (rows: ExternalInvoice[]) => rows),
            softRemove: jest.fn().mockImplementation(async (rows: ExternalInvoice[]) => rows),
        };
        getRepositoryMock.mockReturnValue(repo);
        return repo;
    }

    it('inserts new rows and updates rows matching the composite key', async () => {
        const existing = invoice({ id: 7, amount: 20, status: 'pending' });
        const repo = mockRepo([existing]);

        const result = await upsertExternalInvoices([
            invoice({ amount: 30 }), // same composite key as existing -> update
            invoice({ username: 'newuser', amount: 12 }), // new -> insert
        ]);

        expect(result.inserted).toBe(1);
        expect(result.updated).toBe(1);
        expect(repo.save).toHaveBeenCalledTimes(1);
        const saved = repo.save.mock.calls[0][0] as ExternalInvoice[];
        expect(saved).toHaveLength(2);
        expect(saved[0].id).toBe(7);
        expect(saved[0].amount).toBe(30);
    });

    it('folds duplicate composite keys within one batch into a single record', async () => {
        const repo = mockRepo([]);

        const result = await upsertExternalInvoices([
            invoice({ amount: 10, payDueDate: '2026-07-05' }),
            invoice({ amount: 15, payDueDate: '2026-07-25' }),
        ]);

        expect(result.inserted).toBe(1);
        const saved = repo.save.mock.calls[0][0] as ExternalInvoice[];
        expect(saved).toHaveLength(1);
        expect(saved[0].amount).toBe(25);
        expect(saved[0].payDueDate).toBe('2026-07-25');
    });

    it('never downgrades an existing paid row back to unpaid', async () => {
        const paidAt = new Date('2026-07-02T10:00:00Z');
        const existing = invoice({ id: 3, status: 'paid', paidAt, paymentMethod: 'cash' });
        const repo = mockRepo([existing]);

        await upsertExternalInvoices([invoice({ status: 'pending', amount: 99 })]);

        const saved = repo.save.mock.calls[0][0] as ExternalInvoice[];
        expect(saved[0].status).toBe('paid');
        expect(saved[0].paidAt).toBe(paidAt);
        expect(saved[0].paymentMethod).toBe('cash');
    });

    it('skips rows without a username', async () => {
        const repo = mockRepo([]);
        const result = await upsertExternalInvoices([invoice({ username: '  ' })]);
        expect(result.inserted).toBe(0);
        expect(repo.save).not.toHaveBeenCalled();
    });

    it('soft-removes rows in scoped months missing from the import', async () => {
        const stale = invoice({ id: 5, username: 'gone-user' });
        const kept = invoice({ id: 6, username: 'kept-user' });
        const otherMonth = invoice({ id: 9, username: 'other', billingMonth: '2026-06-01' });
        const repo = mockRepo([stale, kept, otherMonth]);

        const result = await upsertExternalInvoices(
            [invoice({ username: 'kept-user' })],
            { scopedBillingMonths: ['2026-07-01'], actorUsername: 'admin' }
        );

        expect(result.removedFromScope).toBe(1);
        const removed = repo.softRemove.mock.calls[0][0] as ExternalInvoice[];
        expect(removed.map((r) => r.id)).toEqual([5]);
        expect(removed[0].deletedBy).toBe('admin');
        expect(invoiceEvents.emitModification).toHaveBeenCalledWith(
            expect.objectContaining({ invoiceId: 5, action: 'DELETED', username: 'admin' })
        );
    });

    it('limits stale-row removal to explicitly scoped providers', async () => {
        const staleMyISP = invoice({ id: 10, username: 'old-myisp', provider: 'myisp' });
        const keptMyISP = invoice({ id: 11, username: 'current-myisp', provider: 'myisp' });
        const otherProvider = invoice({ id: 12, username: 'idm-user', provider: 'idm' });
        const repo = mockRepo([staleMyISP, keptMyISP, otherProvider]);

        const result = await upsertExternalInvoices(
            [invoice({ username: 'current-myisp', provider: 'myisp' })],
            {
                scopedBillingMonths: ['2026-07-01'],
                scopedProviders: ['myisp'],
                actorUsername: 'admin',
            }
        );

        expect(result.removedFromScope).toBe(1);
        const removed = repo.softRemove.mock.calls[0][0] as ExternalInvoice[];
        expect(removed.map((row) => row.id)).toEqual([10]);
    });
});
