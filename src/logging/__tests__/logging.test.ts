jest.mock('../../db/config', () => ({
    AppDataSource: { isInitialized: false, getRepository: jest.fn() },
}));

import winston from 'winston';
import Transport from 'winston-transport';
import { serializeMetaValue, Logger } from '../logging';

class CaptureTransport extends Transport {
    public entries: winston.Logform.TransformableInfo[] = [];

    log(info: winston.Logform.TransformableInfo, callback: () => void) {
        this.entries.push(info);
        callback();
    }
}

describe('serializeMetaValue', () => {
    it('converts Error instances into plain objects with name, message and stack', () => {
        const err = new Error('boom');
        const result = serializeMetaValue(err) as { name: string; message: string; stack?: string };

        expect(result.name).toBe('Error');
        expect(result.message).toBe('boom');
        expect(result.stack).toContain('boom');
    });

    it('passes non-error values through untouched', () => {
        expect(serializeMetaValue({ a: 1 })).toEqual({ a: 1 });
        expect(serializeMetaValue('text')).toBe('text');
    });
});

describe('logger error meta capture', () => {
    it('preserves error details passed as a second argument to logger.error', () => {
        const logger = Logger.getInstance();
        const capture = new CaptureTransport();
        logger.add(capture);

        try {
            logger.error('operation failed', new Error('db timeout'));

            expect(capture.entries).toHaveLength(1);
            const entry = capture.entries[0] as unknown as { message: string; meta?: { message?: string; stack?: string } };
            expect(entry.message).toContain('operation failed');
            expect(entry.message).toContain('db timeout');
            expect(entry.meta?.message).toBe('db timeout');
            expect(entry.meta?.stack).toContain('db timeout');
        } finally {
            logger.remove(capture);
        }
    });
});
