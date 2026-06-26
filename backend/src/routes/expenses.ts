import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.post('/:id/confirm', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { member_id } = req.body;
    const authReq = req as AuthRequest;
    
    // Security Fix: verify ownership
    const member = await prisma.member.findUnique({ where: { id: member_id }});
    if (!member || member.user_id !== authReq.user?.id) {
       res.status(403).json({ error: 'Unauthorized to confirm for this member' });
       return;
    }

    const conf = await prisma.expenseConfirmation.create({
      data: {
        expense_id: id,
        member_id,
        status: 'confirmed'
      }
    });

    res.json(conf);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

router.post('/:id/dispute', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { member_id } = req.body;
    const authReq = req as AuthRequest;

    // Security Fix: verify ownership
    const member = await prisma.member.findUnique({ where: { id: member_id }});
    if (!member || member.user_id !== authReq.user?.id) {
       res.status(403).json({ error: 'Unauthorized to dispute for this member' });
       return;
    }

    const conf = await prisma.expenseConfirmation.create({
      data: {
        expense_id: id,
        member_id,
        status: 'disputed'
      }
    });

    res.json(conf);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

export default router;
