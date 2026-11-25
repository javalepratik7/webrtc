import { Router } from 'express';
import { getSfuStatus } from '../controllers/sfuController.js';

const router = Router();
router.get('/', getSfuStatus);

export default router;
