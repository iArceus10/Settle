import { Router } from 'express';
import { prisma } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.post('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { member_id } = req.body;
    
    // We insert a new ExpenseConfirmation row with status "confirmed"
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

router.post('/:id/dispute', async (req, res) => {
  try {
    const { id } = req.params;
    const { member_id } = req.body;

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
