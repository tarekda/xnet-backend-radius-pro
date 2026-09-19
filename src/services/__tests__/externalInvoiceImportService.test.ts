jest.mock('../../db/config', () => ({
    AppDataSource: { getRepository: jest.fn() },
}));

import { AppDataSource } from '../../db/config';
import { UserDetails } from '../../db/entities/UserDetails';
import { importExternalInvoices } from '../externalInvoiceImportService';

type RepoStub = {
    find: jest.Mock;
    save: jest.Mock;
    softRemove: jest.Mock;
    findOne: jest.Mock;
};

function stubRepo(rows: unknown[] = []): RepoStub {
    return {
        find: jest.fn().mockResolvedValue(rows),
        save: jest.fn().mockImplementation(async (r: unknown) => r),
        softRemove: jest.fn().mockImplementation(async (r: unknown) => r),
        findOne: jest.fn().mockResolvedValue(null),
    };
}

describe('importExternalInvoices scoped lookups', () => {
    let externalRepo: RepoStub;
    let userDetailsRepo: RepoStub;

    beforeEach(() => {
        jest.clearAllMocks();
        externalRepo = stubRepo();
        userDetailsRepo = stubRepo();
        (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) =>
            entity === UserDetails ? userDetailsRepo : externalRepo
        );
    });

    it('bounds the pre-import lookup to the accounts in the batch, not the whole table', async () => {
        await importExternalInvoices({
            invoices: [
                { username: 'u1', amount: 10, billingMonth: '2026-07-01', provider: 'idm' },
                { username: 'U2', amount: 20, billingMonth: '2026-07-01', provider: 'idm' },
            ],
            skippedCount: 0,
        });

        const preImportLookup = externalRepo.find.mock.calls[0][0] as {
            where: Record<string, { objectLiteralParameters?: { usernames: string[] } }>;
        };
        expect(Object.keys(preImportLookup.where)).toEqual(
            expect.arrayContaining(['deletedAt', 'username'])
        );
        expect(preImportLookup.where.username.objectLiteralParameters?.usernames).toEqual(['u1', 'u2']);
    });

    it('skips the pre-import lookup entirely when no batch row has a username', async () => {
        await importExternalInvoices({
            invoices: [{ username: '  ', amount: 10, billingMonth: '2026-07-01', provider: 'idm' }],
            skippedCount: 0,
        });

        for (const [options] of externalRepo.find.mock.calls) {
            expect(options.where).not.toHaveProperty('username');
        }
    });
});
