import 'reflect-metadata';

import express from 'express';
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
import { SessionTrackingWatcher } from './watchers/SessionTrackingWatcher';
import { WebSocket, WebSocketServer } from 'ws';
import invoiceRoutes from './routes/invoiceRoutes';
import alertRoutes from './routes/alertRoutes';
import bandwidthRoutes from './routes/bandwidthRoutes';
import expenseRoutes from './routes/expenseRoutes';
import accessRoutes from './routes/accessRoutes';
import resellerRoutes from './routes/resellerRoutes';
import auditRoutes from './routes/auditRoutes';
import backupRoutes from './routes/backupRoutes';
import cableVisionRoutes from './routes/cableVisionRoutes';
import aiRoutes from './routes/aiRoutes';
import './events/invoiceListeners'
import cors from 'cors';
import eventBus from './bus/eventBusSingleton';
import { beginShutdown } from './state/shutdown';
import { redisClient } from './redisClient';
import { AppDataSource } from './db/config';
import { metricsMiddleware, register, setWebsocketClients } from './metrics/metrics';
import { startBackupScheduler } from "./backups/scheduler";
import { runExpirySessionDisconnectJob } from "./jobs/expirySessionDisconnectJob";
import { startConnectionLogsMaintenanceScheduler } from "./jobs/connectionLogsMaintenance";

dotenv.config();

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Enable CORS
app.use(cors());

// Request correlation id (useful for Loki/metrics correlation)
app.use((req, res, next) => {
  const incoming = req.header("x-request-id");
  const requestId = incoming && incoming.trim().length ? incoming : randomUUID();
  (req as any).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
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

wss.on('connection', (ws: any) => {
    console.log('✅ WebSocket client connected');
    clients.add(ws);
    setWebsocketClients(clients.size);

    // Start the watcher
    const watcher = new SessionTrackingWatcher(ws);

    if (!watcher.started) {
        watcher.start();
        watcher.started = true;
    }

    // Handle app-level websocket messages
    ws.on('message', async (message: any) => {
      try {
        const raw = typeof message === "string" ? message : message?.toString?.() ?? "";
        const text = String(raw || "").trim();
        if (!text) return;

        // Ignore non-JSON frames (e.g. proxy/STOMP CONNECT prefaces).
        const looksJson = text.startsWith("{") || text.startsWith("[");
        if (!looksJson) {
          console.warn("Ignoring non-JSON websocket frame");
          return;
        }

        const data = JSON.parse(text);
        if (!data || typeof data !== "object") return;

        if (ws.readyState === WebSocket.OPEN) {
          try {
            await eventBus.publish({
              type: 'INVOICE_PAID',
              ...data
            });
          } catch (error) {
            console.error('Error publishing notification:', error);
          }

          ws.send(JSON.stringify({
            type: 'INVOICE_PAID',
            ...data
          }));
        }
      } catch (error) {
        console.error('Error handling message:', error);
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

// Apply security middlewares
securityMiddleware(app);

const jwtSecret = process.env.JWT_SECRET || 'your_jwt_secret';

app.set("trust proxy", true);

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

app.use("/api/expenses", expenseRoutes);

app.use("/api/access", accessRoutes);

app.use("/api", auditRoutes);

app.use("/api", resellerRoutes);

app.use("/api", backupRoutes);

app.use("/api/cable-vision", cableVisionRoutes);
app.use('/api', aiRoutes);

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
    const packet = radius.decode({ packet: msg, secret: process.env.RADIUS_SECRET || 'your_secret' });

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

// Start the consumer in the background
startConsumer().catch((err) => console.error('Consumer error:', err));

// Initialize database before starting server
initializeDB().then(async () => {
    // Start scheduled backup jobs (if env cron vars are set)
    startBackupScheduler(app);
    startConnectionLogsMaintenanceScheduler();

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

    const runOnStart = String(process.env.EXPIRY_DISCONNECT_RUN_ON_STARTUP ?? "").trim().toLowerCase();
    if (runOnStart === "1" || runOnStart === "true") {
      setTimeout(() => {
        runExpirySessionDisconnectJob().catch((e) => console.error("[expiry-disconnect] startup run failed", e));
      }, 5000);
    }

    await validateWhatsAppAtStartup();

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
      expiryDisconnectTask?.stop();
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