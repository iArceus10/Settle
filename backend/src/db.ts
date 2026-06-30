import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

type DemoState = {
  users: Row[];
  groups: Row[];
  members: Row[];
  expenses: Row[];
  expenseSplits: Row[];
  expenseConfirmations: Row[];
};

const dataFile = path.join(__dirname, '..', '.data', 'demo-db.json');

const emptyState = (): DemoState => ({
  users: [],
  groups: [],
  members: [],
  expenses: [],
  expenseSplits: [],
  expenseConfirmations: [],
});

let demoState: DemoState = loadDemoState();

function loadDemoState(): DemoState {
  try {
    if (!fs.existsSync(dataFile)) return emptyState();
    return JSON.parse(fs.readFileSync(dataFile, 'utf8')) as DemoState;
  } catch {
    return emptyState();
  }
}

function saveDemoState() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(demoState, null, 2));
}

function now() {
  return new Date();
}

function matchWhere(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in value) return value.in.includes(row[key]);
      return matchWhere(row[key] ?? {}, value as Row);
    }
    return row[key] === value;
  });
}

function sortRows(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0] ?? [];
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const av = new Date(a[key] ?? 0).getTime();
    const bv = new Date(b[key] ?? 0).getTime();
    return dir === 'desc' ? bv - av : av - bv;
  });
}

function selected(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

function createTable(tableName: keyof DemoState, defaults: () => Row = () => ({})) {
  const table = () => demoState[tableName];
  return {
    async create({ data }: { data: Row }) {
      const row = { id: data.id ?? randomUUID(), ...defaults(), ...data };
      table().push(row);
      saveDemoState();
      return { ...row };
    },
    async findUnique({ where, include, select }: { where: Row; include?: Row; select?: Row }) {
      const row = table().find((r) => matchWhere(r, where));
      return row ? decorate(tableName, selected(row, select), include) : null;
    },
    async findFirst({ where }: { where?: Row }) {
      const row = table().find((r) => matchWhere(r, where));
      return row ? { ...row } : null;
    },
    async findMany({ where, include, orderBy, select }: { where?: Row; include?: Row; orderBy?: Row; select?: Row } = {}) {
      const rows = sortRows(table().filter((r) => matchWhere(r, where)), orderBy);
      return rows.map((row) => decorate(tableName, selected(row, select), include));
    },
    async delete({ where }: { where: Row }) {
      const index = table().findIndex((r) => matchWhere(r, where));
      if (index < 0) throw new Error('Record not found');
      const [row] = table().splice(index, 1);
      saveDemoState();
      return { ...row };
    },
  };
}

function decorate(tableName: keyof DemoState, row: Row, include?: Row): Row {
  const copy = { ...row };
  if (tableName === 'expenses' && include) {
    if (include.splits) {
      copy.splits = demoState.expenseSplits.filter((s) => s.expense_id === row.id).map((s) => ({ ...s }));
    }
    if (include.confirmations) {
      copy.confirmations = demoState.expenseConfirmations
        .filter((c) => c.expense_id === row.id)
        .map((c) => ({ ...c, created_at: new Date(c.created_at) }));
    }
    if (include.supersedes) {
      copy.supersedes = demoState.expenses.find((e) => e.supersedes_expense_id === row.id) ?? null;
    }
  }
  return copy;
}

function createDemoPrisma() {
  const client: any = {
    user: createTable('users', () => ({ created_at: now() })),
    group: createTable('groups', () => ({ created_at: now() })),
    member: createTable('members'),
    expense: createTable('expenses', () => ({ created_at: now() })),
    expenseSplit: createTable('expenseSplits'),
    expenseConfirmation: createTable('expenseConfirmations', () => ({ status: 'pending', created_at: now() })),
    async $transaction<T>(callback: (tx: typeof client) => Promise<T>) {
      const snapshot = JSON.stringify(demoState);
      try {
        const result = await callback(client);
        saveDemoState();
        return result;
      } catch (err) {
        demoState = JSON.parse(snapshot) as DemoState;
        saveDemoState();
        throw err;
      }
    },
  };
  return client;
}

function createPostgresPrisma() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma: any = process.env.USE_POSTGRES === 'true'
  ? createPostgresPrisma()
  : createDemoPrisma();
