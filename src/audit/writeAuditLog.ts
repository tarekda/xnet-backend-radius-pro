import { AppDataSource } from "../db/config";
import { Logs } from "../db/entities/Logs";

type AuditReq = {
  requestId?: string;
  user?: {
    id?: number | null;
    username?: string | null;
    role?: string | null;
    resellerId?: number | null;
  };
};

export async function writeAuditLog(params: {
  req?: AuditReq | null;
  action: string;
  targetUsernames?: string[];
  actorUsername?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(Logs);
    const entry = new Logs();
    entry.level = "info";
    entry.message = params.action.startsWith("audit.") ? params.action : `audit.${params.action}`;
    entry.meta = {
      requestId: (params.req as { requestId?: string } | undefined)?.requestId ?? null,
      actor: {
        id: params.req?.user?.id ?? null,
        username: params.req?.user?.username ?? params.actorUsername ?? null,
        role: params.req?.user?.role ?? null,
        resellerId: params.req?.user?.resellerId ?? null,
      },
      targets: params.targetUsernames ?? [],
      ...(params.meta ?? {}),
    };
    await repo.save(entry);
  } catch (e) {
    console.warn("Audit log write failed", e);
  }
}
