// Mounted at /api/network in server.js.
import { Router } from 'express';
import { getNetwork } from '../controllers/networkController.js';

const router = Router();

router.get('/', getNetwork);

export default router;
