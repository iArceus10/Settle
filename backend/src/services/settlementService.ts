import { prisma } from '../db';

export async function computeBalances(groupId: string) {
  // 1. Fetch all expenses for the group, along with their splits and confirmations
  const expenses = await prisma.expense.findMany({
    where: { group_id: groupId },
    include: {
      splits: true,
      confirmations: true,
      supersedes: true, // to check if this expense has been superseded by a newer one
    },
  });

  const balances: Record<string, number> = {};

  for (const expense of expenses) {
    // Exclude if it has been superseded by a newer expense
    if (expense.supersedes) {
      continue;
    }

    // Check unanimous confirmation
    let isFullyConfirmed = true;
    for (const split of expense.splits) {
      // Find the LATEST confirmation for this member and this expense
      const memberConfirms = expense.confirmations
        .filter((c: any) => c.member_id === split.member_id)
        .sort((a: any, b: any) => b.created_at.getTime() - a.created_at.getTime());
      
      const latestConfirm = memberConfirms[0];
      if (!latestConfirm || latestConfirm.status !== 'confirmed') {
        isFullyConfirmed = false;
        break;
      }
    }

    if (isFullyConfirmed) {
      // Apply to balances
      // Payer is owed the amount they paid
      balances[expense.paid_by] = (balances[expense.paid_by] || 0) + Number(expense.amount);

      // Each split member owes their share
      for (const split of expense.splits) {
        balances[split.member_id] = (balances[split.member_id] || 0) - Number(split.share);
      }
    }
  }

  return balances;
}

export function computeSettlements(balances: Record<string, number>) {
  const debtors: { id: string; amount: number }[] = [];
  const creditors: { id: string; amount: number }[] = [];

  for (const [id, bal] of Object.entries(balances)) {
    if (bal < -0.01) debtors.push({ id, amount: -bal });
    else if (bal > 0.01) creditors.push({ id, amount: bal });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  let i = 0;
  let j = 0;
  const transactions: { from: string; to: string; amount: number }[] = [];

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];

    const amount = Math.min(debtor.amount, creditor.amount);
    const roundedAmount = Math.round(amount * 100) / 100;
    
    if (roundedAmount > 0) {
       transactions.push({
         from: debtor.id,
         to: creditor.id,
         amount: roundedAmount,
       });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount < 0.01) i++;
    if (creditor.amount < 0.01) j++;
  }

  return transactions;
}
