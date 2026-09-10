import 'reflect-metadata';

import express from 'express';
import compression from 'compression';
import path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import radius from 'radius';
import dgram from 'dgram';
import swaggerJsDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import authRoutes from './routes/authRoutes';
import { initializeDB } from './db/config';
import { validateWhatsAppAtStartup } from './services/whatsappService';
import radiusRoutes from './routes/radiusRoutes';
import healthRoutes from './routes/healthRoutes';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { securityMiddleware } from './middleware/security';
import dotenv from 'dotenv';
import { Logger, loggerMiddleware, requestLogger } from './logging/logging';
import 'reflect-metadata';
import profileRoutes from './routes/profileRoutes';
import sessionRoutes from './routes/sessionRoutes';
import { createServer } from 'http';
import { startConsumer } from './bus/userActionsConsumer';
import nasRoutes from './routes/nasRoutes';
import cron from "node-cron";
import { generateMonthlyInvoices } from './services/invoiceService';
import { runExternalDunningSystemJob } from './controllers/invoiceController';
import { evaluateAlertRules } from './alerts/evaluateAlertRules';
import { SessionTrackingWatcher } from './watchers/SessionTrackingWatcher';
import { WebSocket, WebSocketServer } from 'ws';
import invoiceRoutes from './routes/invoiceRoutes';
import alertRoutes from './routes/alertRoutes';
import bandwidthRoutes from './routes/bandwidthRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import expenseRoutes from './routes/expenseRoutes';
import { subscriberAuthRoutes, subscriberApiRoutes } from './routes/subscriberRoutes';
import paymentGatewayRoutes, { paymentWebhookRoutes } from './routes/paymentGatewayRoutes';
import accessRoutes from './routes/accessRoutes';
import resellerRoutes from './routes/resellerRoutes';
import companyWalletRoutes from './routes/companyWalletRoutes';
import auditRoutes from './routes/auditRoutes';
import backupRoutes from './routes/backupRoutes';
import cableVisionRoutes from './routes/cableVisionRoutes';
import aiRoutes from './routes/aiRoutes';
import voucherRoutes from './routes/voucherRoutes';
import externalUsersRoutes from './routes/externalUsersRoutes';
import whatsappWebhookRoutes, { whatsappTwilioWebhookRouter } from './routes/whatsappWebhookRoutes';
import topupRoutes from './routes/topupRoutes';
import { setWsBroadcast } from './realtime/wsHub';
import './events/invoiceListeners'
import cors from 'cors';
import { beginShutdown } from './state/shutdown';
import { redisClient } from './redisClient';
import { AppDataSource } from './db/config';
import { metricsMiddleware, register, setWebsocketClients } from './metrics/metrics';
import { startBackupScheduler } from "./backups/scheduler";
import { runExpirySessionDisconnectJob } from "./jobs/expirySessionDisconnectJob";
import { startConnectionLogsMaintenanceScheduler } from "./jobs/connectionLogsMaintenance";
import { runWhishClaimReconciliationJob } from "./jobs/whishClaimReconciliationJob";
import { startDailyRevenueSnapshotScheduler } from "./jobs/dailyRevenueSnapshotJob";
import { startMonthlyQuotaResetScheduler } from "./jobs/monthlyQuotaResetJob";
import { startAlertEscalationScheduler, stopAlertEscalationScheduler } from "./jobs/alertEscalationJob";
import { startDunningEscalationScheduler, stopDunningEscalationScheduler } from "./jobs/dunningEscalationJob";
import revenueLeakageRoutes from "./routes/revenueLeakageRoutes";
import { startRevenueLeakageAuditScheduler, stopRevenueLeakageAuditScheduler } from "./jobs/revenueLeakageAuditJob";
import { ipWhitelistMiddleware } from "./middleware/ipWhitelist";
import { csrfProtectionMiddleware } from "./middleware/csrfProtection";
import { requestIdMiddleware } from "./middleware/requestId";
import { voucherService } from "./services/voucherService";
import { clickhouseRollupService } from "./services/clickhouseRollupService";
import { assertProductionSecrets, getJwtSecret, getRadiusSecret } from "./config/requireSecrets";
import jwt from "jsonwebtoken";

dotenv.config();
assertProductionSecrets();

const app = express();

// WhatsApp inbound webhooks need raw / form bodies (must be registered before express.json()).
app.use(
  '/api/webhooks/whatsapp',
  express.raw({ type: 'application/json' }),
  whatsappWebhookRoutes
);
app.use(
  '/api/webhooks/whatsapp/twilio',
  express.urlencoded({ extended: false }),
  whatsappTwilioWebhookRouter
);

// Middleware to parse JSON bodies
app.use(express.json());

// Enable CORS
app.use(cors());

// Enable HTTP response compression for JSON and responses > 1KB
app.use(compression({ threshold: 1024 }));

// Serve uploaded receipts and documents statically
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Enterprise Security Hardening
app.use(ipWhitelistMiddleware());
app.use(csrfProtectionMiddleware());

// Request correlation id (useful for Loki/metrics correlation and standardized envelopes)
app.use(requestIdMiddleware);
app.use((req, res, next) => {
  (req as any).requestId = req.id;
  next();
});

// Set a safe default timeout for outbound HTTP calls
axios.defaults.timeout = parseInt(process.env.AXIOS_TIMEOUT_MS || "10000", 10);

const server = createServer(app);
// Avoid stuck connections lingering forever
server.keepAliveTimeout = parseInt(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || "65000", 10);
server.headersTimeout = parseInt(process.env.HTTP_HEADERS_TIMEOUT_MS || "70000", 10);
server.requestTimeout = parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || "60000", 10);

// Create WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server });

// Metrics endpoint (not under /api rate limiting)
app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Record HTTP metrics for all requests
app.use(metricsMiddleware);

// Store connected clients
const clients = new Set();

wss.on('connection', (ws: any, req: any) => {
    // Require a valid JWT before accepting the socket (query ?token= or Authorization header).
    try {
      const host = req?.headers?.host || "localhost";
      const url = new URL(req?.url || "/", `http://${host}`);
      const headerAuth = String(req?.headers?.authorization || "");
      const headerToken = headerAuth.toLowerCase().startsWith("bearer ")
        ? headerAuth.slice(7).trim()
        : "";
      const token = String(url.searchParams.get("token") || headerToken || "").trim();
      if (!token) {
        ws.close(4401, "Unauthorized");
        return;
      }
      jwt.verify(token, getJwtSecret());
      ws.isAuthenticated = true;
    } catch {
      ws.close(4401, "Unauthorized");
      return;
    }

    console.log('✅ WebSocket client connected');
    clients.add(ws);
    setWebsocketClients(clients.size);

    // Start the watcher
    const watcher = new SessionTrackingWatcher(ws);

    if (!watcher.started) {
        watcher.start();
        watcher.started = true;
    }

    // Clients may only receive broadcasts. Never accept client-originated
    // business events (e.g. INVOICE_PAID) — that was an unauthenticated injection path.
    ws.on('message', (message: any) => {
      try {
        const raw = typeof message === "string" ? message : message?.toString?.() ?? "";
        const text = String(raw || "").trim();
        if (!text) return;
        const looksJson = text.startsWith("{") || text.startsWith("[");
        if (!looksJson) return;
        const data = JSON.parse(text);
        if (data?.type === "ping" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => {
        console.log('❌ WebSocket client disconnected');
        clients.delete(ws);
        setWebsocketClients(clients.size);
    });
});

// Function to broadcast messages to all connected clients
export const broadcastMessage = (message: any) => {
    const messageStr = JSON.stringify(message);
    clients.forEach((client:any) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
};
setWsBroadcast(broadcastMessage);

// Apply security middlewares
securityMiddleware(app);

app.set("trust proxy", 1);

// Use the requestLogger middleware
app.use(requestLogger);

// Then, use express-winston middleware to log detailed request/response info
app.use(loggerMiddleware);

// Apply rate limiting
app.use('/api/', apiLimiter);

// Use the auth routes
app.use('/api/auth', authRoutes);

// Use the health check routes
app.use('/api', healthRoutes);

app.use('/api', nasRoutes);

app.use('/api/radius', radiusRoutes);

app.use('/api', profileRoutes);

app.use('/api', sessionRoutes);

app.use("/api/invoices", invoiceRoutes);

app.use("/api/alerts", alertRoutes);

app.use("/api/bandwidth", bandwidthRoutes);

app.use("/api/analytics", analyticsRoutes);

app.use("/api/auth/subscriber", subscriberAuthRoutes);
app.use("/api/subscriber", subscriberApiRoutes);
app.use("/api/invoices", paymentGatewayRoutes);
app.use("/api/topups", topupRoutes);
app.use("/api/webhooks/payments", paymentWebhookRoutes);

app.use("/api/expenses", expenseRoutes);

app.use("/api/access", accessRoutes);

app.use("/api", auditRoutes);

app.use("/api", resellerRoutes);
app.use("/api", companyWalletRoutes);

app.use("/api", backupRoutes);
app.use("/api/vouchers", voucherRoutes);
app.use("/api/external-users", externalUsersRoutes);

app.use("/api/cable-vision", cableVisionRoutes);
app.use('/api', aiRoutes);
app.use('/api/revenue-leakage', revenueLeakageRoutes);

const monthlyInvoiceTask = cron.schedule("0 0 1 * *", async () => {
    console.log("Running monthly invoice generation...");
    await generateMonthlyInvoices();
  });

const dunningCronExpr = String(process.env.DUNNING_CRON ?? "").trim();
const dunningTask = dunningCronExpr
  ? cron.schedule(dunningCronExpr, async () => {
      try {
        const result = await runExternalDunningSystemJob();
        console.log("[dunning] run complete", {
          attempted: result.attempted,
          sent: result.sent,
          failed: result.failed,
          skippedNoPhone: (result as any).skippedNoPhone,
        });
      } catch (e) {
        console.error("[dunning] run failed", e);
      }
    })
  : null;
if (dunningTask) {
  console.log(`[dunning] scheduler enabled: ${dunningCronExpr}`);
}

/** Set after DB init — expiry job must not run before AppDataSource.initialize() completes. */
let expiryDisconnectTask: ReturnType<typeof cron.schedule> | null = null;
let alertEvalTask: ReturnType<typeof cron.schedule> | null = null;
let whishReconciliationTask: ReturnType<typeof cron.schedule> | null = null;

// RADIUS server setup
const radiusServer = dgram.createSocket('udp4');

// Hardcoded user database
const users: { [key: string]: string } = {
    'testuser': 'password123'
};

//const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');

async function logSession(username: string, action: string): Promise<void> {
    // try {
    //     await client.connect();
    //     const database = client.db('radius');
    //     const sessions = database.collection('sessions');
    //     await sessions.insertOne({ username: username, action: action, timestamp: new Date() });
    // } finally {
    //     await client.close();
    // }
}

radiusServer.on('message', async (msg, rinfo) => {
    const packet = radius.decode({ packet: msg, secret: getRadiusSecret() });

    // Check if the packet is from RADIUS
    if (!packet) {
        console.log('Non-RADIUS packet received, ignoring.');
        return;
    }

    console.log('RADIUS packet received:', packet);

    // Handle Access-Request
    if (packet.code === 'Access-Request') {
        const username = packet.attributes['User-Name'];
        const password = packet.attributes['User-Password'];

        if (users[username] && users[username] === password) {
            await logSession(username, 'login');
            console.log('User logged in:', username);
        } else {
            console.log('Access-Reject for user:', username);
        }
    }

    // Handle Accounting-Request
    if (packet.code === 'Accounting-Request') {
        const username = packet.attributes['User-Name'];
        const action = packet.attributes['Acct-Status-Type'];

        await logSession(username, action);
        console.log('Accounting action:', action, 'for user:', username);
    }
});

//radiusServer.bind(1812);

const swaggerOptions = {
    swaggerDefinition: {
        openapi: '3.0.0',
        info: {
            title: 'Xnet Backend Radius Pro API',
            version: '1.0.0',
            description: 'API documentation for Xnet Backend Radius Pro',
        },
        servers: [
            {
                url: 'http://localhost:3000',
            },
        ],
    },
    apis: ['./src/controllers/*.ts'],
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Basic route
app.get('/', (req, res) => {
    res.send('Xnet server is running');
});

// Error handling middleware
app.use(errorHandler);

// Start the consumer in the background (disable with START_USER_ACTIONS_CONSUMER=0 when using worker profile)
const startConsumerFlag = String(process.env.START_USER_ACTIONS_CONSUMER ?? "1").toLowerCase();
if (startConsumerFlag !== "0" && startConsumerFlag !== "false") {
  startConsumer().catch((err) => console.error("Consumer error:", err));
} else {
  console.log("user_actions consumer disabled in this process (START_USER_ACTIONS_CONSUMER=0)");
}

// Initialize database before starting server
initializeDB().then(async () => {
    // Start scheduled backup jobs (if env cron vars are set)
    startBackupScheduler(app);
    startConnectionLogsMaintenanceScheduler();
    startDailyRevenueSnapshotScheduler();
    startMonthlyQuotaResetScheduler();
    startAlertEscalationScheduler();
    voucherService.init().catch((e) => console.warn("[vouchers] cache init failed (non-fatal):", e));

    // Ensure ClickHouse flow-log schema (rollup table + materialized view) exists.
    // Runs async so it never blocks server startup; safe to retry — uses IF NOT EXISTS.
    setTimeout(() => {
      clickhouseRollupService.ensureSchema().then((ok) => {
        if (ok) console.log("[clickhouse] schema ensured");
        else    console.warn("[clickhouse] ensureSchema returned false — ClickHouse may be unavailable");
      }).catch((e) => console.warn("[clickhouse] ensureSchema failed (non-fatal):", e));
    }, 8_000);

    const expiryDisconnectCronExpr = String(process.env.EXPIRY_DISCONNECT_CRON ?? "").trim();
    if (expiryDisconnectCronExpr) {
      expiryDisconnectTask = cron.schedule(expiryDisconnectCronExpr, async () => {
        try {
          await runExpirySessionDisconnectJob();
        } catch (e) {
          console.error("[expiry-disconnect] run failed", e);
        }
      });
      console.log(`[expiry-disconnect] scheduler enabled: ${expiryDisconnectCronExpr}`);
    }

    const alertEvalCronExpr = String(process.env.ALERT_EVAL_CRON ?? "*/2 * * * *").trim();
    if (alertEvalCronExpr && alertEvalCronExpr !== "off" && alertEvalCronExpr !== "0") {
      try {
        alertEvalTask = cron.schedule(alertEvalCronExpr, async () => {
          try {
            await evaluateAlertRules();
          } catch (e) {
            console.error("[alerts] eval failed", e);
          }
        });
        console.log(`[alerts] evaluator enabled: ${alertEvalCronExpr}`);
      } catch (e) {
        console.error("[alerts] invalid ALERT_EVAL_CRON", e);
      }
    }

    const whishReconciliationCron = String(process.env.WHISH_RECONCILIATION_CRON ?? "*/15 * * * *").trim();
    if (whishReconciliationCron && whishReconciliationCron !== "off" && whishReconciliationCron !== "0") {
      try {
        whishReconciliationTask = cron.schedule(whishReconciliationCron, async () => {
          try {
            await runWhishClaimReconciliationJob();
          } catch (e) {
            console.error("[whish] reconciliation failed", e);
          }
        });
        console.log(`[whish] reconciliation job enabled: ${whishReconciliationCron}`);
      } catch (e) {
        console.error("[whish] invalid WHISH_RECONCILIATION_CRON", e);
      }
    }

    const runOnStart = String(process.env.EXPIRY_DISCONNECT_RUN_ON_STARTUP ?? "").trim().toLowerCase();
    if (runOnStart === "1" || runOnStart === "true") {
      setTimeout(() => {
        runExpirySessionDisconnectJob().catch((e) => console.error("[expiry-disconnect] startup run failed", e));
      }, 5000);
    }

    await validateWhatsAppAtStartup();
    startDunningEscalationScheduler();
    startRevenueLeakageAuditScheduler();

    server.listen(process.env.PORT || 3000, () => {
        console.log(`Server is running on http://localhost:${process.env.PORT || 3000}`);
    });
});

let shutdownStarted = false;
async function shutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  beginShutdown();
  console.log(`🛑 Received ${signal}. Shutting down gracefully...`);

  try {
    // Stop cron jobs
    try {
      monthlyInvoiceTask.stop();
    } catch {}
    try {
      dunningTask?.stop();
    } catch {}
    try {
      stopDunningEscalationScheduler();
    } catch {}
    try {
      stopRevenueLeakageAuditScheduler();
    } catch {}
    try {
      expiryDisconnectTask?.stop();
    } catch {}
    try {
      alertEvalTask?.stop();
    } catch {}
    try {
      whishReconciliationTask?.stop();
    } catch {}
    try {
      stopAlertEscalationScheduler();
    } catch {}

    // Stop accepting new HTTP connections
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Close WebSocket server + clients
    try {
      wss.clients.forEach((client) => {
        try {
          client.close();
        } catch {}
      });
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    } catch {}

    // Close Redis
    try {
      if ((redisClient as any).isOpen) {
        await redisClient.quit();
      }
    } catch {}

    // Close DB
    try {
      if (AppDataSource.isInitialized) {
        await AppDataSource.destroy();
      }
    } catch {}
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  Logger.getInstance().error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  Logger.getInstance().error('Uncaught exception:', err);
});
 
// export { io }