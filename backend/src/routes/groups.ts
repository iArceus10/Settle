import { Router } from 'express';
import { prisma } from '../db';
import { authenticate } from '../middleware/auth';
import { computeBalances, computeSettlements } from '../services/settlementService';
import crypto from 'crypto';

const router = Router();
router.use(authenticate);

// create group
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    const group = await prisma.group.create({ data: { name } });
    res.json(group);
  } catch (err) {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// add member
router.post('/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, user_id } = req.body;
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
router.get('/:id/expenses', async (req, res) => {
  try {
    const { id } = req.params;
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
router.post('/:id/expenses', async (req, res) => {
  try {
    const { id } = req.params;
    const { id: expense_id, paid_by, amount, description, splits, origin_device, supersedes_expense_id, created_at } = req.body;
    
    // splits: Array<{ member_id, share }>
    // Insert expense, splits, and auto-confirmations in one transaction
    const result = await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          id: expense_id, // Client-generated UUID
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

        // Auto-create confirmation
        const status = split.member_id === paid_by ? 'confirmed' : 'pending';
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
    res.status(400).json({ error: 'Invalid request', details: err });
  }
});

// POST sync endpoint
router.post('/:id/sync', async (req, res) => {
  // body: { local_expenses: [], local_confirmations: [] }
  try {
     const { id: group_id } = req.params;
     const { local_expenses, local_confirmations } = req.body;

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

     // Merge local confirmations
     for(const conf of local_confirmations) {
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

     // Return all expenses and confirmations for this group so client can dedupe
     const expenses = await prisma.expense.findMany({ where: { group_id }, include: { splits: true } });
     const confirmations = await prisma.expenseConfirmation.findMany({ 
         where: { expense: { group_id } }
     });

     res.json({ expenses, confirmations });
  } catch (err) {
     res.status(400).json({ error: 'Sync failed', details: err });
  }
});

router.get('/:id/balances', async (req, res) => {
  try {
    const balances = await computeBalances(req.params.id);
    res.json(balances);
  } catch(err) {
    res.status(400).json({ error: 'Failed' });
  }
});

router.get('/:id/settlements', async (req, res) => {
  try {
    const balances = await computeBalances(req.params.id);
    const settlements = computeSettlements(balances);
    res.json(settlements);
  } catch(err) {
    res.status(400).json({ error: 'Failed' });
  }
});

export default router;
