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
  synced?: boolean;
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
  status: string;
  created_at: string;
  synced?: boolean;
}

export interface LocalGroup {
  id: string;
  name: string;
}

export interface LocalMember {
  id: string;
  group_id: string;
  name: string;
  user_id: string;
}

export class SplitwiseDB extends Dexie {
  expenses!: Table<LocalExpense, string>;
  expenseSplits!: Table<LocalExpenseSplit, string>;
  expenseConfirmations!: Table<LocalExpenseConfirmation, string>;
  groups!: Table<LocalGroup, string>;
  members!: Table<LocalMember, string>;

  constructor() {
    super('SplitwiseDB');
    this.version(1).stores({
      expenses: 'id, group_id, synced',
      expenseSplits: 'id, expense_id',
      expenseConfirmations: 'id, expense_id, synced',
      groups: 'id',
      members: 'id, group_id',
    });
  }
}

export const db = new SplitwiseDB();
