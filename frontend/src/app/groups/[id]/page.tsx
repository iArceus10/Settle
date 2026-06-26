'use client';
import { useAuth } from '@/lib/auth';
import { useEffect, useState, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import { db, LocalExpense, LocalMember } from '@/lib/db';
import { syncGroup } from '@/lib/sync';
import { motion } from 'framer-motion';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function GroupDetails({ params }: { params: Promise<{ id: string }> }) {
  const { user, token } = useAuth();
  const router = useRouter();
  const { id: groupId } = use(params);

  const [expenses, setExpenses] = useState<LocalExpense[]>([]);
  const [members, setMembers] = useState<LocalMember[]>([]);
  const [me, setMe] = useState<LocalMember | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'pending' | 'error'>('synced');
  const [settlements, setSettlements] = useState<{ from: string; to: string; amount: number }[]>([]);

  // Fetch settlements from server when online
  const fetchSettlements = useCallback(async () => {
    if (!token || !navigator.onLine) return;
    try {
      const res = await fetch(`${API_URL}/groups/${groupId}/settlements`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setSettlements(await res.json());
    } catch {
      // Not critical — silently skip if offline
    }
  }, [groupId, token]);

  // Pull members from server and upsert locally
  const refreshMembers = useCallback(async () => {
    if (!token || !navigator.onLine) return;
    try {
      const res = await fetch(`${API_URL}/groups/${groupId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const serverMembers: LocalMember[] = await res.json();
      for (const m of serverMembers) {
        await db.members.put(m);
      }
    } catch {
      // offline — use cached
    }
  }, [groupId, token]);

  const loadLocalData = useCallback(async () => {
    const exp = await db.expenses.where('group_id').equals(groupId).toArray();
    exp.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    setExpenses(exp);

    const mems = await db.members.where('group_id').equals(groupId).toArray();
    setMembers(mems);

    if (user) {
      const myMember = mems.find(m => m.user_id === user.id) ?? null;
      setMe(myMember);
    }
  }, [groupId, user]);

  const handleSync = useCallback(async () => {
    if (!token) return;
    setSyncing(true);
    const ok = await syncGroup(groupId, token);
    setSyncStatus(ok ? 'synced' : 'error');
    await loadLocalData();
    await fetchSettlements();
    setSyncing(false);
  }, [groupId, token, loadLocalData, fetchSettlements]);

  useEffect(() => {
    if (!token) {
      router.push('/login');
      return;
    }
    const init = async () => {
      await refreshMembers();
      await loadLocalData();
      await fetchSettlements();
    };
    init();

    const onOnline = () => handleSync();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [token, router, refreshMembers, loadLocalData, fetchSettlements, handleSync]);

  // Ensure the current user is a group member (auto-join if online)
  const ensureMembership = useCallback(async (): Promise<LocalMember | null> => {
    if (!user || !token) return null;

    // Check local first
    const cached = await db.members.where({ group_id: groupId, user_id: user.id }).first();
    if (cached) return cached;

    // Not a member yet — join on server
    if (!navigator.onLine) {
      alert('You must be online to join a group for the first time.');
      return null;
    }

    const res = await fetch(`${API_URL}/groups/${groupId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: user.email.split('@')[0], user_id: user.id }),
    });
    if (!res.ok) {
      alert('Failed to join group');
      return null;
    }
    const newMember: LocalMember = await res.json();
    await db.members.put(newMember);
    setMe(newMember);
    setMembers(prev => [...prev, newMember]);
    return newMember;
  }, [groupId, user, token]);

  const addExpense = async () => {
    const desc = prompt('Description:');
    if (!desc?.trim()) return;
    const amountStr = prompt('Amount (e.g. 120.50):');
    if (!amountStr) return;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      alert('Please enter a valid positive amount.');
      return;
    }

    const member = me ?? await ensureMembership();
    if (!member) return;

    // Re-fetch latest members to split with
    const currentMembers = await db.members.where('group_id').equals(groupId).toArray();
    if (currentMembers.length === 0) {
      alert('No members found in group.');
      return;
    }

    const newExpId = crypto.randomUUID();
    const sharePerMember = parseFloat((amount / currentMembers.length).toFixed(2));

    await db.expenses.put({
      id: newExpId,
      group_id: groupId,
      paid_by: member.id,
      amount,
      description: desc.trim(),
      created_at: new Date().toISOString(),
      origin_device: 'web',
      supersedes_expense_id: null,
      synced: false,
    });

    for (const m of currentMembers) {
      await db.expenseSplits.put({
        id: crypto.randomUUID(),
        expense_id: newExpId,
        member_id: m.id,
        share: sharePerMember,
      });
      await db.expenseConfirmations.put({
        id: crypto.randomUUID(),
        expense_id: newExpId,
        member_id: m.id,
        // Fix: only creator (me) is auto-confirmed, not the payer
        status: m.id === member.id ? 'confirmed' : 'pending',
        created_at: new Date().toISOString(),
        synced: false,
      });
    }

    setSyncStatus('pending');
    await loadLocalData();

    if (navigator.onLine) await handleSync();
  };

  const confirmExpense = async (expenseId: string) => {
    const member = me ?? await ensureMembership();
    if (!member) return;

    // Check if already confirmed
    const existing = await db.expenseConfirmations
      .where({ expense_id: expenseId, member_id: member.id })
      .toArray();
    const latest = existing.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (latest?.status === 'confirmed') {
      alert('You have already confirmed this expense.');
      return;
    }

    await db.expenseConfirmations.put({
      id: crypto.randomUUID(),
      expense_id: expenseId,
      member_id: member.id,
      status: 'confirmed',
      created_at: new Date().toISOString(),
      synced: false,
    });

    setSyncStatus('pending');
    await loadLocalData();
    if (navigator.onLine) await handleSync();
  };

  if (!user) return null;

  const statusColor = {
    synced: 'bg-green-500/20 text-green-300',
    pending: 'bg-yellow-500/20 text-yellow-300',
    error: 'bg-red-500/20 text-red-300',
  }[syncStatus];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex-1 flex flex-col pt-8 pb-16">
      <div className="flex justify-between items-center mb-6">
        <button onClick={() => router.push('/')} className="text-gray-400 text-sm hover:text-white transition">← Back</button>
        <div className="flex items-center gap-2">
          <div className={`text-xs px-2 py-1 rounded-full transition ${syncing ? 'bg-yellow-500/20 text-yellow-300' : statusColor}`}>
            {syncing ? 'Syncing…' : syncStatus === 'synced' ? '✓ Synced' : syncStatus === 'pending' ? '● Unsynced' : '✗ Sync Error'}
          </div>
          <button onClick={handleSync} disabled={syncing} className="text-xs bg-gray-800 px-3 py-1.5 rounded-lg hover:bg-gray-700 transition disabled:opacity-40">
            Sync Now
          </button>
        </div>
      </div>

      {/* Settlements */}
      <div className="glass p-4 rounded-xl mb-6">
        <h2 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-widest">💸 Settlements</h2>
        {settlements.length === 0 ? (
          <p className="text-xs text-gray-500">All square, or no fully-confirmed expenses yet.</p>
        ) : (
          settlements.map((s, i) => (
            <div key={i} className="text-sm py-2 border-b border-white/10 last:border-0 flex justify-between items-center">
              <span>
                <span className="font-semibold text-red-400">{members.find(m => m.id === s.from)?.name ?? s.from.slice(0, 8)}</span>
                {' → '}
                <span className="font-semibold text-green-400">{members.find(m => m.id === s.to)?.name ?? s.to.slice(0, 8)}</span>
              </span>
              <span className="font-mono text-white">${s.amount.toFixed(2)}</span>
            </div>
          ))
        )}
      </div>

      {/* Expenses */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Expenses</h2>
        <button onClick={addExpense} className="btn-primary text-xs px-4 py-2">+ Add Expense</button>
      </div>

      <div className="space-y-3">
        {expenses.map(exp => {
          const payer = members.find(m => m.id === exp.paid_by);
          return (
            <div key={exp.id} className="glass p-4 rounded-lg flex justify-between items-center relative overflow-hidden group">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-500 rounded-l-lg" />
              <div className="pl-3">
                <p className="font-semibold text-white">{exp.description}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  Paid by <span className="text-blue-300">{payer?.name ?? 'Unknown'}</span>
                  {' · '}<span className="text-white font-mono">${Number(exp.amount).toFixed(2)}</span>
                </p>
                {!exp.synced && <span className="text-[10px] text-yellow-400 mt-1 block">⏳ Pending sync</span>}
              </div>
              <button
                onClick={() => confirmExpense(exp.id)}
                className="text-xs bg-green-500/20 text-green-300 px-3 py-1.5 rounded-md hover:bg-green-500/30 transition opacity-80 group-hover:opacity-100"
              >
                Confirm
              </button>
            </div>
          );
        })}
        {expenses.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-12">No expenses yet. Add one!</p>
        )}
      </div>

      {/* Members list */}
      {members.length > 0 && (
        <div className="mt-8">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">Members</h3>
          <div className="flex flex-wrap gap-2">
            {members.map(m => (
              <span key={m.id} className={`text-xs px-3 py-1 rounded-full ${m.id === me?.id ? 'bg-blue-500/30 text-blue-200' : 'bg-white/10 text-gray-300'}`}>
                {m.name}{m.id === me?.id ? ' (you)' : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}
