import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { computeBalances, computeSettlements } from '../services/settlementService';
import {
  getMemberForUser,
  isConfirmationStatus,
  validateExpenseParticipants,
  validateSupersedesExpense,
  validateSyncedConfirmation,
} from '../services/groupValidation';

const router = Router();
router.use(authenticate);

async function requireGroupMember(
  req: Request,
  res: Response
): Promise<{ groupId: string; me: { id: string; group_id: string; user_id: string; name: string } } | null> {
  const groupId = req.params.id as string;
  const authReq = req as AuthRequest;
  const me = await getMemberForUser(groupId, authReq.user!.id);
  if (!me) {
    res.status(403).json({ error: 'Not a member of this group' });
    return null;
  }
  return { groupId, me };
}

// list groups for the authenticated user
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthRequest;
    const memberships = await prisma.member.findMany({
      where: { user_id: authReq.user!.id },
    });

    const groups = await Promise.all(
      memberships.map(async (member: { group_id: string }) => (
        prisma.group.findUnique({ where: { id: member.group_id } })
      ))
    );

    res.json(groups.filter(Boolean));
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// create group
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, member_name } = req.body;
    const authReq = req as AuthRequest;
    if (!name?.trim()) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const result = await prisma.$transaction(async (tx: any) => {
      const group = await tx.group.create({ data: { name: name.trim() } });
      const member = await tx.member.create({
        data: {
          group_id: group.id,
          user_id: authReq.user!.id,
          name: member_name?.trim() || authReq.user!.email.split('@')[0],
        },
      });
      return { ...group, member };
    });

    res.json(result);
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// GET members of a group
router.get('/:id/members', async (req: Request, res: Response): Promise<void> => {
  try {
    const ctx = await requireGroupMember(req, res);
    if (!ctx) return;

    const members = await prisma.member.findMany({ where: { group_id: ctx.groupId } });
    res.json(members);
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// add member (self-join only)
router.post('/:id/members', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const { name, user_id } = req.body;
    const authReq = req as AuthRequest;

    if (!name?.trim()) {
      res.status(400).json({ error: 'Member name is required' });
      return;
    }

    if (user_id !== authReq.user?.id) {
      res.status(403).json({ error: 'You can only add yourself to a group' });
      return;
    }

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const existing = await getMemberForUser(id, authReq.user!.id);
    if (existing) {
      res.json(existing);
      return;
    }

    const member = await prisma.member.create({
      data: {
        group_id: id,
        name: name.trim(),
        user_id,
      },
    });
    res.json(member);
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// GET group expenses
router.get('/:id/expenses', async (req: Request, res: Response): Promise<void> => {
  try {
    const ctx = await requireGroupMember(req, res);
    if (!ctx) return;

    const expenses = await prisma.expense.findMany({
      where: { group_id: ctx.groupId },
      include: { splits: true, confirmations: true },
      orderBy: { created_at: 'asc' },
    });
    res.json(expenses);
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// create expense
router.post('/:id/expenses', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const {
      id: expense_id,
      paid_by,
      amount,
      description,
      splits,
      origin_device,
      supersedes_expense_id,
      created_at,
    } = req.body;
    const authReq = req as AuthRequest;

    const me = await getMemberForUser(id, authReq.user!.id);
    if (!me) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const participantCheck = await validateExpenseParticipants(id, paid_by, splits, Number(amount), me.id);
    if (!participantCheck.valid) {
      res.status(400).json({ error: participantCheck.error });
      return;
    }

    const supersedesCheck = await validateSupersedesExpense(id, supersedes_expense_id);
    if (!supersedesCheck.valid) {
      res.status(400).json({ error: supersedesCheck.error });
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
        },
      });

      for (const split of splits) {
        await tx.expenseSplit.create({
          data: {
            expense_id: expense.id,
            member_id: split.member_id,
            share: split.share,
          },
        });

        const status = split.member_id === me.id ? 'confirmed' : 'pending';
        await tx.expenseConfirmation.create({
          data: {
            expense_id: expense.id,
            member_id: split.member_id,
            status,
          },
        });
      }
      return expense;
    });

    res.json(result);
  } catch (_err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// POST sync endpoint
router.post('/:id/sync', async (req: Request, res: Response): Promise<void> => {
  try {
    const group_id = req.params.id as string;
    const { local_expenses = [], local_confirmations = [] } = req.body;
    const authReq = req as AuthRequest;

    const me = await getMemberForUser(group_id, authReq.user!.id);
    if (!me) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    for (const exp of local_expenses) {
      const exists = await prisma.expense.findUnique({ where: { id: exp.id } });
      if (exists) {
        if (exists.group_id !== group_id) {
          res.status(400).json({ error: 'Expense id already exists in another group' });
          return;
        }
        continue;
      }

      const participantCheck = await validateExpenseParticipants(
        group_id,
        exp.paid_by,
        exp.splits,
        Number(exp.amount),
        me.id
      );
      if (!participantCheck.valid) {
        res.status(400).json({ error: participantCheck.error });
        return;
      }

      const supersedesCheck = await validateSupersedesExpense(
        group_id,
        exp.supersedes_expense_id
      );
      if (!supersedesCheck.valid) {
        res.status(400).json({ error: supersedesCheck.error });
        return;
      }

      await prisma.$transaction(async (tx: any) => {
        await tx.expense.create({
          data: {
            id: exp.id,
            group_id,
            paid_by: exp.paid_by,
            amount: exp.amount,
            description: exp.description,
            origin_device: exp.origin_device,
            supersedes_expense_id: exp.supersedes_expense_id,
            created_at: exp.created_at ? new Date(exp.created_at) : new Date(),
          },
        });

        for (const split of exp.splits) {
          await tx.expenseSplit.create({
            data: {
              expense_id: exp.id,
              member_id: split.member_id,
              share: split.share,
            },
          });

          await tx.expenseConfirmation.create({
            data: {
              expense_id: exp.id,
              member_id: split.member_id,
              status: split.member_id === me.id ? 'confirmed' : 'pending',
              created_at: exp.created_at ? new Date(exp.created_at) : new Date(),
            },
          });
        }
      });
    }

    for (const conf of local_confirmations) {
      if (conf.member_id !== me.id) {
        continue;
      }

      if (!isConfirmationStatus(conf.status)) {
        res.status(400).json({ error: 'Invalid confirmation status' });
        return;
      }

      const confirmationCheck = await validateSyncedConfirmation(
        group_id,
        conf.expense_id,
        conf.member_id
      );
      if (!confirmationCheck.valid) {
        res.status(400).json({ error: confirmationCheck.error });
        return;
      }

      const exists = await prisma.expenseConfirmation.findUnique({
        where: { id: conf.id },
      });
      if (!exists) {
        await prisma.expenseConfirmation.create({
          data: {
            id: conf.id,
            expense_id: conf.expense_id,
            member_id: conf.member_id,
            status: conf.status,
            created_at: new Date(conf.created_at),
          },
        });
      }
    }

    const expenses = await prisma.expense.findMany({
      where: { group_id },
      include: { splits: true },
    });
    const confirmations = await prisma.expenseConfirmation.findMany({
      where: { expense: { group_id } },
    });

    res.json({ expenses, confirmations });
  } catch (_err) {
    res.status(400).json({ error: 'Sync failed' });
  }
});

router.get('/:id/balances', async (req: Request, res: Response): Promise<void> => {
  try {
    const ctx = await requireGroupMember(req, res);
    if (!ctx) return;

    const balances = await computeBalances(ctx.groupId);
    res.json(balances);
  } catch (_err) {
    res.status(400).json({ error: 'Failed' });
  }
});

router.get('/:id/settlements', async (req: Request, res: Response): Promise<void> => {
  try {
    const ctx = await requireGroupMember(req, res);
    if (!ctx) return;

    const balances = await computeBalances(ctx.groupId);
    const settlements = computeSettlements(balances);
    res.json(settlements);
  } catch (_err) {
    res.status(400).json({ error: 'Failed' });
  }
});

export default router;
