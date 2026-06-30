import Dexie, { Table } from 'dexie';

export interface LocalExpense {
  id: string;
  group_id: string;
  paid_by: string;
  amount: number;
  description: string;
  created_at: string;
  origin_device: string | null;
  supersedes_expense_id: string | null;
  synced: boolean;
}

export interface LocalExpenseSplit {
  id: string;
  expense_id: string;
  member_id: string;
  share: number;
}

export interface LocalExpenseConfirmation {
  id: string;
  expense_id: string;
  member_id: string;
  status: 'pending' | 'confirmed' | 'disputed';
  created_at: string;
  synced: boolean;
}

export interface LocalGroup {
  id: string;
  name: string;
  member_count?: number;
  last_activity?: string;
}

export interface LocalMember {
  id: string;
  group_id: string;
  name: string;
  user_id: string;
}

export interface LocalSettlement {
  id: string;
  group_id: string;
  from_member_id: string;
  to_member_id: string;
  amount: number;
  created_at: string;
  synced: boolean;
}

export interface LocalCachedSettlements {
  group_id: string;              // primary key
  settlements: { from: string; to: string; amount: number }[];
  fetched_at: string;
}

export class SplitwiseDB extends Dexie {
  expenses!: Table<LocalExpense, string>;
  expenseSplits!: Table<LocalExpenseSplit, string>;
  expenseConfirmations!: Table<LocalExpenseConfirmation, string>;
  groups!: Table<LocalGroup, string>;
  members!: Table<LocalMember, string>;
  settlements!: Table<LocalSettlement, string>;
  cachedSettlements!: Table<LocalCachedSettlements, string>;

  constructor() {
    super('SplitwiseDB');
    this.version(2).stores({
      expenses: 'id, group_id, synced',
      expenseSplits: 'id, expense_id, member_id',
      expenseConfirmations: 'id, expense_id, member_id, synced',
      groups: 'id',
      members: 'id, group_id, user_id',
      settlements: 'id, group_id, synced',
      cachedSettlements: 'group_id',
    });
  }
}

export const db = new SplitwiseDB();
