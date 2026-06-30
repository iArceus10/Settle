import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { authorizeConfirmationAction } from '../services/groupValidation';

const router = Router();
router.use(authenticate);

router.post('/:id/confirm', async (req: Request, res: Response): Promise<void> => {
  try {
    const expenseId = req.params.id as string;
    const { member_id } = req.body;
    const authReq = req as AuthRequest;

    if (!member_id) {
      res.status(400).json({ error: 'member_id is required' });
      return;
    }

    const auth = await authorizeConfirmationAction(
      expenseId,
      member_id,
      authReq.user!.id
    );
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const conf = await prisma.expenseConfirmation.create({
      data: {
        expense_id: expenseId,
        member_id,
        status: 'confirmed',
      },
    });

    res.json(conf);
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

router.post('/:id/dispute', async (req: Request, res: Response): Promise<void> => {
  try {
    const expenseId = req.params.id as string;
    const { member_id } = req.body;
    const authReq = req as AuthRequest;

    if (!member_id) {
      res.status(400).json({ error: 'member_id is required' });
      return;
    }

    const auth = await authorizeConfirmationAction(
      expenseId,
      member_id,
      authReq.user!.id
    );
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const conf = await prisma.expenseConfirmation.create({
      data: {
        expense_id: expenseId,
        member_id,
        status: 'disputed',
      },
    });

    res.json(conf);
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

export default router;
