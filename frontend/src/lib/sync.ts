import { db } from './db';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function syncGroup(groupId: string, token: string): Promise<boolean> {
  try {
    // Collect unsynced expenses for this specific group
    const allExpenses = await db.expenses.where({ group_id: groupId }).toArray();
    const localExpensesToSync = allExpenses.filter(e => e.synced === false);

    const expensesWithSplits = await Promise.all(
      localExpensesToSync.map(async (exp) => {
        const splits = await db.expenseSplits.where({ expense_id: exp.id }).toArray();
        return { ...exp, splits };
      })
    );

    // Bug fix: scope confirmations to THIS group's expenses only, not all groups
    const groupExpenseIds = new Set(allExpenses.map(e => e.id));
    const allConfirms = await db.expenseConfirmations.toArray();
    const localConfirmationsToSync = allConfirms.filter(
      c => c.synced === false && groupExpenseIds.has(c.expense_id)
    );

    const response = await fetch(`${API_URL}/groups/${groupId}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        local_expenses: expensesWithSplits,
        local_confirmations: localConfirmationsToSync,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Sync rejected by server:', errData);
      return false;
    }

    const data = await response.json();
    const serverExpenses: any[] = data.expenses ?? [];
    const serverConfirmations: any[] = data.confirmations ?? [];

    // Write everything in a single Dexie transaction for atomicity
    await db.transaction('rw', db.expenses, db.expenseSplits, db.expenseConfirmations, async () => {
      // Mark our sent items as synced
      for (const e of localExpensesToSync) {
        await db.expenses.update(e.id, { synced: true });
      }
      for (const c of localConfirmationsToSync) {
        await db.expenseConfirmations.update(c.id, { synced: true });
      }

      // Upsert server expenses into local DB
      for (const se of serverExpenses) {
        await db.expenses.put({
          id: se.id,
          group_id: se.group_id,
          paid_by: se.paid_by,
          amount: Number(se.amount),
          description: se.description,
          created_at: se.created_at,
          origin_device: se.origin_device ?? null,
          supersedes_expense_id: se.supersedes_expense_id ?? null,
          synced: true,
        });

        for (const sp of se.splits ?? []) {
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
    console.error('Sync error:', err);
    return false;
  }
}
