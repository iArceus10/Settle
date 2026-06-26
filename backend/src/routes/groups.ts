import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { computeBalances, computeSettlements } from '../services/settlementService';

const router = Router();
router.use(authenticate);

// Helper to check if current user is a member of the group
async function getMemberForUser(group_id: string, user_id: string) {
  return prisma.member.findFirst({
    where: { group_id, user_id }
  });
}

// create group
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name } = req.body;
    const group = await prisma.group.create({ data: { name } });
    res.json(group);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// GET members of a group
router.get('/:id/members', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const authReq = req as AuthRequest;

    const me = await getMemberForUser(id, authReq.user!.id);
    if (!me) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const members = await prisma.member.findMany({ where: { group_id: id } });
    res.json(members);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// add member (self-join only)
router.post('/:id/members', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { name, user_id } = req.body;
    const authReq = req as AuthRequest;

    // Security Fix: You can only add yourself
    if (user_id !== authReq.user?.id) {
      res.status(403).json({ error: 'You can only add yourself to a group' });
      return;
    }

    const member = await prisma.member.create({
      data: {
        group_id: id,
        name,
        user_id
      }
    });
    res.json(member);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// GET group expenses
router.get('/:id/expenses', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const authReq = req as AuthRequest;
    
    // Check membership
    const member = await getMemberForUser(id, authReq.user!.id);
    if (!member) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const expenses = await prisma.expense.findMany({
      where: { group_id: id },
      include: { splits: true, confirmations: true },
      orderBy: { created_at: 'asc' }
    });
    res.json(expenses);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// create expense
router.post('/:id/expenses', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { id: expense_id, paid_by, amount, description, splits, origin_device, supersedes_expense_id, created_at } = req.body;
    const authReq = req as AuthRequest;

    const me = await getMemberForUser(id, authReq.user!.id);
    if (!me) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const result = await prisma.$transaction(async (tx: any) => {
      const expense = await tx.expense.create({
        data: {
          id: expense_id,
          group_id: id,
          paid_by,
          amount,
          description,
          origin_device,
          supersedes_expense_id,
          created_at: created_at ? new Date(created_at) : new Date(),
        }
      });

      for (const split of splits) {
        await tx.expenseSplit.create({
          data: {
            expense_id: expense.id,
            member_id: split.member_id,
            share: split.share
          }
        });

        // Security Fix: Auto-create confirmation ONLY for the creator, not the payer (unless creator is payer)
        const status = split.member_id === me.id ? 'confirmed' : 'pending';
        await tx.expenseConfirmation.create({
          data: {
            expense_id: expense.id,
            member_id: split.member_id,
            status
          }
        });
      }
      return expense;
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// POST sync endpoint
router.post('/:id/sync', async (req: Request, res: Response): Promise<void> => {
  try {
     const group_id = req.params.id as string;
     const { local_expenses, local_confirmations } = req.body;
     const authReq = req as AuthRequest;

     const me = await getMemberForUser(group_id, authReq.user!.id);
     if (!me) {
        res.status(403).json({ error: 'Not a member of this group' });
        return;
     }

     // Merge local expenses
     for(const exp of local_expenses) {
        const exists = await prisma.expense.findUnique({ where: { id: exp.id }});
        if(!exists) {
           await prisma.expense.create({
              data: {
                 id: exp.id,
                 group_id,
                 paid_by: exp.paid_by,
                 amount: exp.amount,
                 description: exp.description,
                 origin_device: exp.origin_device,
                 supersedes_expense_id: exp.supersedes_expense_id,
                 created_at: new Date(exp.created_at)
              }
           });
           for(const split of exp.splits) {
             await prisma.expenseSplit.create({
               data: { expense_id: exp.id, member_id: split.member_id, share: split.share }
             });
           }
        }
     }

     // Merge local confirmations (Security Fix: Ensure they only belong to the authenticated user)
     for(const conf of local_confirmations) {
        // Prevent spoofing: you can only sync confirmations for YOUR member_id
        if (conf.member_id !== me.id) {
           continue; // Skip unauthorized confirmations silently
        }

        const exists = await prisma.expenseConfirmation.findUnique({ where: { id: conf.id }});
        if(!exists) {
           await prisma.expenseConfirmation.create({
              data: {
                 id: conf.id,
                 expense_id: conf.expense_id,
                 member_id: conf.member_id,
                 status: conf.status,
                 created_at: new Date(conf.created_at)
              }
           });
        }
     }

     const expenses = await prisma.expense.findMany({ where: { group_id }, include: { splits: true } });
     const confirmations = await prisma.expenseConfirmation.findMany({ 
         where: { expense: { group_id } }
     });

     res.json({ expenses, confirmations });
  } catch (err) {
     res.status(400).json({ error: 'Sync failed' });
  }
});

router.get('/:id/balances', async (req: Request, res: Response): Promise<void> => {
  try {
    const balances = await computeBalances(req.params.id as string);
    res.json(balances);
  } catch(err) {
    res.status(400).json({ error: 'Failed' });
  }
});

router.get('/:id/settlements', async (req: Request, res: Response): Promise<void> => {
  try {
    const balances = await computeBalances(req.params.id as string);
    const settlements = computeSettlements(balances);
    res.json(settlements);
  } catch(err) {
    res.status(400).json({ error: 'Failed' });
  }
});

export default router;
