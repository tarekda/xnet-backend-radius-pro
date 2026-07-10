import { Request, Response } from 'express';
import { AppDataSource } from '../db/config';
import { Raduserprofile } from '../db/entities/Raduserprofile';
import { Radprofile } from '../db/entities/Radprofile';
import { body, validationResult } from 'express-validator';
import { redisClient } from "../redisClient"
import { UserMac } from '../db/entities/UserMac';
import { Radusagestats } from '../db/entities/Radusagestats';
import { Radcheck } from '../db/entities/Radcheck';
import { Logs } from '../db/entities/Logs';
import { promisify } from "util";
import { exec } from 'child_process';
import util from "util";
import radius from "radius";
import dgram from "dgram";
import eventBus from '../bus/eventBusSingleton';
import { CacheService } from '../services/cacheService';
import { QuotaService } from '../services/quotaServices';
import { bandwidthService } from '../services/bandwidthService';
import { recordSessionDisconnect } from '../metrics/metrics';
import { UserDetails } from '../db/entities/UserDetails';
import { SessionTracking } from '../db/entities/SessionTracking';
import { Invoices } from '../db/entities/Invoices';
import { Radacct } from '../db/entities/Radacct';
import { Nas } from '../db/entities/Nas';
import { parseDateOnlyField, sqlMonthlyCycleResetAt, sqlMonthlyCycleStart } from '../utils/quotaCycle';
import { getQuotaUsageForUsers } from '../utils/quotaUsage';
import { readOnlineSessionConfig, sqlRadacctIsOnline, sqlRadacctLastUpdate } from '../utils/onlineSessionPolicy';



const sendResponse = (res: Response, success: boolean, status: number, message: string, data: any = null) => {
    res.status(status).json({ success, message, data });
};

async function isFallbackProfileId(profileId: number): Promise<boolean> {
    if (!Number.isFinite(profileId) || profileId <= 0) return false;
    const profile = await AppDataSource.getRepository(Radprofile).findOne({ where: { id: profileId } as any });
    return String(profile?.profileName ?? "").trim().toLowerCase() === "fallback";
}

async function upsertUserDefaultProfileBestEffort(username: string, profileId: number): Promise<void> {
    try {
        if (!username || !Number.isFinite(profileId) || profileId <= 0) return;
        if (await isFallbackProfileId(profileId)) return;
        await AppDataSource.query(
            `
            INSERT INTO user_default_profiles (username, default_profile_id)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE default_profile_id = VALUES(default_profile_id);
            `,
            [username, profileId]
        );
    } catch (e: any) {
        // Don't fail user creation/update if table isn't present yet.
        console.warn("upsertUserDefaultProfile: skipped:", e?.message || e);
    }
}

async function upsertUserDefaultProfilesBulkBestEffort(usernames: string[], profileId: number): Promise<void> {
    try {
        if (!Array.isArray(usernames) || usernames.length === 0) return;
        if (!Number.isFinite(profileId) || profileId <= 0) return;
        if (await isFallbackProfileId(profileId)) return;

        // Keep query size reasonable
        const chunkSize = 200;
        for (let i = 0; i < usernames.length; i += chunkSize) {
            const chunk = usernames.slice(i, i + chunkSize).filter(Boolean);
            if (chunk.length === 0) continue;

            const values = chunk.map(() => "(?, ?)").join(", ");
            const params: any[] = [];
            for (const u of chunk) {
                params.push(u, profileId);
            }

            await AppDataSource.query(
                `
                INSERT INTO user_default_profiles (username, default_profile_id)
                VALUES ${values}
                ON DUPLICATE KEY UPDATE default_profile_id = VALUES(default_profile_id);
                `,
                params
            );
        }
    } catch (e: any) {
        console.warn("upsertUserDefaultProfilesBulk: skipped:", e?.message || e);
    }
}

function normalizeUsernames(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const cleaned = input
        .map((u) => String(u ?? "").trim())
        .filter((u) => u.length > 0)
        .map((u) => u.toLowerCase() === u ? u : u); // preserve exact value (no forced lowercasing)
    return Array.from(new Set(cleaned));
}

async function writeAuditLog(params: {
    req: Request;
    action: string;
    targetUsernames: string[];
    meta?: Record<string, any>;
}) {
    try {
        const repo = AppDataSource.getRepository(Logs);
        const entry = new Logs();
        entry.level = "info";
        entry.message = `audit.${params.action}`;
        entry.meta = {
            requestId: (params.req as any)?.requestId,
            actor: {
                id: (params.req.user as any)?.id ?? null,
                username: (params.req.user as any)?.username ?? null,
                role: (params.req.user as any)?.role ?? null,
                resellerId: (params.req.user as any)?.resellerId ?? null,
            },
            targets: params.targetUsernames,
            ...(params.meta ?? {}),
        };
        await repo.save(entry);
    } catch (e) {
        // Never fail the main request due to audit logging issues.
        console.warn("Audit log write failed", e);
    }
}

function getResellerFilter(req: Request): { isReseller: boolean; resellerId: number | null } {
    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    return { isReseller: role === "reseller" && !!resellerId, resellerId };
}

const deleteCacheKeys = async () => {
    try {
        // Patterns to match different types of user caches
        const patterns = [
            "users_page_*",      // For paginated user lists
            "users_status_*",    // For user online status
            "user:*",            // For individual user caches
            "user_search_*"      // For search results
        ];

        for (const pattern of patterns) {
            let tmpcursor = 0;
            do {
                const { cursor, keys }: { cursor: number; keys: string[]; } = await redisClient.scan(tmpcursor, {
                    MATCH: pattern,
                    COUNT: 100
                });

                tmpcursor = cursor;

                if (keys.length > 0) {
                    await redisClient.del(keys);
                }
            } while (tmpcursor !== 0);
        }
    } catch (error) {
        console.error("Error clearing cache:", error);
        throw new Error("Failed to clear cache");
    }
};

function parseExpiresAtField(input: unknown): Date | null {
  if (input === undefined || input === null || input === "") return null;
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) throw new Error("Invalid expiresAt");
  return d;
}

function parseExpiryFramedIpField(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  return String(input).trim().slice(0, 45);
}

/** Extend `from` by whole months (handles month-length edges e.g. Jan 31 +1 month). */
function addCalendarMonths(from: Date, months: number): Date {
    const d = new Date(from.getTime());
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() !== day) d.setDate(0);
    return d;
}

function formatUsersWithStatus(entities: any, raw: any) {
    return entities.map((user: any, index: number) => ({
        ...user,
        // TypeORM raw values may be boolean/number/string depending on driver
        isOnline: raw[index].isOnline === true || raw[index].isOnline === 1 || raw[index].isOnline === "1",
        // TypeORM raw aliases can vary depending on driver/casing; accept common shapes
        lastTimeActive:
            raw[index].lastTimeActive ??
            raw[index].lasttimeactive ??
            raw[index].last_time_active ??
            null,
    }));
}

async function getFreshUsersStatusMap(
    usernames: string[],
    staleCutoff: Date,
    activeCutoff: Date
): Promise<Record<string, { isOnline: boolean; lastTimeActive: any }>> {
    if (!Array.isArray(usernames) || usernames.length === 0) return {};

    const sessionRepo = AppDataSource.getRepository(SessionTracking);

    const rows = await sessionRepo
        .createQueryBuilder("st")
        .select("st.username", "username")
        .addSelect("MAX(CASE WHEN ra.acctsessionid IS NOT NULL THEN 1 ELSE 0 END)", "isOnline")
        .addSelect(
            "MAX(COALESCE(ra.acctupdatetime, ra.acctstarttime, st.last_update, st.start_time))",
            "lastTimeActive"
        )
        .leftJoin(
            "radacct",
            "ra",
            `ra.acctsessionid = st.session_id AND ${sqlRadacctIsOnline("ra")}`,
            { staleCutoff, activeCutoff }
        )
        .where("st.status = 'active'")
        .andWhere("st.username IN (:...usernames)", { usernames })
        .groupBy("st.username")
        .getRawMany<{ username: string; isOnline: any; lastTimeActive: any }>();

    return rows.reduce((acc, row) => {
        const username = row?.username;
        if (!username) return acc;
        acc[username] = {
            isOnline: row.isOnline === true || row.isOnline === 1 || row.isOnline === "1",
            lastTimeActive: row.lastTimeActive ?? null,
        };
        return acc;
    }, {} as Record<string, { isOnline: boolean; lastTimeActive: any }>);
}

function formatMikrotikRateLimitKbps(speedDown: number | null | undefined, speedUp: number | null | undefined): string {
    const down = typeof speedDown === "number" && Number.isFinite(speedDown) && speedDown > 0 ? Math.floor(speedDown) : 0;
    const up = typeof speedUp === "number" && Number.isFinite(speedUp) && speedUp > 0 ? Math.floor(speedUp) : 0;
    // Keep the same order as the MikroTik queue you reported: "download/upload"
    return `${down}k/${up}k`;
}

async function getActiveRadiusSession(username: string): Promise<{
    acctSessionId: string;
    nasIp: string;
    framedIp: string | null;
} | null> {
    const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

    const row = await AppDataSource.getRepository(Radacct)
        .createQueryBuilder("ra")
        .select([
            "ra.acctsessionid AS acctSessionId",
            "ra.nasipaddress AS nasIp",
            "ra.framedipaddress AS framedIp",
        ])
        .where("ra.username = :username", { username })
        .andWhere(sqlRadacctIsOnline("ra"))
        .orderBy(sqlRadacctLastUpdate("ra"), "DESC")
        .setParameters({ staleCutoff, activeCutoff })
        .getRawOne<{ acctSessionId: string; nasIp: string; framedIp: string | null }>();

    if (!row?.acctSessionId || !row?.nasIp) return null;
    return { acctSessionId: row.acctSessionId, nasIp: row.nasIp, framedIp: row.framedIp ?? null };
}


function parseBigIntSafe(v: any): bigint {
    try {
        if (typeof v === "bigint") return v;
        if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
        const s = String(v ?? "0").trim();
        if (!s.length) return BigInt(0);
        return BigInt(s);
    } catch {
        return BigInt(0);
    }
}

function withQuotaExceededFlags(users: any[]): Promise<any[]> {
    // Compute daily exceeded from today's usage vs profile.dailyQuota.
    // Compute monthly exceeded from current-window usage vs profile.monthlyQuota (for UI/reporting).
    const usernames = Array.isArray(users) ? users.map((u) => String(u?.username ?? "")).filter(Boolean) : [];
    if (usernames.length === 0) return Promise.resolve(users);

    return (async () => {
        const usageMap = await getQuotaUsageForUsers(usernames);
        return users.map((u) => {
            const username = String(u?.username ?? "");
            const usage = usageMap[username] ?? {
                dailyUsage: BigInt(0),
                monthlyUsage: BigInt(0),
                monthlyCycleStart: null,
                monthlyCycleResetAt: null,
            };
            const dailyQuota = parseBigIntSafe(u?.profile?.dailyQuota);
            const monthlyQuota = parseBigIntSafe(u?.profile?.monthlyQuota);
            const isDailyExceeded = usage.dailyUsage > dailyQuota;
            const isMonthlyExceededComputed = usage.monthlyUsage > monthlyQuota;
            const monthlyUsagePct =
                monthlyQuota > BigInt(0)
                    ? Math.min(100, Number((usage.monthlyUsage * BigInt(100)) / monthlyQuota))
                    : 0;
            return {
                ...u,
                dailyUsage: usage.dailyUsage.toString(),
                monthlyUsage: usage.monthlyUsage.toString(),
                monthlyCycleStart: usage.monthlyCycleStart,
                monthlyCycleResetAt: usage.monthlyCycleResetAt,
                monthlyUsagePct,
                isDailyExceeded,
                isMonthlyExceededComputed,
            };
        });
    })();
}


export const UserController = {
    quotaService: new QuotaService(AppDataSource, eventBus, new CacheService()),
    getRadUsers: async (req: Request, res: Response) => {
        try {
            const { isReseller, resellerId } = getResellerFilter(req);
            // 🔹 Get pagination parameters
            let page = parseInt(req.query.page as string) || 1;
            let limit = parseInt(req.query.pageSize as string) || 10;
            if (page < 1) page = 1;
            if (limit < 1) limit = 10;
            const offset = (page - 1) * limit;

            const scope = isReseller ? `reseller_${resellerId}` : "global";
            const cacheKey = `users_page_${scope}_${page}_limit_${limit}`;
            const statusCacheKey = `users_status_${scope}_${page}_limit_${limit}`;

            // Keep "online" consistent with OnlineUsers:
            // treat sessions as online only if we saw a recent radacct update.
            const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

            // 🔹 Check Redis cache for user data
            const cachedResponse = await redisClient.get(cacheKey);

            // If the user list is cached, still refresh the status from DB so UI stays in sync.
            if (cachedResponse) {
                const userData = JSON.parse(cachedResponse);
                const users = Array.isArray(userData?.users) ? userData.users : [];
                const usernames = users.map((u: any) => u?.username).filter(Boolean);

                const freshStatus = await getFreshUsersStatusMap(usernames, staleCutoff, activeCutoff);

                const enrichedUsers = await withQuotaExceededFlags(
                    users.map((user: any) => ({
                        ...user,
                        isOnline: !!freshStatus[user.username]?.isOnline,
                        lastTimeActive: freshStatus[user.username]?.lastTimeActive ?? user.lastTimeActive ?? null,
                    }))
                );

                const mergedData = {
                    ...userData,
                    users: enrichedUsers,
                };

                return sendResponse(res, true, 200, "Users fetched successfully", mergedData);
            }

            const userRepository = AppDataSource.getRepository(Raduserprofile);

            // 🔹 Count total users for pagination
            const totalUsersQb = userRepository.createQueryBuilder("user");
            if (isReseller) totalUsersQb.andWhere("user.ownerResellerId = :rid", { rid: resellerId });
            const totalUsers = await totalUsersQb.getCount();

            // 🔹 Fetch users with profile relation and left join UserMac
            // Keep "online" consistent with the OnlineUsers page:
            // a user is online only if there is an active SessionTracking row AND a corresponding
            // radacct session with a recent update (prevents stale "online" forever).
            const qb = userRepository
                .createQueryBuilder("user")
                .leftJoinAndSelect("user.profile", "profile")
                .leftJoinAndMapOne(
                    "user.macAddress",
                    UserMac,
                    "mac",
                    "user.username = mac.username"
                )
                .leftJoinAndMapOne(
                    "user.password",
                    Radcheck,
                    "radcheck",
                    "user.username = radcheck.username AND radcheck.attribute = 'Cleartext-Password'"
                )
                .leftJoinAndMapOne(
                    "user.userDetails",
                    UserDetails,
                    "userDetails",
                    "user.username = userDetails.username"
                )
                .leftJoin(
                    (qb) =>
                        qb
                            .from(SessionTracking, "st")
                            .select([
                                "st.username AS st_username",
                                // Online = there exists an active session with a matching open radacct row
                                // that has been updated recently (acctupdatetime/starttime within staleCutoff).
                                "MAX(CASE WHEN ra.acctsessionid IS NOT NULL THEN 1 ELSE 0 END) AS is_online",
                                "MAX(COALESCE(ra.acctupdatetime, ra.acctstarttime, st.last_update, st.start_time)) AS last_online_ping",
                            ])
                            .where("st.status = 'active'")
                            .leftJoin(
                                "radacct",
                                "ra",
                                `ra.acctsessionid = st.session_id AND ${sqlRadacctIsOnline("ra")}`,
                                { staleCutoff, activeCutoff }
                            )
                            .groupBy("st.username"),
                    "activeSess",
                    "user.username = activeSess.st_username"
                )
                .leftJoin(
                    (qb) =>
                        qb
                            .from(SessionTracking, "st2")
                            .select([
                                "st2.username AS la_username",
                                "MAX(COALESCE(st2.last_update, st2.end_time, st2.start_time)) AS last_time_active",
                            ])
                            .groupBy("st2.username"),
                    "lastActive",
                    "user.username = lastActive.la_username"
                )
                .select([
                    "user.id",
                    "user.username",
                    "user.profileId",
                    "user.freenight",
                    "user.isFallback",
                    "user.isMonthlyExceeded",
                    "user.quotaResetDay",
                    "user.quotaCycleStartDate",
                    "user.accountStatus",
                    "user.expiresAt",
                    "user.expiryFramedIp",
                    "profile.id",
                    "profile.profileName",
                    "profile.dailyQuota",
                    "profile.monthlyQuota",
                    "profile.speedDown",
                    "profile.speedUp",
                    "mac.macAddress",
                    "radcheck.value",
                    "userDetails.fullName",
                    "userDetails.address",
                    "userDetails.phoneNumber",
                    "userDetails.email",
                ])
                .addSelect(
                    "CASE WHEN COALESCE(activeSess.is_online, 0) = 1 THEN true ELSE false END",
                    "isOnline"
                )
                .addSelect(
                    "COALESCE(activeSess.last_online_ping, lastActive.last_time_active)",
                    "lastTimeActive"
                )
                .orderBy("user.id", "ASC")
                .limit(limit)
                .offset(offset)
                .setParameters({ staleCutoff, activeCutoff })
            
            if (isReseller) {
                qb.andWhere("user.ownerResellerId = :rid", { rid: resellerId });
            }

            const { entities, raw } = await qb.getRawAndEntities();

            const users = formatUsersWithStatus(entities, raw);
            const usersWithQuota = await withQuotaExceededFlags(users);

            if (usersWithQuota.length === 0) {
                return sendResponse(res, true, 200, "No users found", []);
            }

            // Create a status map for caching
            const statusMap = users.reduce((acc: any, user: any) => {
                acc[user.username] = { isOnline: user.isOnline, lastTimeActive: (user as any).lastTimeActive ?? null };
                return acc;
            }, {});

            // 🔹 Structure response with pagination metadata
            const responseData = {
                totalUsers,
                totalPages: Math.ceil(totalUsers / limit),
                currentPage: page,
                limit,
                users: usersWithQuota
            };

            // Cache user data for 1 hour
            await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 3600 });
            
            // Cache status data for only 30 seconds
            await redisClient.set(statusCacheKey, JSON.stringify(statusMap), { EX: 30 });

            return sendResponse(res, true, 200, "Users fetched successfully", responseData);
        } catch (error) {
            console.error("Error fetching users:", error);
            return sendResponse(res, false, 500, "Error fetching users");
        }
    },
    getRadUser: async (req: Request, res: Response) => {
        try {
            const { id } = req.params;
            const cacheKey = `user:${id}`;
            const cachedUser = await redisClient.get(cacheKey);
            if (cachedUser) {
                return sendResponse(res, true, 200, 'User fetched successfully', JSON.parse(cachedUser));
            }

            const userRepository = AppDataSource.getRepository(Raduserprofile);
            const user = await userRepository.findOne({ where: { id: Number(id) } });
            if (!user) {
                return sendResponse(res, false, 404, 'User not found');
            }

            await redisClient.set(cacheKey, JSON.stringify(user), { EX: 3600 }); // Cache for 1 hour
            sendResponse(res, true, 200, 'User fetched successfully', user);
        } catch (error) {
            console.error(error);
            sendResponse(res, false, 500, 'Error fetching user');
        }
    },
    createUser: [
        body('username').isString().notEmpty(),
        body('password').isString().notEmpty(),
        body('profileId').isInt().notEmpty(),
        body('accountStatus').optional().isString().isIn(["active", "suspended", "terminated", "expired"]),
        body('expiresAt').optional().isString(),
        body('expiryFramedIp').optional().isString(),
        body('freenight').optional().isBoolean(),
        body('quotaResetDay').isInt().optional(),
        body('quotaCycleStartDate').optional(),
        body('fullName').optional().isString(),
        body('address').isString().optional(),
        body('phoneNumber').isString().optional(),
        body('email').optional().custom((value) => {
            if (value === '' || value === null || value === undefined) {
                return true; // Allow empty string, null, or undefined
            }
            if (typeof value === 'string' && value.trim().length > 0) {
                // Use a regex or a library like validator.js to check if it's a valid email
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (emailRegex.test(value)) {
                    return true;
                }
            }
            throw new Error('Invalid email');
        }), // Email is optional,
        async (req: Request, res: Response) => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendResponse(res, false, 400, 'Validation errors', errors.array());
            }

            const { username, password, profileId, accountStatus, freenight, quotaResetDay, quotaCycleStartDate, fullName, address, phoneNumber, email, expiresAt, expiryFramedIp } = req.body;
            try {
                const { isReseller, resellerId } = getResellerFilter(req);
                const userRepository = AppDataSource.getRepository(Raduserprofile);
                const existingUser = await userRepository.findOne({ where: { username } });
                const userDetailsRepository = AppDataSource.getRepository(UserDetails);

                if (existingUser) {
                    return sendResponse(res, false, 409, 'User already exists');
                }

                const radcheckRepository = AppDataSource.getRepository(Radcheck);
                if (await radcheckRepository.findOne({ where: { username } })) {
                    return sendResponse(res, false, 409, 'User already exists');
                }
                const radcheck = new Radcheck();
                radcheck.username = username;
                radcheck.attribute = 'Cleartext-Password';
                radcheck.op = ':=';
                radcheck.value = password;
                await radcheckRepository.save(radcheck);

                const user = new Raduserprofile();
                user.username = username;
                user.profileId = profileId;
                user.freenight = Boolean(freenight);
                user.isFallback = false;
                user.isMonthlyExceeded = false;
                user.quotaResetDay = quotaResetDay || new Date().getDate();
                if (quotaCycleStartDate !== undefined) {
                    if (quotaCycleStartDate === null || quotaCycleStartDate === "") {
                        user.quotaCycleStartDate = null;
                    } else {
                        try {
                            user.quotaCycleStartDate = parseDateOnlyField(quotaCycleStartDate)!.toISOString().slice(0, 10);
                        } catch {
                            return sendResponse(res, false, 400, "Invalid quotaCycleStartDate (use YYYY-MM-DD)");
                        }
                    }
                }
                user.accountStatus = (accountStatus || 'active') as any;
                if (expiresAt !== undefined && expiresAt !== null && expiresAt !== "") {
                    try {
                        user.expiresAt = parseExpiresAtField(expiresAt);
                    } catch {
                        return sendResponse(res, false, 400, "Invalid expiresAt (use ISO 8601 datetime)");
                    }
                }
                if (expiryFramedIp !== undefined && expiryFramedIp !== null && expiryFramedIp !== "") {
                    user.expiryFramedIp = parseExpiryFramedIpField(expiryFramedIp);
                }
                if (isReseller && resellerId) {
                    (user as any).ownerResellerId = resellerId;
                }
                await userRepository.save(user);
                await upsertUserDefaultProfileBestEffort(username, profileId);

                // Create UserDetails entity
                const userDetails = new UserDetails();
                userDetails.username = username;
                userDetails.fullName = fullName || null;
                userDetails.address = address || null;
                userDetails.phoneNumber = phoneNumber || null;
                userDetails.email = email || null;
                await userDetailsRepository.save(userDetails);

                await deleteCacheKeys(); // Invalidate cache
                await writeAuditLog({
                    req,
                    action: "users.create",
                    targetUsernames: [username],
                    meta: {
                        profileId,
                        accountStatus: user.accountStatus,
                        freenight: user.freenight,
                        quotaResetDay: user.quotaResetDay,
                        reseller: isReseller ? { resellerId } : null,
                    },
                });
                sendResponse(res, true, 201, 'User created successfully');
            } catch (error) {
                console.error(error);
                sendResponse(res, false, 500, 'Error creating user');
            }
        }
    ],
    updateUser: [
        body('username').isString().notEmpty(), // Username is required
        body('password').optional().isString().notEmpty(), // Password is optional
        body('profileId').optional().isInt(), // Profile ID is optional
        body('accountStatus').optional().isString().isIn(["active", "suspended", "terminated", "expired"]), // Validate account status
        body("expiresAt").optional(),
        body("expiryFramedIp").optional(),
        body('freenight').optional().isBoolean(), // Free-night toggle is optional
        body('quotaResetDay').optional().isInt({ min: 1, max: 31 }),
        body('quotaCycleStartDate').optional(),
        body('fullName').optional().isString(), // Full name is optional
        body('address').optional().isString(), // Address is optional
        body('phoneNumber').optional().isString(), // Phone number is optional
        body('email').optional().custom((value) => {
            if (value === '' || value === null || value === undefined) {
                return true; // Allow empty string, null, or undefined
            }
            if (typeof value === 'string' && value.trim().length > 0) {
                // Use a regex or a library like validator.js to check if it's a valid email
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (emailRegex.test(value)) {
                    return true;
                }
            }
            throw new Error('Invalid email');
        }), // Email is optional
        async (req: Request, res: Response) => {
            // Validate request data
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendResponse(res, false, 400, 'Validation errors', errors.array());
            }

            const { username, password, profileId, accountStatus, freenight, quotaResetDay, quotaCycleStartDate, fullName, address, phoneNumber, email, expiresAt, expiryFramedIp } = req.body;
            // Optional: force disconnect so user re-auths (drops session).
            // This is NOT the default because CoA is usually sufficient and avoids disruptions.
            const forceDisconnect =
                String((req.body as any)?.disconnect ?? req.query?.disconnect ?? "")
                    .trim()
                    .toLowerCase() === "true" ||
                String((req.body as any)?.disconnect ?? req.query?.disconnect ?? "")
                    .trim() === "1";

            try {
                const userRepository = AppDataSource.getRepository(Raduserprofile);
                const radcheckRepository = AppDataSource.getRepository(Radcheck);
                const userDetailsRepository = AppDataSource.getRepository(UserDetails);

                // 🔹 Check if the user exists in Raduserprofile
                const user = await userRepository.findOne({ where: { username } });
                if (!user) {
                    return sendResponse(res, false, 404, "User not found");
                }
                const oldProfileId = user.profileId;
                const oldAccountStatus = user.accountStatus;
                const oldFreenight = user.freenight;

                // 🔹 Update password if provided
                if (password) {
                    const radcheck = await radcheckRepository.findOne({ where: { username, attribute: "Cleartext-Password" } });
                    if (radcheck) {
                        radcheck.value = password;
                        await radcheckRepository.save(radcheck);
                    } else {
                        // If no password entry exists, create one
                        const newRadcheck = new Radcheck();
                        newRadcheck.username = username;
                        newRadcheck.attribute = "Cleartext-Password";
                        newRadcheck.op = ":=";
                        newRadcheck.value = password;
                        await radcheckRepository.save(newRadcheck);
                    }
                }

                // 🔹 Update profile details if provided
                if (profileId) user.profileId = profileId;
                if (accountStatus) user.accountStatus = accountStatus;
                if (freenight !== undefined) user.freenight = Boolean(freenight);
                if (quotaResetDay !== undefined && quotaResetDay !== null && quotaResetDay !== "") {
                    const day = Number(quotaResetDay);
                    if (!Number.isFinite(day) || day < 1 || day > 31) {
                        return sendResponse(res, false, 400, "quotaResetDay must be 1..31");
                    }
                    user.quotaResetDay = day;
                }
                if (quotaCycleStartDate !== undefined) {
                    if (quotaCycleStartDate === null || quotaCycleStartDate === "") {
                        user.quotaCycleStartDate = null;
                    } else {
                        try {
                            user.quotaCycleStartDate = parseDateOnlyField(quotaCycleStartDate)!.toISOString().slice(0, 10);
                        } catch {
                            return sendResponse(res, false, 400, "Invalid quotaCycleStartDate (use YYYY-MM-DD)");
                        }
                    }
                }
                if (expiresAt !== undefined) {
                    if (expiresAt === null || expiresAt === "") {
                        user.expiresAt = null;
                    } else {
                        try {
                            user.expiresAt = parseExpiresAtField(expiresAt);
                        } catch {
                            return sendResponse(res, false, 400, "Invalid expiresAt (use ISO 8601 datetime)");
                        }
                    }
                }
                if (expiryFramedIp !== undefined) {
                    user.expiryFramedIp =
                        expiryFramedIp === null || expiryFramedIp === ""
                            ? null
                            : parseExpiryFramedIpField(expiryFramedIp);
                }

                // Match FreeRADIUS: past expires_at + still active => expired (do not touch suspended/terminated).
                if (
                    user.expiresAt !== null &&
                    user.expiresAt.getTime() <= Date.now() &&
                    String(user.accountStatus ?? "").trim() === "active"
                ) {
                    user.accountStatus = "expired";
                }

                await userRepository.save(user); // Save updates

                if (expiresAt !== undefined && user.expiresAt !== null && user.expiresAt.getTime() <= Date.now()) {
                    void UserController.disconnectWithOpenSessionLookup(username).then((r) => {
                        if (!r.ok) {
                            console.warn(`[expiry-disconnect] after user update failed for ${username}:`, r.error);
                        }
                    });
                }

                if (typeof profileId === "number" && Number.isFinite(profileId) && profileId > 0 && profileId !== oldProfileId) {
                    await upsertUserDefaultProfileBestEffort(username, profileId);
                }

                // 🔹 Update or create user details
                let userDetails = await userDetailsRepository.findOne({ where: { username } });
                if (!userDetails) {
                    userDetails = new UserDetails();
                    userDetails.username = username;
                }

                if (fullName !== undefined) userDetails.fullName = fullName;
                if (address !== undefined) userDetails.address = address;
                if (phoneNumber !== undefined) userDetails.phoneNumber = phoneNumber;
                if (email !== undefined) userDetails.email = email;

                await userDetailsRepository.save(userDetails);

                // 🔹 Invalidate all cached user pages
                await deleteCacheKeys();

                // If profile changed (upgrade/downgrade), and the user was previously FUP,
                // we want to clear fallback flags IF their current usage is now below the NEW plan quotas,
                // and immediately apply the new plan speed via CoA (Option A).
                let profileChange: any = null;
                if (typeof profileId === "number" && Number.isFinite(profileId) && profileId > 0 && profileId !== oldProfileId) {
                    try {
                        const newProfile = await AppDataSource.getRepository(Radprofile).findOne({ where: { id: profileId } as any });
                        if (!newProfile) {
                            profileChange = { ok: false, error: "New profile not found" };
                        } else {
                            const usageMap = await getQuotaUsageForUsers([username]);
                            const usage = usageMap[username] ?? { dailyUsage: BigInt(0), monthlyUsage: BigInt(0) };

                            const dailyQuota = parseBigIntSafe((newProfile as any).dailyQuota);
                            const monthlyQuota = parseBigIntSafe((newProfile as any).monthlyQuota);

                            // Match existing RADIUS checks which use `>` (not >=) for exceeded.
                            const dailyExceeded = usage.dailyUsage > dailyQuota;
                            const monthlyExceeded = usage.monthlyUsage > monthlyQuota;
                            const exceeded = dailyExceeded || monthlyExceeded;

                            if (!exceeded) {
                                // Clear fallback flags so backend + UI reflect that the user is no longer FUP.
                                await userRepository.update(
                                    { username },
                                    { isFallback: false, isMonthlyExceeded: false } as any
                                );
                                // Apply the NEW speed to the active session via CoA (no disconnect).
                                const coa = await UserController.applyProfileRateLimit(username);
                                const disconnect = forceDisconnect ? await UserController.disconnectUser(username) : null;
                                profileChange = {
                                    ok: true,
                                    clearedFallback: true,
                                    dailyUsage: usage.dailyUsage.toString(),
                                    monthlyUsage: usage.monthlyUsage.toString(),
                                    dailyQuota: dailyQuota.toString(),
                                    monthlyQuota: monthlyQuota.toString(),
                                    coa,
                                    disconnect,
                                };
                            } else {
                                // Keep flags as-is (still exceeded under the new plan).
                                // Update monthly flag to match new-plan evaluation (helps UI consistency).
                                await userRepository.update(
                                    { username },
                                    { isMonthlyExceeded: monthlyExceeded } as any
                                );
                                profileChange = {
                                    ok: true,
                                    clearedFallback: false,
                                    dailyUsage: usage.dailyUsage.toString(),
                                    monthlyUsage: usage.monthlyUsage.toString(),
                                    dailyQuota: dailyQuota.toString(),
                                    monthlyQuota: monthlyQuota.toString(),
                                    reason: "usage still exceeds new quotas",
                                    disconnect: forceDisconnect ? await UserController.disconnectUser(username) : null,
                                };
                            }
                        }
                    } catch (e: any) {
                        profileChange = { ok: false, error: e?.message || String(e) };
                    }
                }

                // Audit: capture what changed (but never log password).
                await writeAuditLog({
                    req,
                    action: "users.update",
                    targetUsernames: [username],
                    meta: {
                        changed: {
                            profileId: typeof profileId === "number" && Number.isFinite(profileId) ? { from: oldProfileId, to: profileId } : null,
                            accountStatus: accountStatus ? { from: oldAccountStatus, to: accountStatus } : null,
                            freenight: freenight !== undefined ? { from: oldFreenight, to: Boolean(freenight) } : null,
                            userDetails: {
                                fullName: fullName !== undefined ? true : null,
                                address: address !== undefined ? true : null,
                                phoneNumber: phoneNumber !== undefined ? true : null,
                                email: email !== undefined ? true : null,
                            },
                        },
                        forceDisconnect,
                        profileChange: profileChange ?? null,
                    },
                });

                return sendResponse(res, true, 200, "User updated successfully", profileChange ? { profileChange } : null);
            } catch (error) {
                console.error(error);
                return sendResponse(res, false, 500, "Error updating user");
            }
        }
    ],
    deleteUser: async (req: Request, res: Response) => {
        const { username } = req.params;
        try {
            const userRepository = AppDataSource.getRepository(Raduserprofile);
            const radcheckRepository = AppDataSource.getRepository(Radcheck);
            const userDetailsRepository = AppDataSource.getRepository(UserDetails);
            const invoiceRepository = AppDataSource.getRepository(Invoices);

            // First find the user to get their ID
            const user = await userRepository.findOne({ where: { username } });
            if (!user) {
                return sendResponse(res, false, 404, 'User not found');
            }

            // Delete related invoices first
            await invoiceRepository
                .createQueryBuilder()
                .delete()
                .where("user_profile_id = :userId", { userId: user.id })
                .execute();

            // Remove user from UserDetails
            const userDetails = await userDetailsRepository.findOne({ where: { username } });
            if (userDetails) {
                await userDetailsRepository.remove(userDetails);
            }

            // Remove user from Raduserprofile
            await userRepository.remove(user);

            // Remove user from Radcheck
            const radcheck = await radcheckRepository.findOne({ where: { username } });
            if (radcheck) {
                await radcheckRepository.remove(radcheck);
            }

            await deleteCacheKeys();
            await redisClient.del(`user:${username}`); // Invalidate individual user cache
            await writeAuditLog({
                req,
                action: "users.delete",
                targetUsernames: [username],
                meta: { deleted: true },
            });
            sendResponse(res, true, 200, 'User deleted successfully');
        } catch (error) {
            console.error('Error deleting user:', error);
            sendResponse(res, false, 500, 'Error deleting user');
        }
    },
    resetMacAddress: async (req: Request, res: Response) => {
        const { username } = req.params;
        try {
            const userMacRepository = AppDataSource.getRepository(UserMac);
            const userMac = await userMacRepository.findOne({ where: { username } });
            if (!userMac) {
                return sendResponse(res, false, 404, 'MAC address not found for the user');
            }
            await userMacRepository.remove(userMac);
            await deleteCacheKeys();
            await redisClient.del(`user:${username}`); // Invalidate individual user cache
            await writeAuditLog({
                req,
                action: "users.resetMac",
                targetUsernames: [username],
                meta: { deleted: true },
            });
            sendResponse(res, true, 200, 'MAC address reset successfully');
        } catch (error) {
            console.error(error);
            sendResponse(res, false, 500, 'Error resetting MAC address');
        }
    },
    resetDailyQuota: async (req: Request, res: Response) => {
        const { username } = req.params;
        try {
            await UserController.quotaService.resetDailyQuota(username);
            await writeAuditLog({
                req,
                action: "users.resetDailyQuota",
                targetUsernames: [username],
            });
            sendResponse(res, true, 200, `✅ Daily quota reset successfully for ${username}`);
        } catch (error) {
            console.error(`❌ Error resetting daily quota for ${username}:`, error);
            sendResponse(res, false, 500, 'Error resetting daily quota');
        }
    },
    resetMonthlyQuota: async (req: Request, res: Response) => {
        const { username } = req.params;
        try {
            await UserController.quotaService.resetMonthlyQuota(username);
            await writeAuditLog({
                req,
                action: "users.resetMonthlyQuota",
                targetUsernames: [username],
            });
            sendResponse(res, true, 200, `✅ Monthly quota reset successfully for ${username}`);
        } catch (error) {
            console.error(`❌ Error resetting monthly quota for ${username}:`, error);
            sendResponse(res, false, 500, 'Error resetting monthly quota');
        }
    },
    changeUserProfile: async (req: Request, res: Response) => { },
    // Disconnect a user from MikroTik so they re-auth and get their normal profile again.
    // Prefer RouterOS API (PPPoE/Hotspot). The legacy radclient flow (nasIp/secret) is kept only for backwards compat.
    disconnectUser: async (
        username: string,
        nasIp?: string,
        secret?: string,
        port?: number
    ): Promise<
        | { ok: true; method: "mikrotik-api"; result: { pppRemoved: number; hotspotRemoved: number } }
        | { ok: true; method: "radclient"; stdout: string; stderr: string }
        | { ok: false; method: "none" | "radclient"; error: string; stdout?: string; stderr?: string }
    > => {
        type DisconnectResult =
            | { ok: true; method: "mikrotik-api"; result: { pppRemoved: number; hotspotRemoved: number } }
            | { ok: true; method: "radclient"; stdout: string; stderr: string }
            | { ok: false; method: "none" | "radclient"; error: string; stdout?: string; stderr?: string };
        const finish = (result: DisconnectResult): DisconnectResult => {
            recordSessionDisconnect(result.method, result.ok ? "ok" : "error");
            return result;
        };

        const withTimeout = async <T,>(p: Promise<T>, ms: number, label: string): Promise<T> => {
            let t: NodeJS.Timeout | undefined;
            try {
                return await Promise.race([
                    p,
                    new Promise<T>((_resolve, reject) => {
                        t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
                    }),
                ]);
            } finally {
                if (t) clearTimeout(t);
            }
        };

        let apiResult: { pppRemoved: number; hotspotRemoved: number } | null = null;
        try {
            // RouterOS API can hang if the device is unreachable; hard-timeout it.
            apiResult = await withTimeout(bandwidthService.disconnectUser(username), 5000, "mikrotik disconnect");
            // If we actually removed something, treat as success and stop here.
            if ((apiResult.pppRemoved || 0) + (apiResult.hotspotRemoved || 0) > 0) {
                console.log(`✅ Disconnected ${username} via MikroTik API`, apiResult);
                return finish({ ok: true, method: "mikrotik-api", result: apiResult });
            }
            // No active entry found via API. Fall back to DM if we have NAS info.
            console.warn(`⚠️ MikroTik API did not find an active session for ${username} (pppRemoved=0, hotspotRemoved=0). Will try Disconnect-Request if possible.`);
        } catch (err: any) {
            console.warn(`⚠️ MikroTik API disconnect failed for ${username}:`, err?.message || err);
        }

        // Legacy fallback: send RADIUS Disconnect-Request (requires nasIp + shared secret)
        if (!nasIp || !secret) {
            const hint = apiResult
                ? "MikroTik API found no active entry"
                : "MikroTik API failed/unavailable";
            const error = `Cannot disconnect ${username}: missing nasIp/secret and ${hint}`;
            console.error(`❌ ${error}`);
            return finish({ ok: false, method: "none", error });
        }

        const coaPort = typeof port === "number" && Number.isFinite(port) ? port : 3799; // MikroTik default for CoA/DM

        // First try radclient if available (fast + proven).
        const execAsync = util.promisify(exec);
        const command = `echo "User-Name = ${username}" | radclient -x ${nasIp}:${coaPort} disconnect ${secret}`;

        try {
            // radclient can also hang depending on network; hard-timeout it.
            const { stdout, stderr } = await execAsync(command, { timeout: 5000 });
            if (stderr && stderr.trim().length) {
                console.warn(`⚠️ radclient stderr for ${username}:`, stderr);
            }
            console.log(`✅ User ${username} disconnected via radclient`, { nasIp, coaPort });
            return finish({ ok: true, method: "radclient", stdout: stdout ?? "", stderr: stderr ?? "" });
        } catch (err: any) {
            const error = err?.message || String(err);
            const stderr = String(err?.stderr ?? "");

            // If radclient binary is missing in the runtime image, fall back to a native UDP Disconnect-Request.
            const looksLikeMissingRadclient =
                /radclient:\s*not found/i.test(error) ||
                /radclient:\s*not found/i.test(stderr) ||
                /ENOENT/i.test(error);

            if (!looksLikeMissingRadclient) {
                console.error(`❌ Error disconnecting user ${username} via radclient:`, error);
                return finish({
                    ok: false,
                    method: "radclient",
                    error,
                    stdout: err?.stdout,
                    stderr: err?.stderr,
                });
            }

            try {
                // node-radius supports Disconnect-Request (RFC 5176).
                // We send to NAS CoA/DM port and wait briefly for ACK/NAK.
                const packet = radius.encode({
                    code: "Disconnect-Request",
                    secret,
                    identifier: Math.floor(Math.random() * 256),
                    attributes: [
                        ["User-Name", username],
                    ],
                });

                const sock = dgram.createSocket("udp4");
                const response = await new Promise<{ ok: boolean; msg: string }>((resolve) => {
                    const t = setTimeout(() => {
                        try { sock.close(); } catch { /* ignore */ }
                        resolve({ ok: true, msg: "Disconnect-Request sent (no response within timeout)" });
                    }, 1500);

                    sock.on("message", (buf) => {
                        clearTimeout(t);
                        try {
                            const decoded = radius.decode({ packet: buf, secret });
                            const code = decoded?.code || "Unknown";
                            try { sock.close(); } catch { /* ignore */ }
                            resolve({ ok: true, msg: `Received ${code}` });
                        } catch {
                            try { sock.close(); } catch { /* ignore */ }
                            resolve({ ok: true, msg: "Received response (decode failed)" });
                        }
                    });

                    sock.send(packet, coaPort, nasIp, (e) => {
                        if (e) {
                            clearTimeout(t);
                            try { sock.close(); } catch { /* ignore */ }
                            resolve({ ok: false, msg: e.message });
                        }
                    });
                });

                if (!response.ok) {
                    return finish({ ok: false, method: "none", error: `Disconnect UDP send failed: ${response.msg}` });
                }
                console.log(`✅ User ${username} disconnect via UDP`, { nasIp, coaPort, msg: response.msg });
                return finish({ ok: true, method: "radclient", stdout: response.msg, stderr: "" });
            } catch (e: any) {
                return finish({ ok: false, method: "none", error: `Disconnect fallback failed: ${e?.message || String(e)}` });
            }
        }
    },

    /** Latest open radacct row → NAS secret → disconnect (MikroTik API first, then Disconnect-Request). */
    disconnectWithOpenSessionLookup: async (
        username: string
    ): Promise<
        | { ok: true; method: "mikrotik-api"; result: { pppRemoved: number; hotspotRemoved: number } }
        | { ok: true; method: "radclient"; stdout: string; stderr: string }
        | { ok: false; method: "none" | "radclient"; error: string; stdout?: string; stderr?: string }
    > => {
        const usernameTrim = String(username || "").trim();
        if (!usernameTrim) {
            return { ok: false, method: "none", error: "Username is required" };
        }
        const raRepo = AppDataSource.getRepository(Radacct);
        const active = await raRepo
            .createQueryBuilder("ra")
            .select("ra.nasipaddress", "nasipaddress")
            .where("ra.username = :username", { username: usernameTrim })
            .andWhere("ra.acctstoptime IS NULL")
            .orderBy("ra.acctstarttime", "DESC")
            .limit(1)
            .getRawOne<{ nasipaddress?: string }>();
        const nasIp = String(active?.nasipaddress ?? "").trim() || undefined;
        let secret: string | undefined;
        if (nasIp) {
            const nas = await AppDataSource.getRepository(Nas).findOne({ where: { nasname: nasIp } as any });
            secret = nas?.secret;
        }
        return UserController.disconnectUser(usernameTrim, nasIp, secret);
    },

    // Apply current profile speed to an active session via MikroTik CoA (no disconnect).
    // This is the "Option A" fix for users stuck with a previous fallback dynamic queue rate.
    applyProfileRateLimit: async (
        username: string
    ): Promise<
        | { ok: true; method: "coa"; rateLimit: string; nasIp: string; acctSessionId: string; framedIp: string | null; stdout: string; stderr: string }
        | { ok: false; method: "none" | "radclient"; error: string; stdout?: string; stderr?: string }
    > => {
        // 1) Find an active (non-stale) RADIUS session for the user
        const sess = await getActiveRadiusSession(username);
        if (!sess) {
            return { ok: false, method: "none", error: `No active RADIUS session found for ${username}` };
        }

        // 2) Load user's current profile speeds
        const user = await AppDataSource.getRepository(Raduserprofile).findOne({
            where: { username },
            relations: { profile: true },
        });
        if (!user?.profile) {
            return { ok: false, method: "none", error: `User/profile not found for ${username}` };
        }
        const rateLimit = formatMikrotikRateLimitKbps(user.profile.speedDown, user.profile.speedUp);

        // 3) Resolve NAS shared secret
        const nas = await AppDataSource.getRepository(Nas).findOne({ where: { nasname: sess.nasIp } });
        if (!nas?.secret) {
            return { ok: false, method: "none", error: `NAS secret not found for NAS ${sess.nasIp}` };
        }

        // 4) Send CoA
        const execAsync = util.promisify(exec);
        const coaPort = 3799; // MikroTik default for CoA/DM

        // Quote Mikrotik-Rate-Limit value to avoid parsing issues.
        const payloadLines = [
            `User-Name = ${username}`,
            `Acct-Session-Id = ${sess.acctSessionId}`,
            `Mikrotik-Rate-Limit := \"${rateLimit}\"`,
        ];
        if (sess.framedIp) payloadLines.push(`Framed-IP-Address = ${sess.framedIp}`);
        const payload = payloadLines.join("\n");

        const command = `echo "${payload}" | radclient -x ${sess.nasIp}:${coaPort} coa ${nas.secret}`;

        try {
            const { stdout, stderr } = await execAsync(command, { timeout: 5000 });
            return {
                ok: true,
                method: "coa",
                rateLimit,
                nasIp: sess.nasIp,
                acctSessionId: sess.acctSessionId,
                framedIp: sess.framedIp,
                stdout: stdout ?? "",
                stderr: stderr ?? "",
            };
        } catch (err: any) {
            const error = err?.message || String(err);
            return {
                ok: false,
                method: "radclient",
                error,
                stdout: err?.stdout,
                stderr: err?.stderr,
            };
        }
    },

    // HTTP handler: apply current profile rate-limit via CoA
    applyProfileRateLimitNow: async (req: Request, res: Response) => {
        const username = String(req.params.username || "").trim();
        if (!username) return sendResponse(res, false, 400, "Username is required");

        try {
            const result = await UserController.applyProfileRateLimit(username);
            if (!result.ok) return sendResponse(res, false, 400, "Failed to apply rate-limit", result);
            return sendResponse(res, true, 200, "Rate-limit applied", result);
        } catch (e: any) {
            console.error("applyProfileRateLimitNow failed:", e);
            return sendResponse(res, false, 500, "Error applying rate-limit", { error: e?.message || String(e) });
        }
    },

    renewSubscription: [
        body("months").optional().isInt({ min: 1, max: 36 }),
        async (req: Request, res: Response) => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendResponse(res, false, 400, "Validation errors", errors.array());
            }
            const username = String(req.params.username || "").trim();
            if (!username) return sendResponse(res, false, 400, "Username is required");

            const monthsRaw = (req.body as any)?.months;
            const months =
                monthsRaw === undefined || monthsRaw === null || monthsRaw === ""
                    ? 1
                    : parseInt(String(monthsRaw), 10);
            if (!Number.isFinite(months) || months < 1 || months > 36) {
                return sendResponse(res, false, 400, "months must be 1–36");
            }

            try {
                const { isReseller, resellerId } = getResellerFilter(req);
                const userRepository = AppDataSource.getRepository(Raduserprofile);
                const user = await userRepository.findOne({ where: { username } });
                if (!user) {
                    return sendResponse(res, false, 404, "User not found");
                }
                if (isReseller && resellerId && (user as any).ownerResellerId !== resellerId) {
                    return sendResponse(res, false, 404, "User not found");
                }

                const st = String(user.accountStatus ?? "").trim();
                if (st === "suspended" || st === "terminated") {
                    return sendResponse(res, false, 400, "Cannot renew: account is suspended or terminated");
                }

                const now = new Date();
                const pastExpiry = user.expiresAt !== null && user.expiresAt.getTime() < now.getTime();
                const isExpiredStatus = st === "expired";
                if (!isExpiredStatus && !pastExpiry) {
                    return sendResponse(
                        res,
                        false,
                        400,
                        "Subscription is not expired; extend expiry from the user form if needed"
                    );
                }

                const currentEnd = user.expiresAt ? new Date(user.expiresAt.getTime()) : null;
                const base =
                    currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
                user.expiresAt = addCalendarMonths(base, months);
                user.accountStatus = "active";

                await userRepository.save(user);
                await deleteCacheKeys();

                void UserController.disconnectWithOpenSessionLookup(username).then((r) => {
                    if (!r.ok) {
                        console.warn(`[renew] disconnect after renew failed for ${username}:`, r.error);
                    }
                });

                await writeAuditLog({
                    req,
                    action: "users.renew",
                    targetUsernames: [username],
                    meta: { months, newExpiresAt: user.expiresAt?.toISOString?.() ?? user.expiresAt },
                });

                return sendResponse(res, true, 200, "Subscription renewed", {
                    username,
                    expiresAt: user.expiresAt,
                    accountStatus: user.accountStatus,
                });
            } catch (e: any) {
                console.error("renewSubscription failed:", e);
                return sendResponse(res, false, 500, "Error renewing subscription", { error: e?.message || String(e) });
            }
        },
    ],

    searchUsers: async (req: Request, res: Response) => {
        try {
            const { query } = req.query;
            const { isReseller, resellerId } = getResellerFilter(req);

            console.log('Received search query:', query);

            if (!query) {
                return sendResponse(res, false, 400, 'Search query is required');
            }

            const userRepository = AppDataSource.getRepository(Raduserprofile);

            const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

            const qb = userRepository
                .createQueryBuilder("user")
                .leftJoinAndSelect("user.profile", "profile")
                .leftJoinAndMapOne(
                    "user.macAddress",
                    UserMac,
                    "mac",
                    "user.username = mac.username"
                )
                .leftJoinAndMapOne(
                    "user.password",
                    Radcheck,
                    "radcheck",
                    "user.username = radcheck.username AND radcheck.attribute = 'Cleartext-Password'"
                )
                .leftJoinAndMapOne(
                    "user.userDetails",
                    UserDetails,
                    "userDetails",
                    "user.username = userDetails.username"
                )
                .leftJoin(
                    (qb) =>
                        qb
                            .from(SessionTracking, "st")
                            .select([
                                "st.username AS st_username",
                                "MAX(CASE WHEN ra.acctsessionid IS NOT NULL THEN 1 ELSE 0 END) AS is_online",
                                "MAX(COALESCE(ra.acctupdatetime, ra.acctstarttime, st.last_update, st.start_time)) AS last_online_ping",
                            ])
                            .where("st.status = 'active'")
                            .leftJoin(
                                "radacct",
                                "ra",
                                `ra.acctsessionid = st.session_id AND ${sqlRadacctIsOnline("ra")}`,
                                { staleCutoff, activeCutoff }
                            )
                            .groupBy("st.username"),
                    "activeSess",
                    "user.username = activeSess.st_username"
                )
                .leftJoin(
                    (qb) =>
                        qb
                            .from(SessionTracking, "st2")
                            .select([
                                "st2.username AS la_username",
                                "MAX(COALESCE(st2.last_update, st2.end_time, st2.start_time)) AS last_time_active",
                            ])
                            .groupBy("st2.username"),
                    "lastActive",
                    "user.username = lastActive.la_username"
                )
                .addSelect(
                    "CASE WHEN COALESCE(activeSess.is_online, 0) = 1 THEN true ELSE false END",
                    "isOnline"
                )
                .addSelect(
                    "COALESCE(activeSess.last_online_ping, lastActive.last_time_active)",
                    "lastTimeActive"
                )
                .where("user.username LIKE :query", { query: `%${query}%` })
                .orWhere("userDetails.email LIKE :query", { query: `%${query}%` })
                .orWhere("userDetails.fullName LIKE :query", { query: `%${query}%` })
            
            // Apply reseller scoping (this will become (A OR B OR C) AND owner_reseller_id = rid)
            if (isReseller) qb.andWhere("user.ownerResellerId = :rid", { rid: resellerId });

            const { entities, raw } = await qb
                .select([
                    "user.id",
                    "user.username",
                    "user.profileId",
                    "user.freenight",
                    "user.isFallback",
                    "user.isMonthlyExceeded",
                    "user.quotaResetDay",
                    "user.quotaCycleStartDate",
                    "user.accountStatus",
                    "user.expiresAt",
                    "user.expiryFramedIp",
                    "user.ownerResellerId",
                    "profile.id",
                    "profile.profileName",
                    "profile.dailyQuota",
                    "profile.monthlyQuota",
                    "profile.speedDown",
                    "profile.speedUp",
                    "mac.macAddress",
                    "radcheck.value",
                    "userDetails.fullName",
                    "userDetails.address",
                    "userDetails.phoneNumber",
                    "userDetails.email",
                ])
                .orderBy("user.id", "ASC")
                .setParameters({ staleCutoff, activeCutoff })
                .getRawAndEntities();

            const users = formatUsersWithStatus(entities, raw);
            const usersWithQuota = await withQuotaExceededFlags(users);

            if (usersWithQuota.length === 0) {
                return sendResponse(res, true, 200, "No users found", []);
            }

            const responseData = {
                totalUsers: usersWithQuota.length,
                totalPages: 1,
                currentPage: 1,
                limit: usersWithQuota.length,
                users: usersWithQuota
            };

            return sendResponse(res, true, 200, "Users fetched successfully", responseData);
        } catch (error) {
            console.error("Error searching users:", error);
            return sendResponse(res, false, 500, "Error searching users");
        }
    },

    /**
     * Fleet-wide user metrics for the Users dashboard.
     * Unlike the paginated list, these counts cover ALL users (scoped to the
     * reseller when applicable), so KPI cards aren't limited to the current page.
     */
    getUsersMetrics: async (req: Request, res: Response) => {
        try {
            const { isReseller, resellerId } = getResellerFilter(req);
            const { staleCutoff, activeCutoff } = readOnlineSessionConfig();
            const userRepo = AppDataSource.getRepository(Raduserprofile);

            const scopedQb = () => {
                const qb = userRepo.createQueryBuilder("up");
                if (isReseller) qb.andWhere("up.ownerResellerId = :rid", { rid: resellerId });
                return qb;
            };

            const total = await scopedQb().getCount();

            const statusRows = (await scopedQb()
                .select("LOWER(COALESCE(NULLIF(TRIM(up.accountStatus), ''), 'unknown'))", "status")
                .addSelect("COUNT(*)", "cnt")
                .groupBy("status")
                .getRawMany()) as Array<{ status: string; cnt: string }>;
            const byStatus: Record<string, number> = {};
            for (const row of statusRows) {
                // Legacy rows use "disabled" where the UI says "inactive".
                const key = row.status === "disabled" ? "inactive" : row.status;
                byStatus[key] = (byStatus[key] ?? 0) + Number(row.cnt || 0);
            }

            const monthlyExceeded = await scopedQb()
                .andWhere("up.isMonthlyExceeded = 1")
                .getCount();

            const onlineQb = AppDataSource.getRepository(Radacct)
                .createQueryBuilder("ra")
                .select("COUNT(DISTINCT ra.username)", "cnt")
                .where(sqlRadacctIsOnline("ra"))
                .setParameters({ staleCutoff, activeCutoff });
            if (isReseller) {
                onlineQb
                    .innerJoin(Raduserprofile, "up", "up.username = ra.username")
                    .andWhere("up.ownerResellerId = :rid", { rid: resellerId });
            }
            const onlineRow = await onlineQb.getRawOne<{ cnt: string }>();
            const online = Number(onlineRow?.cnt ?? 0);

            // Trend: distinct users with accounting activity per day (last 14 days).
            const onlineDailyParams: any[] = isReseller ? [resellerId] : [];
            const onlineDaily = (await AppDataSource.query(
                `SELECT DATE(ra.acctstarttime) AS day, COUNT(DISTINCT ra.username) AS cnt
                 FROM radacct ra
                 ${isReseller ? "INNER JOIN raduserprofile up ON up.username = ra.username AND up.owner_reseller_id = ?" : ""}
                 WHERE ra.acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
                 GROUP BY DATE(ra.acctstarttime)
                 ORDER BY day ASC;`,
                onlineDailyParams
            )) as Array<{ day: string; cnt: string }>;

            // Trend: new users per week from audit logs (best effort; logs may be pruned).
            let newUsersWeekly: Array<{ week: string; cnt: string }> = [];
            try {
                newUsersWeekly = (await AppDataSource.query(
                    `SELECT DATE_FORMAT(l.timestamp, '%x-W%v') AS week,
                            SUM(GREATEST(COALESCE(JSON_LENGTH(JSON_EXTRACT(l.meta, '$.targets')), 1), 1)) AS cnt
                     FROM logs l
                     WHERE l.message IN ('audit.users.create', 'audit.users.bulk.create')
                       AND l.timestamp >= DATE_SUB(CURDATE(), INTERVAL 8 WEEK)
                     GROUP BY week
                     ORDER BY week ASC;`
                )) as Array<{ week: string; cnt: string }>;
            } catch {}

            return sendResponse(res, true, 200, "User metrics fetched successfully", {
                total,
                online,
                monthlyExceeded,
                byStatus,
                trends: {
                    onlineDaily: onlineDaily.map((r) => ({ day: String(r.day).slice(0, 10), count: Number(r.cnt || 0) })),
                    newUsersWeekly: newUsersWeekly.map((r) => ({ week: r.week, count: Number(r.cnt || 0) })),
                },
            });
        } catch (error) {
            console.error("Error fetching user metrics:", error);
            return sendResponse(res, false, 500, "Error fetching user metrics");
        }
    },

    getQuotaExceededUsers: async (req: Request, res: Response) => {
        try {
            const { isReseller, resellerId } = getResellerFilter(req);
            const includeRows =
                String((req.query as any)?.includeRows ?? "")
                    .trim()
                    .toLowerCase() === "true" ||
                String((req.query as any)?.includeRows ?? "").trim() === "1";

            const where = isReseller ? "WHERE up.owner_reseller_id = ?" : "";
            const params = isReseller ? [resellerId] : [];

            const totalRows = await AppDataSource.query(
                `SELECT COUNT(*) AS total FROM raduserprofile up ${where};`,
                params
            );
            const totalUsers = Number((totalRows as any[])?.[0]?.total ?? 0);

            // Fetch only users whose daily OR monthly usage exceeds their profile quotas.
            // We compute usage in SQL so we don't need to paginate across all users.
            const cycleStart = sqlMonthlyCycleStart("up");
            const rows = await AppDataSource.query(
                `
                SELECT
                    up.username AS username,
                    ud.full_name AS fullName,
                    p.profile_name AS profileName,
                    COALESCE(SUM(CASE WHEN s.day = CURDATE() THEN s.data_usage ELSE 0 END), 0) AS dailyUsage,
                    COALESCE(SUM(CASE WHEN s.day >= ${cycleStart} THEN s.data_usage ELSE 0 END), 0) AS monthlyUsage,
                    p.daily_quota AS dailyQuota,
                    p.monthly_quota AS monthlyQuota
                FROM raduserprofile up
                INNER JOIN radprofile p
                    ON p.id = up.profile_id
                LEFT JOIN radusagestats s
                    ON s.username = up.username
                LEFT JOIN user_details ud
                    ON ud.username = up.username
                ${where}
                GROUP BY
                    up.username,
                    ud.full_name,
                    p.profile_name,
                    p.daily_quota,
                    p.monthly_quota,
                    up.quota_reset_day,
                    up.quota_cycle_start_date
                HAVING
                    (dailyQuota > 0 AND dailyUsage > dailyQuota)
                    OR (monthlyQuota > 0 AND monthlyUsage > monthlyQuota)
                ORDER BY up.username ASC;
                `,
                params
            );

            const toRow = (r: any) => ({
                username: String(r?.username ?? ""),
                fullName: r?.fullName ?? null,
                profileName: r?.profileName ?? null,
            });

            const monthlyAccounts = (rows as any[])
                .filter((r) => {
                    const quota = parseBigIntSafe(r?.monthlyQuota);
                    return quota > BigInt(0) && parseBigIntSafe(r?.monthlyUsage) > quota;
                })
                .map(toRow)
                .filter((r) => r.username);

            const dailyAccounts = (rows as any[])
                .filter((r) => {
                    const quota = parseBigIntSafe(r?.dailyQuota);
                    return quota > BigInt(0) && parseBigIntSafe(r?.dailyUsage) > quota;
                })
                .map(toRow)
                .filter((r) => r.username);

            const monthlyCount = monthlyAccounts.length;
            const dailyCount = dailyAccounts.length;

            return sendResponse(res, true, 200, "Quota exceeded users fetched successfully", {
                totalUsers,
                monthlyCount,
                dailyCount,
                ...(includeRows ? { monthlyAccounts, dailyAccounts } : {}),
            });
        } catch (error) {
            console.error("Error fetching quota exceeded users:", error);
            return sendResponse(res, false, 500, "Error fetching quota exceeded users");
        }
    },

    bulkAssignProfile: async (req: Request, res: Response) => {
        try {
            const { isReseller, resellerId } = getResellerFilter(req);
            const usernames = normalizeUsernames(req.body?.usernames);
            const profileId = Number(req.body?.profileId);
            const dryRun = Boolean(req.body?.dryRun);

            if (usernames.length === 0) {
                return sendResponse(res, false, 400, "usernames[] is required", { errors: ["usernames is required"] });
            }
            if (!Number.isFinite(profileId) || profileId <= 0) {
                return sendResponse(res, false, 400, "profileId is required", { errors: ["profileId must be a positive integer"] });
            }
            if (usernames.length > 500) {
                return sendResponse(res, false, 400, "Too many usernames", { errors: ["Max 500 usernames per request"] });
            }

            const profileRepo = AppDataSource.getRepository(Radprofile);
            const profile = await profileRepo.findOne({ where: { id: profileId } as any });
            if (!profile) {
                return sendResponse(res, false, 404, "Profile not found");
            }

            const userRepo = AppDataSource.getRepository(Raduserprofile);
            const qb = userRepo.createQueryBuilder("u").select(["u.username", "u.profileId"]);
            qb.where("u.username IN (:...usernames)", { usernames });
            if (isReseller) qb.andWhere("u.ownerResellerId = :rid", { rid: resellerId });
            const existing = await qb.getRawMany<{ u_username: string; u_profileId: number }>();

            const matched = existing.map((r) => r.u_username);
            const matchedSet = new Set(matched);
            const notFound = usernames.filter((u) => !matchedSet.has(u));

            const alreadyOnProfile = existing.filter((r) => Number(r.u_profileId) === profileId).map((r) => r.u_username);
            const willUpdate = matched.filter((u) => !alreadyOnProfile.includes(u));

            if (dryRun) {
                await writeAuditLog({
                    req,
                    action: "users.bulk.assignProfile",
                    targetUsernames: matched,
                    meta: { dryRun: true, profileId },
                });
                return sendResponse(res, true, 200, "Bulk assign profile (dry run)", {
                    dryRun: true,
                    requested: usernames.length,
                    matched: matched.length,
                    willUpdate: willUpdate.length,
                    skipped: matched.length - willUpdate.length,
                    notFound,
                });
            }

            if (willUpdate.length > 0) {
                const up = userRepo
                    .createQueryBuilder()
                    .update(Raduserprofile)
                    .set({ profileId });
                up.where("username IN (:...usernames)", { usernames: willUpdate });
                if (isReseller) up.andWhere("ownerResellerId = :rid", { rid: resellerId });
                await up.execute();

                // Keep "default/original plan" mapping in sync with admin profile changes.
                await upsertUserDefaultProfilesBulkBestEffort(willUpdate, profileId);
            }

            // After profile assignment, if some users were previously FUP (fallback),
            // and the new profile quotas now cover their current usage, clear fallback flags
            // and apply the new profile speed via CoA (best-effort).
            let restored = 0;
            let coaApplied = 0;
            let coaFailed = 0;
            if (willUpdate.length > 0) {
                try {
                    const usageMap = await getQuotaUsageForUsers(willUpdate);
                    const dailyQuota = parseBigIntSafe((profile as any).dailyQuota);
                    const monthlyQuota = parseBigIntSafe((profile as any).monthlyQuota);

                    const eligible = willUpdate.filter((u) => {
                        const usage = usageMap[u] ?? { dailyUsage: BigInt(0), monthlyUsage: BigInt(0) };
                        return !(usage.dailyUsage > dailyQuota || usage.monthlyUsage > monthlyQuota);
                    });

                    if (eligible.length > 0) {
                        const clearQb = userRepo
                            .createQueryBuilder()
                            .update(Raduserprofile)
                            .set({ isFallback: false, isMonthlyExceeded: false } as any)
                            .where("username IN (:...usernames)", { usernames: eligible });
                        if (isReseller) clearQb.andWhere("ownerResellerId = :rid", { rid: resellerId });
                        await clearQb.execute();
                        restored = eligible.length;

                        // Apply CoA with limited concurrency so the request doesn't hang forever.
                        const concurrency = 10;
                        for (let i = 0; i < eligible.length; i += concurrency) {
                            const chunk = eligible.slice(i, i + concurrency);
                            const results = await Promise.allSettled(chunk.map((u) => UserController.applyProfileRateLimit(u)));
                            for (const r of results) {
                                if (r.status === "fulfilled" && (r.value as any)?.ok) coaApplied += 1;
                                else coaFailed += 1;
                            }
                        }
                    }
                } catch (e: any) {
                    console.warn("bulkAssignProfile post-processing failed:", e?.message || e);
                }
            }

            await deleteCacheKeys();
            await writeAuditLog({
                req,
                action: "users.bulk.assignProfile",
                targetUsernames: matched,
                meta: { dryRun: false, profileId, updated: willUpdate.length, skipped: matched.length - willUpdate.length },
            });

            return sendResponse(res, true, 200, "Bulk assign profile complete", {
                dryRun: false,
                requested: usernames.length,
                matched: matched.length,
                updated: willUpdate.length,
                skipped: matched.length - willUpdate.length,
                notFound,
                restoredFromFallback: restored,
                coaApplied,
                coaFailed,
            });
        } catch (e: any) {
            console.error("bulkAssignProfile failed:", e);
            return sendResponse(res, false, 500, "Bulk assign profile failed");
        }
    },

    bulkSetStatus: async (req: Request, res: Response) => {
        try {
            const { isReseller, resellerId } = getResellerFilter(req);
            const usernames = normalizeUsernames(req.body?.usernames);
            const accountStatus = String(req.body?.accountStatus ?? "").trim();
            const dryRun = Boolean(req.body?.dryRun);

            const allowed = new Set(["active", "suspended", "terminated", "expired"]);

            if (usernames.length === 0) {
                return sendResponse(res, false, 400, "usernames[] is required", { errors: ["usernames is required"] });
            }
            if (!allowed.has(accountStatus)) {
                return sendResponse(res, false, 400, "Invalid accountStatus", { errors: ["accountStatus must be one of: active, suspended, terminated, expired"] });
            }
            if (usernames.length > 500) {
                return sendResponse(res, false, 400, "Too many usernames", { errors: ["Max 500 usernames per request"] });
            }

            const userRepo = AppDataSource.getRepository(Raduserprofile);
            const qb = userRepo.createQueryBuilder("u").select(["u.username", "u.accountStatus"]);
            qb.where("u.username IN (:...usernames)", { usernames });
            if (isReseller) qb.andWhere("u.ownerResellerId = :rid", { rid: resellerId });
            const existing = await qb.getRawMany<{ u_username: string; u_account_status: string | null }>();

            const matched = existing.map((r) => r.u_username);
            const matchedSet = new Set(matched);
            const notFound = usernames.filter((u) => !matchedSet.has(u));

            const already = existing.filter((r) => String(r.u_account_status ?? "").trim() === accountStatus).map((r) => r.u_username);
            const willUpdate = matched.filter((u) => !already.includes(u));

            if (dryRun) {
                await writeAuditLog({
                    req,
                    action: "users.bulk.setStatus",
                    targetUsernames: matched,
                    meta: { dryRun: true, accountStatus },
                });
                return sendResponse(res, true, 200, "Bulk set status (dry run)", {
                    dryRun: true,
                    requested: usernames.length,
                    matched: matched.length,
                    willUpdate: willUpdate.length,
                    skipped: matched.length - willUpdate.length,
                    notFound,
                });
            }

            if (willUpdate.length > 0) {
                const up = userRepo
                    .createQueryBuilder()
                    .update(Raduserprofile)
                    .set({ accountStatus });
                up.where("username IN (:...usernames)", { usernames: willUpdate });
                if (isReseller) up.andWhere("ownerResellerId = :rid", { rid: resellerId });
                await up.execute();
            }

            await deleteCacheKeys();
            await writeAuditLog({
                req,
                action: "users.bulk.setStatus",
                targetUsernames: matched,
                meta: { dryRun: false, accountStatus, updated: willUpdate.length, skipped: matched.length - willUpdate.length },
            });

            return sendResponse(res, true, 200, "Bulk set status complete", {
                dryRun: false,
                requested: usernames.length,
                matched: matched.length,
                updated: willUpdate.length,
                skipped: matched.length - willUpdate.length,
                notFound,
            });
        } catch (e: any) {
            console.error("bulkSetStatus failed:", e);
            return sendResponse(res, false, 500, "Bulk set status failed");
        }
    },

    bulkResetMac: async (req: Request, res: Response) => {
        try {
            const { isReseller, resellerId } = getResellerFilter(req);
            const usernames = normalizeUsernames(req.body?.usernames);
            const dryRun = Boolean(req.body?.dryRun);

            if (usernames.length === 0) {
                return sendResponse(res, false, 400, "usernames[] is required", { errors: ["usernames is required"] });
            }
            if (usernames.length > 500) {
                return sendResponse(res, false, 400, "Too many usernames", { errors: ["Max 500 usernames per request"] });
            }

            // Scope usernames to reseller ownership if needed
            let allowedUsernames = usernames;
            if (isReseller) {
                const userRepo = AppDataSource.getRepository(Raduserprofile);
                const rows = await userRepo
                    .createQueryBuilder("u")
                    .select(["u.username"])
                    .where("u.username IN (:...usernames)", { usernames })
                    .andWhere("u.ownerResellerId = :rid", { rid: resellerId })
                    .getRawMany<{ u_username: string }>();
                allowedUsernames = rows.map((r) => r.u_username);
            }

            const allowedSet = new Set(allowedUsernames);
            const notFoundOrNotOwned = usernames.filter((u) => !allowedSet.has(u));

            const userMacRepo = AppDataSource.getRepository(UserMac);
            const existingMacRows = await userMacRepo
                .createQueryBuilder("m")
                .select(["m.username"])
                .where("m.username IN (:...usernames)", { usernames: allowedUsernames })
                .getRawMany<{ m_username: string }>();
            const withMac = existingMacRows.map((r) => r.m_username);

            if (dryRun) {
                await writeAuditLog({
                    req,
                    action: "users.bulk.resetMac",
                    targetUsernames: allowedUsernames,
                    meta: { dryRun: true, willDelete: withMac.length },
                });
                return sendResponse(res, true, 200, "Bulk reset MAC (dry run)", {
                    dryRun: true,
                    requested: usernames.length,
                    matched: allowedUsernames.length,
                    willDelete: withMac.length,
                    notFound: notFoundOrNotOwned,
                });
            }

            let deleted = 0;
            if (withMac.length > 0) {
                const result = await userMacRepo
                    .createQueryBuilder()
                    .delete()
                    .from(UserMac)
                    .where("username IN (:...usernames)", { usernames: withMac })
                    .execute();
                deleted = result.affected ?? 0;
            }

            await deleteCacheKeys();
            await writeAuditLog({
                req,
                action: "users.bulk.resetMac",
                targetUsernames: allowedUsernames,
                meta: { dryRun: false, deleted },
            });

            return sendResponse(res, true, 200, "Bulk reset MAC complete", {
                dryRun: false,
                requested: usernames.length,
                matched: allowedUsernames.length,
                deleted,
                notFound: notFoundOrNotOwned,
            });
        } catch (e: any) {
            console.error("bulkResetMac failed:", e);
            return sendResponse(res, false, 500, "Bulk reset MAC failed");
        }
    },

    bulkDeleteUsers: async (req: Request, res: Response) => {
        try {
            const { isReseller, resellerId } = getResellerFilter(req);
            const usernames = normalizeUsernames(req.body?.usernames);
            const dryRun = Boolean(req.body?.dryRun);

            if (usernames.length === 0) {
                return sendResponse(res, false, 400, "usernames[] is required", { errors: ["usernames is required"] });
            }
            if (usernames.length > 200) {
                // Deletions can cascade; keep conservative.
                return sendResponse(res, false, 400, "Too many usernames", { errors: ["Max 200 usernames per request"] });
            }

            const userRepo = AppDataSource.getRepository(Raduserprofile);
            const qb = userRepo.createQueryBuilder("u").select(["u.id", "u.username"]);
            qb.where("u.username IN (:...usernames)", { usernames });
            if (isReseller) qb.andWhere("u.ownerResellerId = :rid", { rid: resellerId });
            const rows = await qb.getRawMany<{ u_id: number; u_username: string }>();

            const matchedUsernames = rows.map((r) => r.u_username);
            const matchedSet = new Set(matchedUsernames);
            const notFound = usernames.filter((u) => !matchedSet.has(u));
            const ids = rows.map((r) => Number(r.u_id)).filter((n) => Number.isFinite(n));

            if (dryRun) {
                await writeAuditLog({
                    req,
                    action: "users.bulk.delete",
                    targetUsernames: matchedUsernames,
                    meta: { dryRun: true, matched: matchedUsernames.length, notFoundCount: notFound.length },
                });
                return sendResponse(res, true, 200, "Bulk delete users (dry run)", {
                    dryRun: true,
                    requested: usernames.length,
                    matched: matchedUsernames.length,
                    willDelete: matchedUsernames.length,
                    notFound,
                });
            }

            let deleted = 0;
            await AppDataSource.transaction(async (mgr) => {
                const invoicesRepo = mgr.getRepository(Invoices);
                const userDetailsRepo = mgr.getRepository(UserDetails);
                const radcheckRepo = mgr.getRepository(Radcheck);
                const userMacRepo = mgr.getRepository(UserMac);
                const raduserRepo = mgr.getRepository(Raduserprofile);

                if (ids.length > 0) {
                    await invoicesRepo
                        .createQueryBuilder()
                        .delete()
                        .where("user_profile_id IN (:...ids)", { ids })
                        .execute();
                }

                if (matchedUsernames.length > 0) {
                    await userDetailsRepo
                        .createQueryBuilder()
                        .delete()
                        .where("username IN (:...usernames)", { usernames: matchedUsernames })
                        .execute();

                    await userMacRepo
                        .createQueryBuilder()
                        .delete()
                        .where("username IN (:...usernames)", { usernames: matchedUsernames })
                        .execute();

                    await radcheckRepo
                        .createQueryBuilder()
                        .delete()
                        .where("username IN (:...usernames)", { usernames: matchedUsernames })
                        .execute();
                }

                if (ids.length > 0) {
                    const result = await raduserRepo
                        .createQueryBuilder()
                        .delete()
                        .from(Raduserprofile)
                        .where("id IN (:...ids)", { ids })
                        .execute();
                    deleted = result.affected ?? 0;
                }
            });

            await deleteCacheKeys();
            for (const u of matchedUsernames) {
                try {
                    await redisClient.del(`user:${u}`);
                } catch {}
            }

            await writeAuditLog({
                req,
                action: "users.bulk.delete",
                targetUsernames: matchedUsernames,
                meta: { dryRun: false, deleted, notFoundCount: notFound.length },
            });

            return sendResponse(res, true, 200, "Bulk delete users complete", {
                dryRun: false,
                requested: usernames.length,
                matched: matchedUsernames.length,
                deleted,
                notFound,
            });
        } catch (e: any) {
            console.error("bulkDeleteUsers failed:", e);
            return sendResponse(res, false, 500, "Bulk delete users failed");
        }
    },

    bulkCreateUsers: async (req: Request, res: Response) => {
        try {
            const usersRaw = (req.body as any)?.users;
            const dryRun = Boolean((req.body as any)?.dryRun);
            if (!Array.isArray(usersRaw) || usersRaw.length === 0) {
                return sendResponse(res, false, 400, "users array is required");
            }
            if (usersRaw.length > 500) {
                return sendResponse(res, false, 400, "Too many users (max 500 per request)");
            }

            const { isReseller, resellerId } = getResellerFilter(req);
            const userRepository = AppDataSource.getRepository(Raduserprofile);
            const radcheckRepository = AppDataSource.getRepository(Radcheck);
            const userDetailsRepository = AppDataSource.getRepository(UserDetails);

            const payload = usersRaw.map((u: any) => ({
                username: String(u?.username ?? "").trim(),
                password: String(u?.password ?? "").trim(),
                profileId: Number(u?.profileId),
                accountStatus: String(u?.accountStatus ?? "active"),
                freenight: u?.freenight === undefined ? undefined : Boolean(u.freenight),
                quotaResetDay: u?.quotaResetDay === undefined || u?.quotaResetDay === null ? null : Number(u.quotaResetDay),
                fullName: u?.fullName === undefined ? undefined : String(u.fullName ?? "").trim(),
                address: u?.address === undefined ? undefined : String(u.address ?? "").trim(),
                phoneNumber: u?.phoneNumber === undefined ? undefined : String(u.phoneNumber ?? "").trim(),
                email: u?.email === undefined ? undefined : String(u.email ?? "").trim(),
                expiresAt: u?.expiresAt === undefined ? undefined : u.expiresAt,
                expiryFramedIp: u?.expiryFramedIp === undefined ? undefined : u.expiryFramedIp,
            }));

            const seen = new Set<string>();
            const results: Array<{ username: string; ok: boolean; error?: string }> = [];

            for (const u of payload) {
                if (!u.username) {
                    results.push({ username: "", ok: false, error: "username is required" });
                    continue;
                }
                if (seen.has(u.username)) {
                    results.push({ username: u.username, ok: false, error: "duplicate username in request" });
                    continue;
                }
                seen.add(u.username);

                if (!u.password) {
                    results.push({ username: u.username, ok: false, error: "password is required" });
                    continue;
                }
                if (!Number.isFinite(u.profileId) || u.profileId <= 0) {
                    results.push({ username: u.username, ok: false, error: "profileId must be a positive number" });
                    continue;
                }
                if (!["active", "suspended", "terminated", "expired"].includes(u.accountStatus)) {
                    results.push({ username: u.username, ok: false, error: "accountStatus must be active|suspended|terminated|expired" });
                    continue;
                }
                if (u.expiresAt !== undefined && u.expiresAt !== null && u.expiresAt !== "") {
                    try {
                        parseExpiresAtField(u.expiresAt);
                    } catch {
                        results.push({ username: u.username, ok: false, error: "invalid expiresAt" });
                        continue;
                    }
                }
                if (u.quotaResetDay !== null) {
                    if (!Number.isFinite(u.quotaResetDay) || u.quotaResetDay < 1 || u.quotaResetDay > 31) {
                        results.push({ username: u.username, ok: false, error: "quotaResetDay must be 1..31" });
                        continue;
                    }
                }

                results.push({ username: u.username, ok: true });
            }

            const candidates = results.filter((r) => r.ok).map((r) => r.username);
            if (candidates.length === 0) {
                await writeAuditLog({
                    req,
                    action: "users.bulk.create",
                    targetUsernames: [],
                    meta: { dryRun, requested: payload.length, created: 0, failed: payload.length },
                });
                return sendResponse(res, true, 200, "Bulk create validated", { dryRun, results, created: 0, failed: results.filter((r) => !r.ok).length });
            }

            const existingUsers = await userRepository
                .createQueryBuilder("u")
                .select("u.username", "username")
                .where("u.username IN (:...usernames)", { usernames: candidates })
                .getRawMany<{ username: string }>();

            const existingRadcheck = await radcheckRepository
                .createQueryBuilder("rc")
                .select("rc.username", "username")
                .where("rc.username IN (:...usernames)", { usernames: candidates })
                .getRawMany<{ username: string }>();

            const existing = new Set<string>([
                ...existingUsers.map((x) => x.username),
                ...existingRadcheck.map((x) => x.username),
            ]);

            const finalResults = results.map((r) => {
                if (!r.ok) return r;
                if (existing.has(r.username)) return { username: r.username, ok: false, error: "User already exists" };
                return r;
            });

            const toCreate = payload.filter((u) => finalResults.some((r) => r.ok && r.username === u.username));

            if (dryRun) {
                await writeAuditLog({
                    req,
                    action: "users.bulk.create",
                    targetUsernames: toCreate.map((u) => u.username),
                    meta: { dryRun: true, requested: payload.length, wouldCreate: toCreate.length, failed: finalResults.filter((r) => !r.ok).length },
                });
                return sendResponse(res, true, 200, "Bulk create dry-run", {
                    dryRun: true,
                    results: finalResults,
                    wouldCreate: toCreate.length,
                    failed: finalResults.filter((r) => !r.ok).length,
                });
            }

            let created = 0;
            let failed = finalResults.filter((r) => !r.ok).length;

            const createdUsernames: string[] = [];

            for (const u of toCreate) {
                try {
                    await AppDataSource.transaction(async (manager) => {
                        const radcheck = new Radcheck();
                        radcheck.username = u.username;
                        radcheck.attribute = 'Cleartext-Password';
                        radcheck.op = ':=';
                        radcheck.value = u.password;
                        await manager.save(Radcheck, radcheck);

                        const user = new Raduserprofile();
                        user.username = u.username;
                        user.profileId = u.profileId;
                        user.freenight = u.freenight === undefined ? false : Boolean(u.freenight);
                        user.isFallback = false;
                        user.isMonthlyExceeded = false;
                        user.quotaResetDay = u.quotaResetDay || new Date().getDate();
                        user.accountStatus = u.accountStatus as any;
                        if (u.expiresAt !== undefined && u.expiresAt !== null && u.expiresAt !== "") {
                            user.expiresAt = parseExpiresAtField(u.expiresAt);
                        }
                        if (u.expiryFramedIp !== undefined && u.expiryFramedIp !== null && u.expiryFramedIp !== "") {
                            user.expiryFramedIp = parseExpiryFramedIpField(u.expiryFramedIp);
                        }
                        if (isReseller && resellerId) {
                            (user as any).ownerResellerId = resellerId;
                        }
                        await manager.save(Raduserprofile, user);

                        const userDetails = new UserDetails();
                        userDetails.username = u.username;
                        if (u.fullName !== undefined) userDetails.fullName = u.fullName || null;
                        if (u.address !== undefined) userDetails.address = u.address || null;
                        if (u.phoneNumber !== undefined) userDetails.phoneNumber = u.phoneNumber || null;
                        if (u.email !== undefined) userDetails.email = u.email || null;
                        await manager.save(UserDetails, userDetails);
                    });

                    await upsertUserDefaultProfileBestEffort(u.username, u.profileId);

                    created += 1;
                    createdUsernames.push(u.username);
                } catch (e: any) {
                    failed += 1;
                    // mark finalResults entry as failed
                    const idx = finalResults.findIndex((r) => r.username === u.username);
                    if (idx >= 0) finalResults[idx] = { username: u.username, ok: false, error: e?.message || "Failed to create user" };
                }
            }

            if (created > 0) {
                await deleteCacheKeys();
            }

            await writeAuditLog({
                req,
                action: "users.bulk.create",
                targetUsernames: createdUsernames,
                meta: { dryRun: false, requested: payload.length, created, failed },
            });

            return sendResponse(res, true, 201, "Bulk create completed", { dryRun: false, results: finalResults, created, failed });
        } catch (e) {
            console.error("bulkCreateUsers failed:", e);
            return sendResponse(res, false, 500, "Error creating users");
        }
    },
};


