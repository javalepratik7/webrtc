// Maps URL paths to controller functions. Mounted at /api/health in server.js,
// so router.get('/') here answers GET /api/health.
import { Router } from 'express';
import { getHealth } from '../controllers/healthController.js';

const router = Router();

router.get('/', getHealth);

export default router;
