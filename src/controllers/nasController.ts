import { Request, Response } from 'express';
import { AppDataSource } from '../db/config';
import { Nas } from '../db/entities/Nas';
import { body, validationResult } from 'express-validator';
import { redisClient } from "../redisClient";
import ping from "ping";

const sendResponse = (res: Response, success: boolean, status: number, message: string, data: any = null) => {
    res.status(status).json({ success, message, data });
};

const deleteCacheKeys = async () => {
    let tmpcursor = 0;
    do {
        const { cursor, keys }: { cursor: number; keys: string[]; } = await redisClient.scan(tmpcursor, {
            MATCH: "nas_*",
            COUNT: 100
        });
        tmpcursor = cursor;
        if (keys.length > 0) {
            await redisClient.del(keys);
        }
    } while (tmpcursor !== 0);
};

const checkNasStatus = async (ip: string): Promise<string> => {
    try {
        const res = await ping.promise.probe(ip, { timeout: 2 }); // 2-second timeout
        return res.alive ? "active" : "down";
    } catch (error) {
        return "down"; // If there's an error, assume NAS is down
    }
}

export const NasController = {
    getNasEntries: async (req: Request, res: Response) => {
        try {
            let page = parseInt(req.query.page as string) || 1;
            let limit = parseInt(req.query.limit as string) || 10;
            if (page < 1) page = 1;
            if (limit < 1) limit = 10;
            const offset = (page - 1) * limit;

            const cacheKey = `nas_page_${page}_limit_${limit}`;

            // Check Redis cache for NAS list (without status)
            const cachedResponse = await redisClient.get(cacheKey);
            let nasEntries;
            if (cachedResponse) {
                nasEntries = JSON.parse(cachedResponse);
            } else {
                const nasRepository = AppDataSource.getRepository(Nas);

                nasEntries = await nasRepository.find({
                    skip: offset,
                    take: limit,
                    order: { id: "ASC" },
                });

                // Store NAS entries in Redis (but not status)
                await redisClient.set(cacheKey, JSON.stringify(nasEntries), { EX: 3600 });
            }

            // Check live NAS status every time
            const nasWithStatus = await Promise.all(
                nasEntries.map(async (nas: Nas) => ({
                    ...nas,
                    status: await checkNasStatus(nas.nasname),
                }))
            );

            return sendResponse(res, true, 200, "NAS entries fetched successfully", {
                totalEntries: nasEntries.length,
                currentPage: page,
                limit,
                nasEntries: nasWithStatus,
            });
        } catch (error) {
            console.error("Error fetching NAS entries:", error);
            return sendResponse(res, false, 500, "Error fetching NAS entries");
        }
    },

    getNasEntry: async (req: Request, res: Response) => {
        try {
            const { id } = req.params;
            const cacheKey = `nas:${id}`;
            const cachedNas = await redisClient.get(cacheKey);
            if (cachedNas) {
                return sendResponse(res, true, 200, 'NAS entry fetched successfully', JSON.parse(cachedNas));
            }

            const nasRepository = AppDataSource.getRepository(Nas);
            const nasEntry = await nasRepository.findOne({ where: { id: Number(id) } });
            if (!nasEntry) {
                return sendResponse(res, false, 404, 'NAS entry not found');
            }

            await redisClient.set(cacheKey, JSON.stringify(nasEntry), { EX: 3600 });
            sendResponse(res, true, 200, 'NAS entry fetched successfully', nasEntry);
        } catch (error) {
            console.error(error);
            sendResponse(res, false, 500, 'Error fetching NAS entry');
        }
    },

    createNasEntry: [
        body('nasname').isString().notEmpty(),
        body('shortname').optional().isString(),
        body('type').optional().isString(),
        body('ports').optional().isInt(),
        body('secret').isString().notEmpty(),
        body('server').optional().isString(),
        body('community').optional().isString(),
        body('description').optional().isString(),
        async (req: Request, res: Response) => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendResponse(res, false, 400, 'Validation errors', errors.array());
            }

            try {
                const nasRepository = AppDataSource.getRepository(Nas);
                const newNas = nasRepository.create(req.body);
                await nasRepository.save(newNas);
                await deleteCacheKeys();
                sendResponse(res, true, 201, 'NAS entry created successfully', newNas);
            } catch (error) {
                console.error(error);
                sendResponse(res, false, 500, 'Error creating NAS entry');
            }
        }
    ],

    updateNasEntry: [
        body('nasname').optional().isString(),
        body('shortname').optional().isString(),
        body('type').optional().isString(),
        body('ports').optional().isInt(),
        body('secret').optional().isString(),
        body('server').optional().isString(),
        body('community').optional().isString(),
        body('description').optional().isString(),
        async (req: Request, res: Response) => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendResponse(res, false, 400, 'Validation errors', errors.array());
            }

            const { id } = req.params;
            try {
                const nasRepository = AppDataSource.getRepository(Nas);
                const nasEntry = await nasRepository.findOne({ where: { id: Number(id) } });
                if (!nasEntry) {
                    return sendResponse(res, false, 404, 'NAS entry not found');
                }

                nasRepository.merge(nasEntry, req.body);
                await nasRepository.save(nasEntry);
                await deleteCacheKeys();
                sendResponse(res, true, 200, 'NAS entry updated successfully', nasEntry);
            } catch (error) {
                console.error(error);
                sendResponse(res, false, 500, 'Error updating NAS entry');
            }
        }
    ],

    deleteNasEntry: async (req: Request, res: Response) => {
        const { id } = req.params;
        try {
            const nasRepository = AppDataSource.getRepository(Nas);
            const nasEntry = await nasRepository.findOne({ where: { id: Number(id) } });
            if (!nasEntry) {
                return sendResponse(res, false, 404, 'NAS entry not found');
            }

            await nasRepository.remove(nasEntry);
            await deleteCacheKeys();
            sendResponse(res, true, 200, 'NAS entry deleted successfully');
        } catch (error) {
            console.error(error);
            sendResponse(res, false, 500, 'Error deleting NAS entry');
        }
    }
};