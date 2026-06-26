import { db } from './db';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function syncGroup(groupId: string, token: string) {
  try {
    const allExpenses = await db.expenses.where({ group_id: groupId }).toArray();
    const localExpensesToSync = allExpenses.filter(e => e.synced === false);

    const expensesWithSplits = await Promise.all(
      localExpensesToSync.map(async (exp) => {
        const splits = await db.expenseSplits.where({ expense_id: exp.id }).toArray();
        return { ...exp, splits };
      })
    );

    const allConfirms = await db.expenseConfirmations.toArray();
    const localConfirmationsToSync = allConfirms.filter(c => c.synced === false);

    const response = await fetch(`${API_URL}/groups/${groupId}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        local_expenses: expensesWithSplits,
        local_confirmations: localConfirmationsToSync,
      }),
    });

    if (!response.ok) throw new Error('Sync failed');

    const data = await response.json();
    const serverExpenses = data.expenses;
    const serverConfirmations = data.confirmations;

    await db.transaction('rw', db.expenses, db.expenseSplits, db.expenseConfirmations, async () => {
      // Mark our sent items as synced
      for (const e of localExpensesToSync) {
        await db.expenses.update(e.id, { synced: true });
      }
      for (const c of localConfirmationsToSync) {
        await db.expenseConfirmations.update(c.id, { synced: true });
      }

      // Upsert server expenses
      for (const se of serverExpenses) {
        await db.expenses.put({
          id: se.id,
          group_id: se.group_id,
          paid_by: se.paid_by,
          amount: Number(se.amount),
          description: se.description,
          created_at: se.created_at,
          origin_device: se.origin_device,
          supersedes_expense_id: se.supersedes_expense_id,
          synced: true,
        });

        // Upsert splits
        for (const sp of se.splits) {
          await db.expenseSplits.put({
            id: sp.id,
            expense_id: sp.expense_id,
            member_id: sp.member_id,
            share: Number(sp.share),
          });
        }
      }

      // Upsert server confirmations
      for (const sc of serverConfirmations) {
        await db.expenseConfirmations.put({
          id: sc.id,
          expense_id: sc.expense_id,
          member_id: sc.member_id,
          status: sc.status,
          created_at: sc.created_at,
          synced: true,
        });
      }
    });

    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}
