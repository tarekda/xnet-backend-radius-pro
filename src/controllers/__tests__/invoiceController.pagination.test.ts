// The controller's import graph connects to RabbitMQ and Redis at module load.
// Mock those edges (with factories, so the real modules never execute) and the
// service this suite asserts against, keeping the test hermetic and fast.
jest.mock('../../services/invoiceService', () => ({
    getAllInvoices: jest.fn(),
    getAllExternalInvoices: jest.fn(),
    getCollectedInvoicesList: jest.fn(),
}));
jest.mock('../../events/invoiceEvents', () => ({
    invoiceEvents: { emitModification: jest.fn() },
}));
jest.mock('../../redisClient', () => ({ redisClient: {} }));

import type { Response } from 'express';
import {
    getAllExternalInvoices,
    getAllInvoices,
    getCollectedInvoicesList,
} from '../../services/invoiceService';
import {
    getCollectedInvoicesListHandler,
    getExternalInvoicesHandler,
    getInvoicesHandler,
} from '../invoiceController';

function fakeRes() {
    const res = {
        status: jest.fn(),
        json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res as unknown as Response;
}

function fakeReq(query: Record<string, unknown>) {
    return { query } as never;
}

describe('invoice list handlers clamp the page size', () => {
    it('caps an oversized limit on the invoice list', async () => {
        await getInvoicesHandler(fakeReq({ limit: '1000000' }), fakeRes());

        expect(getAllInvoices).toHaveBeenCalledWith(1, 500, '', undefined, undefined);
    });

    it('caps an oversized limit on the collected invoice list', async () => {
        await getCollectedInvoicesListHandler(fakeReq({ limit: '1000000' }), fakeRes());

        expect(getCollectedInvoicesList).toHaveBeenCalledWith(1, 500, undefined, undefined);
    });

    it('caps an oversized limit on the external invoice list', async () => {
        await getExternalInvoicesHandler(fakeReq({ limit: '1000000' }), fakeRes());

        expect(getAllExternalInvoices).toHaveBeenCalledWith(
            1,
            500,
            '',
            undefined,
            undefined,
            undefined,
            'createdAt',
            'DESC',
            false,
            undefined,
            7,
            undefined,
            undefined
        );
    });

    it('floors a non-positive limit to 1 instead of passing it through', async () => {
        await getInvoicesHandler(fakeReq({ limit: '0' }), fakeRes());

        expect(getAllInvoices).toHaveBeenCalledWith(1, 1, '', undefined, undefined);
    });

    it('keeps a sensible limit untouched', async () => {
        await getInvoicesHandler(fakeReq({ limit: '25' }), fakeRes());

        expect(getAllInvoices).toHaveBeenCalledWith(1, 25, '', undefined, undefined);
    });
});
