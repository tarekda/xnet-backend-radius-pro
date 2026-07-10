// QuotaService.ts
import { DataSource, QueryRunner } from 'typeorm';
import { Raduserprofile } from '../db/entities/Raduserprofile';
import { CacheService  } from './cacheService';
import { EventBus } from '../bus/eventBus';
import { sqlMonthlyCycleStart } from '../utils/quotaCycle';
import { recordQuotaReset } from '../metrics/metrics';

export class QuotaService {
  private dataSource: DataSource;
  private eventBus: EventBus;

  constructor(dataSource: DataSource, eventBus: EventBus, private cacheService: CacheService) {
    this.dataSource = dataSource;
    this.eventBus = eventBus;
    this.cacheService = cacheService;
  }

  async resetDailyQuota(username: string): Promise<void> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // Step 1: Reset daily usage in radusagestats
      await queryRunner.query(
        `UPDATE radusagestats 
         SET data_usage = 0
         WHERE day = ? AND username = ?;`,
        [today, username]
      );

      // Step 2: Reset session tracking values for sessions started today
      await queryRunner.query(
        `UPDATE session_tracking 
         SET daily_bytes_in = 0, daily_bytes_out = 0, daily_session_time = 0,
             bytes_in = 0, bytes_out = 0, session_time = 0, last_update = NOW()
         WHERE username = ? AND DATE(start_time) = ? AND (DATE(end_time) = ? OR end_time IS NULL);`,
        [username, today, today]
      );

      // Step 3: Update fallback profile field in raduserprofile
      const userProfileRepository = queryRunner.manager.getRepository(Raduserprofile);
      await userProfileRepository.update({ username }, { isFallback: false });

      // Step 3b (best-effort): if the user was moved to the "Fallback" profile by quota procedures,
      // restore their original/default profile when available (user_default_profiles).
      // This avoids users getting stuck on the fallback 256k profile after quota reset.
      try {
        await queryRunner.query(
          `
          UPDATE raduserprofile up
          LEFT JOIN user_default_profiles udp
            ON udp.username = up.username
          SET
            up.profile_id = COALESCE(udp.default_profile_id, up.profile_id),
            up.is_fallback = 0
          WHERE up.username = ?
            AND up.profile_id = (SELECT id FROM radprofile WHERE profile_name = 'Fallback' LIMIT 1);
          `,
          [username]
        );
      } catch (e: any) {
        // Don't fail quota reset if optional table doesn't exist.
        console.warn("resetDailyQuota: unable to restore default profile:", e?.message || e);
      }

      // Commit the transaction
      await queryRunner.commitTransaction();

      // Step 4: Invalidate cache
      await this.cacheService.deleteCacheKeys();

      // Instead of directly disconnecting and updating session, publish an event
      await this.eventBus.publish({
        action: 'disconnectAndCompleteSession',
        username,
        reason: 'dailyQuotaReset'
      });
      recordQuotaReset("daily", "ok");
    } catch (error) {
      console.error('Error resetting daily quota:', error);
      await queryRunner.rollbackTransaction();
      recordQuotaReset("daily", "error");
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async resetMonthlyQuota(username: string): Promise<void> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const cycleStart = sqlMonthlyCycleStart("up");
      await queryRunner.query(
        `
        UPDATE radusagestats s
        INNER JOIN raduserprofile up
          ON up.username = s.username
        SET s.data_usage = 0
        WHERE s.username = ?
          AND s.day >= ${cycleStart};
        `,
        [username]
      );

      await queryRunner.query(
        `
        UPDATE session_tracking st
        INNER JOIN raduserprofile up
          ON up.username = st.username
        SET st.daily_bytes_in = 0,
            st.daily_bytes_out = 0,
            st.daily_session_time = 0,
            st.bytes_in = 0,
            st.bytes_out = 0,
            st.session_time = 0,
            st.last_update = NOW()
        WHERE st.username = ?
          AND DATE(st.start_time) >= ${cycleStart}
          AND (DATE(st.end_time) >= ${cycleStart} OR st.end_time IS NULL);
        `,
        [username]
      );

      // Anchor the new billing cycle from today after a manual monthly reset.
      await queryRunner.query(
        `UPDATE raduserprofile SET quota_cycle_start_date = CURDATE() WHERE username = ?;`,
        [username]
      );

      // Clear exceeded/fallback flags and (best-effort) restore default profile if user is on the "Fallback" profile.
      // Note: the RADIUS quota procedures switch profile_id to the fallback profile; without restoring it here,
      // users can remain stuck on 256k even after resetting usage.
      try {
        await queryRunner.query(
          `
          UPDATE raduserprofile up
          LEFT JOIN user_default_profiles udp
            ON udp.username = up.username
          SET
            up.is_monthly_exceeded = 0,
            up.is_fallback = 0,
            up.profile_id = COALESCE(udp.default_profile_id, up.profile_id)
          WHERE up.username = ?
            AND (
              up.is_monthly_exceeded = 1
              OR up.profile_id = (SELECT id FROM radprofile WHERE profile_name = 'Fallback' LIMIT 1)
            );
          `,
          [username]
        );
      } catch (e: any) {
        // Fallback: clear flags using ORM mapping even if optional table doesn't exist.
        const userProfileRepository = queryRunner.manager.getRepository(Raduserprofile);
        await userProfileRepository.update({ username }, { isMonthlyExceeded: false, isFallback: false });
        console.warn("resetMonthlyQuota: unable to restore default profile:", e?.message || e);
      }

      await queryRunner.commitTransaction();

      // Invalidate cache
      await this.cacheService.deleteCacheKeys();

      // Disconnect so the user re-auths and normal profile applies immediately.
      await this.eventBus.publish({
        action: 'disconnectAndCompleteSession',
        username,
        reason: 'monthlyQuotaReset'
      });
      recordQuotaReset("monthly", "ok");
    } catch (error) {
      console.error('Error resetting monthly quota:', error);
      await queryRunner.rollbackTransaction();
      recordQuotaReset("monthly", "error");
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
