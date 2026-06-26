'use client';
import { useAuth } from '@/lib/auth';
import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { db, LocalExpense, LocalMember } from '@/lib/db';
import { syncGroup } from '@/lib/sync';
import { motion } from 'framer-motion';

export default function GroupDetails({ params }: { params: Promise<{ id: string }> }) {
  const { user, token } = useAuth();
  const router = useRouter();
  
  // Next 15 requires unwrapping params
  const { id: groupId } = use(params);
  
  const [expenses, setExpenses] = useState<LocalExpense[]>([]);
  const [members, setMembers] = useState<LocalMember[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [settlements, setSettlements] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return router.push('/login');
    loadLocalData();
    window.addEventListener('online', handleSync);
    return () => window.removeEventListener('online', handleSync);
  }, [token, groupId]);

  const loadLocalData = async () => {
    const exp = await db.expenses.where({ group_id: groupId }).toArray();
    exp.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    setExpenses(exp);
    const mems = await db.members.where({ group_id: groupId }).toArray();
    setMembers(mems);

    if (navigator.onLine) {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      fetch(`${API_URL}/groups/${groupId}/settlements`, { headers: { Authorization: `Bearer ${token}` }})
        .then(res => res.json()).then(setSettlements).catch(console.error);
    }
  };

  const handleSync = async () => {
    if (!token) return;
    setSyncing(true);
    await syncGroup(groupId, token);
    await loadLocalData();
    setSyncing(false);
  };

  const addExpense = async () => {
    const desc = prompt('Description:');
    if (!desc) return;
    const amountStr = prompt('Amount:');
    if (!amountStr) return;
    const amount = parseFloat(amountStr);
    
    let me = members.find(m => m.user_id === user?.id);
    if (!me && navigator.onLine) {
       const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
       const res = await fetch(`${API_URL}/groups/${groupId}/members`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
           body: JSON.stringify({ name: user?.email.split('@')[0], user_id: user?.id })
       });
       me = await res.json();
       if (me) {
           await db.members.put(me);
           setMembers([...members, me]);
       }
    }
    if (!me) return alert('You must be a member to add expenses. Please sync online first.');

    const newExpId = crypto.randomUUID();
    const exp: LocalExpense = {
      id: newExpId,
      group_id: groupId,
      paid_by: me.id,
      amount,
      description: desc,
      created_at: new Date().toISOString(),
      origin_device: 'web',
      supersedes_expense_id: null,
      synced: false
    };

    await db.expenses.put(exp);
    for (const m of members) {
      await db.expenseSplits.put({
        id: crypto.randomUUID(),
        expense_id: newExpId,
        member_id: m.id,
        share: amount / members.length
      });
      await db.expenseConfirmations.put({
        id: crypto.randomUUID(),
        expense_id: newExpId,
        member_id: m.id,
        status: m.id === me.id ? 'confirmed' : 'pending',
        created_at: new Date().toISOString(),
        synced: false
      });
    }
    
    await loadLocalData();
    if (navigator.onLine) handleSync();
  };

  const confirmExpense = async (expenseId: string) => {
    let me = members.find(m => m.user_id === user?.id);
    if (!me) return;
    await db.expenseConfirmations.put({
      id: crypto.randomUUID(),
      expense_id: expenseId,
      member_id: me.id,
      status: 'confirmed',
      created_at: new Date().toISOString(),
      synced: false
    });
    if (navigator.onLine) handleSync();
  };

  if (!user) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex-1 flex flex-col pt-8 pb-16">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-bold">Group Details</h1>
        <div className="flex items-center gap-2">
           <div className={`text-xs px-2 py-1 rounded-full ${syncing ? 'bg-yellow-500/20 text-yellow-300' : 'bg-green-500/20 text-green-300'}`}>
             {syncing ? 'Syncing...' : 'Synced'}
           </div>
           <button onClick={handleSync} className="text-xs bg-gray-800 px-2 py-1 rounded hover:bg-gray-700 transition">Sync Now</button>
        </div>
      </div>

      <div className="glass p-4 rounded-xl mb-6">
         <h2 className="text-sm font-semibold text-gray-400 mb-2">Settlements</h2>
         {settlements.length === 0 ? <p className="text-xs text-gray-500">No debts or no fully-confirmed expenses.</p> : (
            settlements.map((s, i) => (
              <div key={i} className="text-sm py-2 border-b border-white/10 last:border-0 flex justify-between">
                 <div>
                    <span className="font-semibold text-red-400">{members.find(m=>m.id===s.from)?.name || s.from.substring(0,6)}</span> owes <span className="font-semibold text-green-400">{members.find(m=>m.id===s.to)?.name || s.to.substring(0,6)}</span>
                 </div>
                 <span className="font-mono">${s.amount}</span>
              </div>
            ))
         )}
      </div>

      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Expenses (Offline-Ready)</h2>
        <button onClick={addExpense} className="btn-primary text-xs px-3 py-1 shadow-lg">+ Add Expense</button>
      </div>

      <div className="space-y-3">
        {expenses.map(exp => (
           <div key={exp.id} className="glass p-4 rounded-lg flex justify-between items-center relative overflow-hidden group">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-500"></div>
              <div className="pl-2">
                 <p className="font-semibold text-white">{exp.description}</p>
                 <p className="text-xs text-gray-400 mt-1">Paid by {members.find(m=>m.id===exp.paid_by)?.name || 'Unknown'} • <span className="text-white">${exp.amount}</span></p>
                 {!exp.synced && <span className="text-[10px] text-yellow-500 mt-1 block">Pending Sync</span>}
              </div>
              <div className="flex gap-2 opacity-80 group-hover:opacity-100 transition">
                 <button onClick={() => confirmExpense(exp.id)} className="text-xs bg-green-500/20 text-green-300 px-3 py-1.5 rounded-md hover:bg-green-500/30 transition">Confirm</button>
              </div>
           </div>
        ))}
        {expenses.length === 0 && <p className="text-sm text-gray-500 text-center py-8">No expenses yet.</p>}
      </div>
    </motion.div>
  );
}
