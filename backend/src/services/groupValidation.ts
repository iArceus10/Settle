import { prisma } from '../db';

export async function getMemberForUser(group_id: string, user_id: string) {
  return prisma.member.findFirst({
    where: { group_id, user_id },
  });
}

export async function getGroupMemberIdSet(group_id: string): Promise<Set<string>> {
  const members = await prisma.member.findMany({
    where: { group_id },
    select: { id: true },
  });
  return new Set(members.map((m: { id: string }) => m.id));
}

export async function validateExpenseParticipants(
  group_id: string,
  paid_by: string,
  splits: { member_id: string; share: number }[] | undefined,
  amount?: number,
  creator_member_id?: string
): Promise<{ valid: true } | { valid: false; error: string }> {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { valid: false, error: 'At least one split is required' };
  }

  if (amount !== undefined && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    return { valid: false, error: 'Amount must be a positive number' };
  }

  const groupMemberIds = await getGroupMemberIdSet(group_id);

  if (!groupMemberIds.has(paid_by)) {
    return { valid: false, error: 'Payer must be a member of this group' };
  }

  const splitMemberIds = new Set<string>();
  let shareTotal = 0;
  for (const split of splits) {
    if (!groupMemberIds.has(split.member_id)) {
      return { valid: false, error: 'All split members must belong to this group' };
    }

    if (splitMemberIds.has(split.member_id)) {
      return { valid: false, error: 'Split members must be unique' };
    }

    if (!Number.isFinite(Number(split.share)) || Number(split.share) <= 0) {
      return { valid: false, error: 'Split shares must be positive numbers' };
    }

    splitMemberIds.add(split.member_id);
    shareTotal += Number(split.share);
  }

  if (creator_member_id && !splitMemberIds.has(creator_member_id)) {
    return { valid: false, error: 'Expense creator must be included in the split' };
  }

  if (amount !== undefined) {
    const totalCents = Math.round(shareTotal * 100);
    const amountCents = Math.round(Number(amount) * 100);
    if (totalCents !== amountCents) {
      return { valid: false, error: 'Split shares must add up to the expense amount' };
    }
  }

  return { valid: true };
}

export function isConfirmationStatus(status: unknown): status is 'pending' | 'confirmed' | 'disputed' {
  return status === 'pending' || status === 'confirmed' || status === 'disputed';
}

export async function validateSupersedesExpense(
  group_id: string,
  supersedes_expense_id: string | null | undefined
): Promise<{ valid: true } | { valid: false; error: string }> {
  if (!supersedes_expense_id) {
    return { valid: true };
  }

  const original = await prisma.expense.findUnique({
    where: { id: supersedes_expense_id },
    include: { supersedes: true },
  });

  if (!original) {
    return { valid: false, error: 'Superseded expense not found' };
  }

  if (original.group_id !== group_id) {
    return { valid: false, error: 'Superseded expense must belong to this group' };
  }

  if (original.supersedes) {
    return { valid: false, error: 'Expense has already been superseded' };
  }

  return { valid: true };
}

type AuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export async function authorizeConfirmationAction(
  expense_id: string,
  member_id: string,
  user_id: string
): Promise<AuthResult> {
  const member = await prisma.member.findUnique({ where: { id: member_id } });
  if (!member || member.user_id !== user_id) {
    return { ok: false, status: 403, error: 'Unauthorized for this member' };
  }

  const expense = await prisma.expense.findUnique({
    where: { id: expense_id },
    include: { splits: true, supersedes: true },
  });

  if (!expense) {
    return { ok: false, status: 404, error: 'Expense not found' };
  }

  if (expense.supersedes) {
    return { ok: false, status: 400, error: 'Cannot act on a superseded expense' };
  }

  if (member.group_id !== expense.group_id) {
    return { ok: false, status: 403, error: 'Member is not in this expense\'s group' };
  }

  const callerMember = await getMemberForUser(expense.group_id, user_id);
  if (!callerMember) {
    return { ok: false, status: 403, error: 'Not a member of this group' };
  }

  const isParticipant = expense.splits.some((s: { member_id: string }) => s.member_id === member_id);
  if (!isParticipant) {
    return { ok: false, status: 403, error: 'Member is not a participant in this expense' };
  }

  return { ok: true };
}

export async function validateSyncedConfirmation(
  group_id: string,
  expense_id: string,
  member_id: string
): Promise<{ valid: true } | { valid: false; error: string }> {
  const expense = await prisma.expense.findUnique({
    where: { id: expense_id },
    include: { splits: true },
  });

  if (!expense) {
    return { valid: false, error: 'Confirmation references unknown expense' };
  }

  if (expense.group_id !== group_id) {
    return { valid: false, error: 'Confirmation expense is not in this group' };
  }

  const isParticipant = expense.splits.some((s: { member_id: string }) => s.member_id === member_id);
  if (!isParticipant) {
    return { valid: false, error: 'Confirmation member is not a participant in this expense' };
  }

  return { valid: true };
}
