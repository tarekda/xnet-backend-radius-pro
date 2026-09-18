import { Router } from "express";
import { registerDeviceHandler, unregisterDeviceHandler } from "../controllers/pushController";
import { authenticateToken } from "../middleware/authMiddleware";

const router = Router();

// Any signed-in user may register their own device; there is nothing to
// authorise beyond being authenticated.
router.post("/register", authenticateToken, registerDeviceHandler);
router.post("/unregister", authenticateToken, unregisterDeviceHandler);

export default router;
