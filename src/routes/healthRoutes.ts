import { Router } from 'express';
import { healthCheck, readyCheck, circuitBreakersCheck } from '../controllers/healthController';

const router = Router();

router.get('/health', healthCheck);
router.get('/ready', readyCheck);
router.get('/circuit-breakers', circuitBreakersCheck);

export default router;
