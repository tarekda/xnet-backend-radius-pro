import { Request, Response } from "express";
import { SessionTracking } from "../db/entities/SessionTracking";
import { Brackets } from "typeorm";
import { AppDataSource } from "../db/config";
import { Radusagestats } from "../db/entities/Radusagestats";
import { Raduserprofile } from "../db/entities/Raduserprofile";
import { Radprofile } from "../db/entities/Radprofile";
import { UserDetails } from "../db/entities/UserDetails";
import { getOnlineUsers } from "../repo/onlineUsers";
import { ConnectionLogs } from "../db/entities/ConnectionLogs";
import { Radacct } from "../db/entities/Radacct";
import { Nas } from "../db/entities/Nas";
import { UserController } from "./userController";
import { sqlMonthlyCycleResetAt, sqlMonthlyCycleStart } from "../utils/quotaCycle";
import { enrichOnlineUserRowsWithQuotaAsync } from "../utils/quotaUsage";
import {
  readOnlineSessionConfig,
  sqlRadacctIsOnline,
  sqlRadacctIsActive,
  sqlRadacctLastUpdate,
  sqlSessionStatusCase,
} from "../utils/onlineSessionPolicy";

export const healthCheck = (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP' });
};

export const getLiveSessionDetail = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) {
      res.status(400).json({ success: false, message: "username is required" });
      return;
    }

    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

    const repo = AppDataSource.getRepository(SessionTracking);
    const qb = repo
      .createQueryBuilder("session")
      .leftJoin(Raduserprofile, "userProfile", "session.username = userProfile.username")
      .leftJoin(Radprofile, "profile", "userProfile.profile_id = profile.id")
      .leftJoin("user_default_profiles", "udp", "udp.username = session.username")
      .leftJoin(Radprofile, "defaultProfile", "defaultProfile.id = udp.default_profile_id")
      .leftJoin(UserDetails, "userDetails", "session.username = userDetails.username")
      .leftJoin(
        Radacct,
        "raLive",
        `raLive.acctsessionid = session.session_id AND ${sqlRadacctIsOnline("raLive")}`,
        { staleCutoff, activeCutoff }
      )
      .select([
        "session.username AS username",
        "session.session_id AS sessionId",
        "session.macAddress AS macAddress",
        "session.status AS status",
        "session.startTime AS startTime",
        "session.lastUpdate AS lastUpdate",
        "session.sessionTime AS sessionTime",
        "COALESCE(raLive.nasipaddress, NULL) AS nasIpAddress",
        "COALESCE(raLive.framedipaddress, NULL) AS framedIpAddress",
        "COALESCE(raLive.callingstationid, NULL) AS callingStationId",
        "COALESCE(raLive.acctstarttime, NULL) AS acctStartTime",
        "COALESCE(raLive.acctupdatetime, NULL) AS acctUpdateTime",
        "COALESCE(raLive.acctinputoctets, 0) AS totalBytesIn",
        "COALESCE(raLive.acctoutputoctets, 0) AS totalBytesOut",
        "profile.profileName AS profileName",
        "COALESCE(defaultProfile.profileName, profile.profileName) AS originalProfileName",
        `CASE
           WHEN LOWER(COALESCE(profile.profile_name, '')) = 'fallback' AND defaultProfile.daily_quota IS NOT NULL
             THEN defaultProfile.daily_quota
           ELSE profile.daily_quota
         END AS dailyQuota`,
        `CASE
           WHEN LOWER(COALESCE(profile.profile_name, '')) = 'fallback' AND defaultProfile.monthly_quota IS NOT NULL
             THEN defaultProfile.monthly_quota
           ELSE profile.monthly_quota
         END AS monthlyQuota`,
        "COALESCE(userProfile.is_fallback, 0) AS isFallback",
        "userDetails.fullName AS fullName",
      ])
      .where("session.status = 'active'")
      .andWhere("session.username = :username", { username })
      .andWhere(
        `EXISTS (
           SELECT 1
           FROM radacct ra
           WHERE ra.acctsessionid = session.session_id
             AND ${sqlRadacctIsOnline("ra")}
         )`,
        { staleCutoff, activeCutoff }
      );

    if (isReseller) {
      qb.andWhere("userProfile.owner_reseller_id = :rid", { rid: resellerId });
    }

    const row = await qb.getRawOne<any>();
    if (!row) {
      res.status(404).json({ success: false, message: "No live session found" });
      return;
    }

    res.status(200).json({ success: true, message: "Live session fetched", data: row });
  } catch (error) {
    console.error("Error fetching live session detail:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getUserRejects = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) {
      res.status(400).json({ success: false, message: "username is required" });
      return;
    }

    const limitRaw = parseInt(String(req.query.limit ?? "50"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    const repo = AppDataSource.getRepository(ConnectionLogs);
    const qb = repo
      .createQueryBuilder("cl")
      .select([
        "cl.timestamp AS timestamp",
        "cl.nasIp AS nasIp",
        "cl.macAddress AS macAddress",
        "cl.status AS status",
      ])
      .where("cl.username = :username", { username })
      .andWhere("cl.status IN ('rejected','timeout','error')")
      .orderBy("cl.timestamp", "DESC")
      .limit(limit);

    if (isReseller) {
      qb.innerJoin(
        Raduserprofile,
        "u",
        "u.username = cl.username AND u.owner_reseller_id = :rid",
        { rid: resellerId }
      );
    }

    const rows = await qb.getRawMany();
    res.status(200).json({ success: true, message: "Rejects fetched", data: rows });
  } catch (error) {
    console.error("Error fetching rejects:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getOnlineUsersWithUsage = async (req: Request, res: Response) => {
  try {
    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    const now = new Date();
    const today = now.toISOString().split("T")[0]; // YYYY-MM-DD

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);

    const cycleStartSql = sqlMonthlyCycleStart("up2");
    const cycleResetSql = sqlMonthlyCycleResetAt("up2");

    // 🔹 Get pagination parameters
    let page = parseInt(req.query.page as string) || 1;
    let limit = parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string || "").trim().toLowerCase();
    if (page < 1) page = 1;
    if (limit < 1) limit = 10;
    const offset = (page - 1) * limit;

    const radacctRepo = AppDataSource.getRepository(Radacct);

    const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

    // 🔹 Count total online users (source of truth: open + fresh radacct)
    const totalQb = radacctRepo
      .createQueryBuilder("ra")
      .leftJoin(Raduserprofile, "userProfile", "ra.username = userProfile.username")
      .leftJoin(UserDetails, "userDetails", "ra.username = userDetails.username")
      .leftJoin(Nas, "nas", "nas.nasname = ra.nasipaddress")
      .select("COUNT(DISTINCT ra.username)", "cnt")
      .where(sqlRadacctIsOnline("ra"))
      .setParameters({ staleCutoff, activeCutoff });

    if (search) {
      totalQb.andWhere(
        new Brackets((qb) => {
          qb.where("LOWER(ra.username) LIKE :search", { search: `%${search}%` })
            .orWhere("LOWER(userDetails.full_name) LIKE :search", { search: `%${search}%` })
            .orWhere("LOWER(COALESCE(ra.nasipaddress, '')) LIKE :search", { search: `%${search}%` })
            .orWhere("LOWER(COALESCE(nas.shortname, nas.nasname, '')) LIKE :search", { search: `%${search}%` });
        })
      );
    }

    if (isReseller) {
      totalQb.andWhere("userProfile.owner_reseller_id = :rid", { rid: resellerId });
    }

    const totalUsersRow = await totalQb.getRawOne<{ cnt: string }>();

    const totalUsers = Number(totalUsersRow?.cnt ?? 0);

    // 🔹 Query online users with daily & monthly usage (base: radacct)
    const usersRaw = await radacctRepo
      .createQueryBuilder("ra")
      .leftJoin(SessionTracking, "st", "st.session_id = ra.acctsessionid AND st.username = ra.username")
      .leftJoinAndSelect(Radusagestats, "usage", "ra.username = usage.username AND usage.day = :today", { today })
      .leftJoin(
        (qb) =>
          qb
            .from(SessionTracking, "du")
            .select([
              "du.username AS du_username",
              "SUM(COALESCE(du.bytes_in, 0) + COALESCE(du.bytes_out, 0)) AS daily_usage",
            ])
            // Daily usage definition (per user request):
            // - only sessions that STARTED today
            // - and are still open (end_time IS NULL)
            .where("du.startTime >= :todayStart AND du.startTime < :tomorrowStart")
            .andWhere("du.endTime IS NULL")
            .groupBy("du.username"),
        "dailyUsage",
        "ra.username = dailyUsage.du_username"
      )
      .leftJoin(
        `(SELECT
            up2.username AS monthly_username,
            COALESCE(SUM(s.data_usage), 0) AS monthly_usage,
            DATE_FORMAT(${cycleStartSql}, '%Y-%m-%d') AS monthly_cycle_start,
            DATE_FORMAT(${cycleResetSql}, '%Y-%m-%d') AS monthly_cycle_reset_at,
            up2.quota_reset_day AS quota_reset_day,
            up2.quota_cycle_start_date AS quota_cycle_start_date,
            COALESCE(up2.is_monthly_exceeded, 0) AS is_monthly_exceeded
          FROM raduserprofile up2
          LEFT JOIN radusagestats s
            ON s.username = up2.username
           AND s.day >= ${cycleStartSql}
          GROUP BY up2.username, up2.quota_reset_day, up2.quota_cycle_start_date, up2.is_monthly_exceeded
        )`,
        "monthlyUsage",
        "ra.username = monthlyUsage.monthly_username"
      )
      .leftJoin(Raduserprofile, "userProfile", "ra.username = userProfile.username")
      .leftJoin(Radprofile, "profile", "userProfile.profileId = profile.id")
      // Original plan saved when RADIUS moves the user onto Fallback (FUP).
      .leftJoin("user_default_profiles", "udp", "udp.username = ra.username")
      .leftJoin(Radprofile, "defaultProfile", "defaultProfile.id = udp.default_profile_id")
      .leftJoin(Nas, "nas", "nas.nasname = ra.nasipaddress")
      .leftJoinAndMapOne(
        "user.userDetails",
        UserDetails,
        "userDetails",
        "ra.username = userDetails.username"
      )
      .select([
        "ra.username AS session_username",
        "COALESCE(st.mac_address, ra.callingstationid, '') AS session_mac_address",
        "COALESCE(ra.nasipaddress, '') AS session_nas_ip",
        "COALESCE(nas.shortname, nas.nasname, '') AS session_nas_name",
        "ra.acctstarttime AS session_start_time",
        `${sqlRadacctLastUpdate("ra")} AS session_last_update`,
        "ra.acctsessiontime AS session_session_time",
        `${sqlSessionStatusCase("ra")} AS session_status`,
        // Live counters from radacct (used by frontend to calculate real-time traffic rate)
        "COALESCE(ra.acctinputoctets, 0) AS total_bytes_in",
        "COALESCE(ra.acctoutputoctets, 0) AS total_bytes_out",
        "COALESCE(dailyUsage.daily_usage, 0) AS total_daily_usage",
        "COALESCE(usage.data_usage, 0) AS real_time_data_usage",
        "COALESCE(monthlyUsage.monthly_usage, 0) AS monthly_usage",
        "monthlyUsage.monthly_cycle_start AS monthly_cycle_start",
        "monthlyUsage.monthly_cycle_reset_at AS monthly_cycle_reset_at",
        "monthlyUsage.quota_reset_day AS quota_reset_day",
        "monthlyUsage.quota_cycle_start_date AS quota_cycle_start_date",
        "monthlyUsage.is_monthly_exceeded AS is_monthly_exceeded",
        // Current RADIUS profile (often "Fallback" while FUP)
        "profile.profileName AS profile_profile_name",
        // Original plan name for UI when current profile is Fallback
        "COALESCE(defaultProfile.profileName, profile.profileName) AS original_profile_name",
        // Consumption bars must use the original plan quotas, not Fallback's tiny/wrong limits.
        // Use DB column names inside raw CASE (TypeORM does not remap camelCase in template SQL).
        `CASE
           WHEN LOWER(COALESCE(profile.profile_name, '')) = 'fallback' AND defaultProfile.daily_quota IS NOT NULL
             THEN defaultProfile.daily_quota
           ELSE profile.daily_quota
         END AS profile_daily_quota`,
        `CASE
           WHEN LOWER(COALESCE(profile.profile_name, '')) = 'fallback' AND defaultProfile.monthly_quota IS NOT NULL
             THEN defaultProfile.monthly_quota
           ELSE profile.monthly_quota
         END AS profile_monthly_quota`,
        "COALESCE(userProfile.is_fallback, 0) AS is_fallback",
        `GREATEST(
           CASE
             WHEN LOWER(COALESCE(profile.profile_name, '')) = 'fallback' AND defaultProfile.daily_quota IS NOT NULL
               THEN defaultProfile.daily_quota
             ELSE profile.daily_quota
           END - COALESCE(usage.data_usage, 0),
           0
         ) AS remaining_daily_quota`,
        `GREATEST(
           CASE
             WHEN LOWER(COALESCE(profile.profile_name, '')) = 'fallback' AND defaultProfile.monthly_quota IS NOT NULL
               THEN defaultProfile.monthly_quota
             ELSE profile.monthly_quota
           END - COALESCE(monthlyUsage.monthly_usage, 0),
           0
         ) AS remaining_monthly_quota`,
        "userDetails.fullName AS userDetails_full_name",
      ])
      .where(sqlRadacctIsOnline("ra"))
      .andWhere(new Brackets(qb => {
        qb.where("LOWER(ra.username) LIKE :search", { search: `%${search}%` })
          .orWhere("LOWER(userDetails.fullName) LIKE :search", { search: `%${search}%` })
          .orWhere("LOWER(COALESCE(ra.nasipaddress, '')) LIKE :search", { search: `%${search}%` })
          .orWhere("LOWER(COALESCE(nas.shortname, nas.nasname, '')) LIKE :search", { search: `%${search}%` });
      }))
      .andWhere(new Brackets((qb) => {
        if (!isReseller) return;
        qb.where("userProfile.owner_reseller_id = :rid", { rid: resellerId });
      }))
      .groupBy(`ra.username, ra.acctsessionid, ra.callingstationid, ra.acctstarttime, ra.acctupdatetime, ra.acctsessiontime,
        st.mac_address,
        ra.acctinputoctets, ra.acctoutputoctets,
        usage.data_usage, monthlyUsage.monthly_usage, monthlyUsage.monthly_cycle_start, monthlyUsage.monthly_cycle_reset_at,
        monthlyUsage.quota_reset_day, monthlyUsage.quota_cycle_start_date, monthlyUsage.is_monthly_exceeded,
        dailyUsage.daily_usage,
        profile.profile_name, profile.daily_quota, profile.monthly_quota, userProfile.is_fallback,
        defaultProfile.profile_name, defaultProfile.daily_quota, defaultProfile.monthly_quota,
        ra.nasipaddress, nas.shortname, nas.nasname,
        userDetails.fullName`)
      .orderBy(sqlRadacctLastUpdate("ra"), "DESC")
      .limit(limit)
      .offset(offset)
      .setParameters({ todayStart, tomorrowStart, staleCutoff, activeCutoff })
      .getRawMany();

    const users = await enrichOnlineUserRowsWithQuotaAsync(usersRaw);

    res.status(200).json({
      success: true,
      message: "Online users fetched successfully",
      totalUsers,
      totalPages: Math.ceil(totalUsers / limit),
      currentPage: page,
      limit,
      data: users,
    });
  } catch (error) {
    console.error("Error fetching online users:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getOnlineUsersMetrics = async (req: Request, res: Response) => {
  const role = (req.user as any)?.role as string | undefined;
  const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
  const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
  const isReseller = role === "reseller" && !!resellerId;

  const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

  if (!isReseller) {
    const metrics = await getOnlineUsers();
    res.status(200).json({
      success: true,
      message: "Online users fetched successfully",
      data: metrics,
    });
    return;
  }

  // Reseller-scoped metrics: count only reseller-owned users with open radacct
  const raRepo = AppDataSource.getRepository(Radacct);
  const onlineRow = await raRepo
    .createQueryBuilder("ra")
    .innerJoin(Raduserprofile, "u", "u.username = ra.username AND u.owner_reseller_id = :rid", { rid: resellerId })
    .select("COUNT(DISTINCT ra.username)", "cnt")
    .where(sqlRadacctIsOnline("ra"))
    .setParameters({ staleCutoff, activeCutoff })
    .getRawOne<{ cnt: string }>();

  const activeRow = await raRepo
    .createQueryBuilder("ra")
    .innerJoin(Raduserprofile, "u", "u.username = ra.username AND u.owner_reseller_id = :rid", { rid: resellerId })
    .select("COUNT(DISTINCT ra.username)", "cnt")
    .where(sqlRadacctIsActive("ra"))
    .setParameters({ staleCutoff, activeCutoff })
    .getRawOne<{ cnt: string }>();

  res.status(200).json({
    success: true,
    message: "Online users fetched successfully",
    data: {
      totalOnlineUsers: Number(onlineRow?.cnt ?? 0),
      totalActiveUsers: Number(activeRow?.cnt ?? 0),
    },
  });
};

export const getUserSessions = async (req: Request, res: Response) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) {
      res.status(400).json({ success: false, message: "username is required" });
      return;
    }

    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    let page = parseInt(req.query.page as string) || 1;
    let limit = parseInt(req.query.limit as string) || 20;
    if (page < 1) page = 1;
    if (limit < 1) limit = 20;
    if (limit > 200) limit = 200;
    const offset = (page - 1) * limit;

    const repo = AppDataSource.getRepository(Radacct);

    const baseQb = repo
      .createQueryBuilder("ra")
      .where("ra.username = :username", { username });

    // Prefer session_tracking counters (can be 64-bit) when available,
    // because radacct octets can under/over-report depending on NAS counters & schema.
    baseQb.leftJoin(
      SessionTracking,
      "st",
      "st.session_id = ra.acctsessionid AND st.username = ra.username"
    );

    // Reseller scoping: user must belong to the reseller
    if (isReseller) {
      baseQb.innerJoin(
        Raduserprofile,
        "u",
        "u.username = ra.username AND u.owner_reseller_id = :rid",
        { rid: resellerId }
      );
    }

    const totalRow = await baseQb
      .clone()
      .select("COUNT(*)", "cnt")
      .getRawOne<{ cnt: string }>();

    const totalSessions = Number(totalRow?.cnt ?? 0);

    const sessions = await baseQb
      .clone()
      .select([
        "ra.acctsessionid AS session_id",
        "ra.acctstarttime AS start_time",
        "ra.acctstoptime AS stop_time",
        "ra.acctsessiontime AS session_time",
        "COALESCE(st.bytes_in, ra.acctinputoctets, 0) AS bytes_in",
        "COALESCE(st.bytes_out, ra.acctoutputoctets, 0) AS bytes_out",
        "(COALESCE(st.bytes_in, ra.acctinputoctets, 0) + COALESCE(st.bytes_out, ra.acctoutputoctets, 0)) AS total_bytes",
      ])
      .orderBy("ra.acctstarttime", "DESC")
      .limit(limit)
      .offset(offset)
      .getRawMany();

    res.status(200).json({
      success: true,
      message: "User sessions fetched successfully",
      data: {
        username,
        totalSessions,
        totalPages: Math.ceil(totalSessions / limit),
        currentPage: page,
        limit,
        sessions,
      },
    });
  } catch (error) {
    console.error("Error fetching user sessions:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getUsageWindow = async (req: Request, res: Response) => {
  try {
    const username = String(req.query.username ?? "").trim();
    if (!username) {
      res.status(400).json({ success: false, message: "username is required" });
      return;
    }

    const hoursRaw = parseInt(String(req.query.hours ?? "11"), 10);
    const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 24 * 31) : 11;

    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - hours * 60 * 60 * 1000);

    // Reseller users can only query usage for usernames they own.
    if (isReseller) {
      const allowed = await AppDataSource.getRepository(Raduserprofile)
        .createQueryBuilder("u")
        .select("u.username", "username")
        .where("u.username = :username", { username })
        .andWhere("u.ownerResellerId = :rid", { rid: resellerId })
        .getRawOne<{ username?: string }>();

      if (!allowed?.username) {
        res.status(404).json({ success: false, message: "User not found" });
        return;
      }
    }

    const usageQb = AppDataSource.createQueryBuilder()
      .from("session_usage_snapshots", "sus")
      .select("COALESCE(SUM(sus.delta_bytes_in), 0)", "bytesIn")
      .addSelect("COALESCE(SUM(sus.delta_bytes_out), 0)", "bytesOut")
      .addSelect("COALESCE(SUM(sus.delta_total), 0)", "totalBytes")
      .addSelect("COUNT(*)", "samples")
      .addSelect("COUNT(DISTINCT sus.session_id)", "sessions")
      .addSelect("MAX(sus.snapshot_at)", "lastSampleAt")
      .where("sus.username = :username", { username })
      .andWhere("sus.snapshot_at >= :windowStart", { windowStart })
      .andWhere("sus.snapshot_at <= :windowEnd", { windowEnd });

    const row = await usageQb.getRawOne<{
      bytesIn: string;
      bytesOut: string;
      totalBytes: string;
      samples: string;
      sessions: string;
      lastSampleAt: string | null;
    }>();

    const bytesIn = Number(row?.bytesIn ?? 0);
    const bytesOut = Number(row?.bytesOut ?? 0);
    const totalBytes = Number(row?.totalBytes ?? 0);
    const samples = Number(row?.samples ?? 0);
    const sessions = Number(row?.sessions ?? 0);
    const totalGiB = totalBytes / (1024 * 1024 * 1024);

    res.status(200).json({
      success: true,
      message: "Usage window fetched",
      data: {
        username,
        hours,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        bytesIn,
        bytesOut,
        totalBytes,
        totalGiB: Number(totalGiB.toFixed(4)),
        samples,
        sessions,
        lastSampleAt: row?.lastSampleAt ?? null,
      },
    });
  } catch (error) {
    console.error("Error fetching usage window:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const disconnectOnlineUser = async (req: Request, res: Response) => {
  try {
    const username = String(req.body?.username ?? "").trim();
    const ip = typeof req.body?.ip === "string" ? req.body.ip.trim() : undefined;
    const code = typeof req.body?.code === "string" ? req.body.code : undefined;
    const portRaw = req.body?.port;
    const port = typeof portRaw === "number" ? portRaw : Number(portRaw);

    if (!username) {
      res.status(400).json({ success: false, message: "username is required" });
      return;
    }

    // Reseller scoping: reseller can only disconnect their own users
    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    if (isReseller) {
      const uRepo = AppDataSource.getRepository(Raduserprofile);
      const u = await uRepo.findOne({ where: { username, ownerResellerId: resellerId } as any });
      if (!u) {
        res.status(404).json({ success: false, message: "User not found" });
        return;
      }
    }

    // Prefer direct disconnect so UI action does not depend on RabbitMQ/consumer being connected.
    // We still allow optional ip/code/port from older clients, but we can also look these up safely server-side.
    let nasIpToUse = ip;
    let secretToUse = code;

    if (!nasIpToUse || !secretToUse) {
      const raRepo = AppDataSource.getRepository(Radacct);
      const active = await raRepo
        .createQueryBuilder("ra")
        .select(["ra.nasipaddress AS nasipaddress"])
        .where("ra.username = :username", { username })
        .andWhere("ra.acctstoptime IS NULL")
        .orderBy("ra.acctstarttime", "DESC")
        .limit(1)
        .getRawOne<{ nasipaddress?: string }>();

      if (!nasIpToUse) nasIpToUse = String(active?.nasipaddress ?? "").trim() || undefined;
      if (nasIpToUse && !secretToUse) {
        const nasRepo = AppDataSource.getRepository(Nas);
        const nas = await nasRepo.findOne({ where: { nasname: nasIpToUse } as any });
        secretToUse = nas?.secret;
      }
    }

    const disconnectPromise = UserController.disconnectUser(
      username,
      nasIpToUse,
      secretToUse,
      Number.isFinite(port) ? port : undefined
    );

    // Do not let the HTTP request hang forever; return quickly.
    const waitMsRaw = parseInt(process.env.DISCONNECT_HTTP_WAIT_MS || "3000", 10);
    const waitMs = Number.isFinite(waitMsRaw) && waitMsRaw > 0 ? waitMsRaw : 3000;

    let responded = false;
    const timer = setTimeout(() => {
      if (responded) return;
      responded = true;
      res.status(202).json({ success: true, message: "Disconnect started" });
    }, waitMs);

    try {
      const result = await disconnectPromise;
      if (responded) return; // already returned 202
      responded = true;
      clearTimeout(timer);

      if (!result.ok) {
        res.status(500).json({ success: false, message: result.error });
        return;
      }
      res.status(200).json({ success: true, message: "Disconnect sent", data: result });
    } finally {
      clearTimeout(timer);
      // If we already responded 202, still log the eventual outcome for debugging.
      if (responded) {
        disconnectPromise
          .then((r) => {
            if (!r.ok) console.error(`❌ Disconnect finished with error for ${username}:`, r.error);
          })
          .catch((e) => console.error(`❌ Disconnect promise rejected for ${username}:`, e));
      }
    }
  } catch (error) {
    console.error("Error disconnecting user:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getNocSnapshot = async (req: Request, res: Response) => {
  try {
    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    const now = new Date();
    const start24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const trendRows = await AppDataSource.query(
      `
        SELECT
          DATE_FORMAT(bucket, '%Y-%m-%d %H:00:00') AS bucket,
          attempts,
          rejected
        FROM connection_log_hourly_stats
        WHERE bucket >= ?
          AND bucket <= ?
        ORDER BY bucket ASC
      `,
      [start24h, now]
    ) as Array<{ bucket: string; attempts: string; rejected: string }>;

    const authRejectTrend = trendRows.map((row) => {
      const attempts = Number(row?.attempts ?? 0);
      const rejected = Number(row?.rejected ?? 0);
      const rejectRate = attempts > 0 ? (rejected / attempts) * 100 : 0;
      return {
        bucket: row.bucket,
        attempts,
        rejected,
        rejectRate: Number(rejectRate.toFixed(2)),
      };
    });

    const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

    const nasQb = AppDataSource.getRepository(Radacct)
      .createQueryBuilder("ra")
      .leftJoin(Nas, "n", "n.nasname = ra.nasipaddress")
      .select("COALESCE(ra.nasipaddress, 'Unknown')", "nasIp")
      .addSelect("COALESCE(n.shortname, n.nasname, ra.nasipaddress, 'Unknown')", "nasLabel")
      .addSelect("COUNT(*)", "sessions")
      .where(sqlRadacctIsOnline("ra"))
      .setParameters({ staleCutoff, activeCutoff });

    if (isReseller) {
      nasQb.innerJoin(
        Raduserprofile,
        "u",
        "u.username = ra.username AND u.owner_reseller_id = :rid",
        { rid: resellerId }
      );
    }

    const nasRows = await nasQb
      .groupBy("ra.nasipaddress, n.shortname, n.nasname")
      .orderBy("sessions", "DESC")
      .limit(5)
      .getRawMany<{ nasIp: string; nasLabel: string; sessions: string }>();

    const topNasBySessions = nasRows.map((row) => ({
      nasIp: row?.nasIp || "Unknown",
      nasLabel: row?.nasLabel || "Unknown",
      sessions: Number(row?.sessions ?? 0),
    }));

    res.status(200).json({
      success: true,
      data: {
        generatedAt: now.toISOString(),
        authRejectTrend,
        topNasBySessions,
      },
    });
  } catch (error) {
    console.error("Error fetching NOC snapshot:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getNocHealth = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const dbStart = Date.now();
    await AppDataSource.query("SELECT 1");
    const dbLatencyMs = Math.max(0, Date.now() - dbStart);

    const { staleCutoff, activeCutoff } = readOnlineSessionConfig();

    const activeSessionsRow = await AppDataSource.getRepository(Radacct)
      .createQueryBuilder("ra")
      .select("COUNT(*)", "cnt")
      .where(sqlRadacctIsOnline("ra"))
      .setParameters({ staleCutoff, activeCutoff })
      .getRawOne<{ cnt: string }>();

    const activeSessions = Number(activeSessionsRow?.cnt ?? 0);
    const serverProcessingMs = Math.max(0, Date.now() - startedAt);

    res.status(200).json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        dbLatencyMs,
        serverProcessingMs,
        activeSessions,
      },
    });
  } catch (error) {
    console.error("Error fetching NOC health:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getAuthFailures = async (req: Request, res: Response) => {
  try {
    const role = (req.user as any)?.role as string | undefined;
    const resellerIdRaw = (req.user as any)?.resellerId as number | null | undefined;
    const resellerId = typeof resellerIdRaw === "number" && Number.isFinite(resellerIdRaw) ? resellerIdRaw : null;
    const isReseller = role === "reseller" && !!resellerId;

    const fromRaw = String(req.query.from ?? "").trim();
    const toRaw = String(req.query.to ?? "").trim();
    const from = fromRaw ? new Date(fromRaw) : new Date(Date.now() - 60 * 60 * 1000);
    const to = toRaw ? new Date(toRaw) : new Date();
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      res.status(400).json({ success: false, message: "Invalid from/to range" });
      return;
    }

    const pageRaw = parseInt(String(req.query.page ?? "1"), 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    // Backward compatibility: if old `limit` is sent, use it as pageSize.
    const pageSizeRaw = parseInt(String(req.query.pageSize ?? req.query.limit ?? "50"), 10);
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(pageSizeRaw, 1), 500) : 50;
    const offset = (page - 1) * pageSize;

    const statusRaw = String(req.query.status ?? "all").trim().toLowerCase();
    const statusFilter = ["rejected", "timeout", "error"].includes(statusRaw) ? statusRaw : "all";
    const search = String(req.query.q ?? "").trim().toLowerCase();

    const repo = AppDataSource.getRepository(ConnectionLogs);
    const baseQb = repo
      .createQueryBuilder("cl")
      .where("cl.timestamp >= :from", { from })
      .andWhere("cl.timestamp < :to", { to })
      .andWhere("cl.status IN ('rejected','timeout','error')");

    if (statusFilter !== "all") {
      baseQb.andWhere("cl.status = :status", { status: statusFilter });
    }

    if (search) {
      baseQb.andWhere(
        new Brackets((sub) => {
          sub
            .where("LOWER(COALESCE(cl.username, '')) LIKE :search", { search: `%${search}%` })
            .orWhere("LOWER(COALESCE(cl.nasIp, '')) LIKE :search", { search: `%${search}%` })
            .orWhere("LOWER(COALESCE(cl.macAddress, '')) LIKE :search", { search: `%${search}%` });
        })
      );
    }

    if (isReseller) {
      baseQb.innerJoin(
        Raduserprofile,
        "u",
        "u.username = cl.username AND u.owner_reseller_id = :rid",
        { rid: resellerId }
      );
    }

    const totalRow = await baseQb.clone().select("COUNT(*)", "cnt").getRawOne<{ cnt: string }>();
    const total = Number(totalRow?.cnt ?? 0);

    const pagedRows = await baseQb
      .clone()
      .select([
        "cl.id AS id",
        "cl.timestamp AS timestamp",
        "cl.username AS username",
        "cl.nasIp AS nasIp",
        "cl.macAddress AS macAddress",
        "cl.status AS status",
      ])
      .orderBy("cl.timestamp", "DESC")
      .limit(pageSize)
      .offset(offset)
      .getRawMany<{
        id: number;
        timestamp: string;
        username: string | null;
        nasIp: string | null;
        macAddress: string | null;
        status: string | null;
      }>();

    const topUsersRows = await baseQb
      .clone()
      .select("COALESCE(cl.username, '-')", "username")
      .addSelect("COUNT(*)", "count")
      .groupBy("COALESCE(cl.username, '-')")
      .orderBy("count", "DESC")
      .limit(5)
      .getRawMany<{ username: string; count: string }>();

    const topNasRows = await baseQb
      .clone()
      .select("COALESCE(cl.nasIp, '-')", "nasIp")
      .addSelect("COUNT(*)", "count")
      .groupBy("COALESCE(cl.nasIp, '-')")
      .orderBy("count", "DESC")
      .limit(5)
      .getRawMany<{ nasIp: string; count: string }>();

    res.status(200).json({
      success: true,
      data: {
        from: from.toISOString(),
        to: to.toISOString(),
        count: pagedRows.length,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        currentPage: page,
        pageSize,
        rows: pagedRows,
        summary: {
          topUsers: topUsersRows.map((r) => ({
            username: r.username || "-",
            count: Number(r.count ?? 0),
          })),
          topNas: topNasRows.map((r) => ({
            nasIp: r.nasIp || "-",
            count: Number(r.count ?? 0),
          })),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching auth failures:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getAuthMetrics = async (req: Request, res: Response) => {
  try {
    const windowSecondsRaw = parseInt((req.query.windowSeconds as string) || "86400", 10);
    const windowSeconds = Number.isFinite(windowSecondsRaw) && windowSecondsRaw > 0 ? windowSecondsRaw : 86400;

    const now = Date.now();
    const windowStart = new Date(now - windowSeconds * 1000);
    const prevStart = new Date(now - windowSeconds * 2 * 1000);
    const prevEnd = windowStart;

    const repo = AppDataSource.getRepository(ConnectionLogs);

    const getCounts = async (start: Date, end: Date) => {
      // Use SUM(status='x') which returns 0/1 per row in MySQL
      const row = await repo
        .createQueryBuilder("cl")
        .select("COALESCE(SUM(cl.status = 'attempt'), 0)", "attempts")
        .addSelect("COALESCE(SUM(cl.status = 'accepted'), 0)", "accepted")
        .addSelect("COALESCE(SUM(cl.status = 'rejected'), 0)", "rejected")
        .where("cl.timestamp >= :start", { start })
        .andWhere("cl.timestamp < :end", { end })
        .getRawOne<{ attempts: string; accepted: string; rejected: string }>();

      return {
        attempts: Number(row?.attempts ?? 0),
        accepted: Number(row?.accepted ?? 0),
        rejected: Number(row?.rejected ?? 0),
      };
    };

    const current = await getCounts(windowStart, new Date(now));
    const previous = await getCounts(prevStart, prevEnd);

    const pct = (curr: number, prev: number) => {
      if (prev <= 0) return curr > 0 ? 100 : 0;
      return ((curr - prev) / prev) * 100;
    };

    res.status(200).json({
      success: true,
      data: {
        windowSeconds,
        current,
        previous,
        changePct: {
          attempts: pct(current.attempts, previous.attempts),
          rejected: pct(current.rejected, previous.rejected),
          accepted: pct(current.accepted, previous.accepted),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching auth metrics:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};



