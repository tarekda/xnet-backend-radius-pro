import { Router, Request, Response } from "express";
import { authenticateToken, authorizeAnyPermissions } from "../middleware/authMiddleware";
import { fetchExternalUsers, type ExternalUserProvider } from "../services/externalUsersService";

const router = Router();

/**
 * GET /api/external-users
 * Returns a combined list of subscribers from all configured external radius providers,
 * enriched with local RADIUS online-session status.
 *
 * Query params:
 *   providers  - comma-separated list: myisp,myisp2,idm,terra  (default: all configured)
 *   search     - filter by username or full name (case-insensitive)
 *   online     - "true" | "false"  filter by online status
 */
router.get(
  "/",
  authenticateToken,
  authorizeAnyPermissions("billing.invoiceUpload.create", "users.view"),
  async (req: Request, res: Response) => {
    try {
      const allProviders: ExternalUserProvider[] = ["myisp", "myisp2", "idm", "terra", "terra2", "misp"];

      const providersParam = String(req.query.providers ?? "").trim().toLowerCase();
      const wantedProviders: ExternalUserProvider[] = providersParam
        ? (providersParam.split(",").filter((p) => allProviders.includes(p as ExternalUserProvider)) as ExternalUserProvider[])
        : allProviders;

      const search = String(req.query.search ?? "").trim().toLowerCase();
      const onlineFilter = req.query.online === "true" ? true : req.query.online === "false" ? false : null;

      const result = await fetchExternalUsers({ providers: wantedProviders });

      // Apply search + online filter
      for (const providerResult of result.providers) {
        let filtered = providerResult.users;
        if (search) {
          filtered = filtered.filter(
            (u) =>
              u.username.toLowerCase().includes(search) ||
              u.fullName.toLowerCase().includes(search) ||
              u.phoneNumber.toLowerCase().includes(search)
          );
        }
        if (onlineFilter !== null) {
          filtered = filtered.filter((u) => u.online === onlineFilter);
        }
        providerResult.users = filtered;
      }

      const filteredTotal = result.providers.reduce((acc, p) => acc + p.users.length, 0);
      const filteredOnline = result.providers.reduce((acc, p) => acc + p.users.filter((u) => u.online).length, 0);

      res.json({
        success: true,
        data: {
          providers: result.providers,
          totalUsers: filteredTotal,
          totalOnline: filteredOnline,
          fetchedAt: result.fetchedAt,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message ?? "Failed to fetch external users" });
    }
  }
);

/**
 * GET /api/external-users/providers
 * Returns which providers are currently configured (safe metadata only).
 */
router.get(
  "/providers",
  authenticateToken,
  authorizeAnyPermissions("billing.invoiceUpload.create", "users.view"),
  (_req: Request, res: Response) => {
    const providers = [
      {
        key: "myisp",
        label: "MyISP Account 1",
        configured:
          Boolean(process.env.MYISP_1_USERNAME?.trim()) &&
          Boolean(process.env.MYISP_1_PASSWORD?.trim()),
      },
      {
        key: "myisp2",
        label: "MyISP Account 2",
        configured:
          Boolean(process.env.MYISP_2_USERNAME?.trim()) &&
          Boolean(process.env.MYISP_2_PASSWORD?.trim()),
      },
      {
        key: "idm",
        label: "IDM HSI Pro",
        configured:
          Boolean(process.env.IDM_USERNAME?.trim()) &&
          Boolean(process.env.IDM_PASSWORD?.trim()),
      },
      {
        key: "terra",
        label: "Terra ACP Pro 1",
        configured:
          Boolean(process.env.TERRA_USERNAME?.trim()) &&
          Boolean(process.env.TERRA_PASSWORD?.trim()),
      },
      {
        key: "terra2",
        label: "Terra ACP Pro 2",
        configured:
          Boolean(process.env.TERRA2_USERNAME?.trim()) &&
          Boolean(process.env.TERRA2_PASSWORD?.trim()),
      },
      {
        key: "misp",
        label: "MISP Cloud",
        configured:
          Boolean(process.env.MISP_USERNAME?.trim()) &&
          Boolean(process.env.MISP_PASSWORD?.trim()),
      },
    ];
    res.json({ success: true, data: providers });
  }
);

export default router;
