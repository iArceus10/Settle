'use client';
import { useAuth } from '@/lib/auth';
import { useEffect, useState, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import { db, LocalExpense, LocalMember, LocalExpenseConfirmation, LocalSettlement } from '@/lib/db';
import { syncGroup, getUnsyncedCount } from '@/lib/sync';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, RefreshCw, WifiOff, Wifi, CheckCircle2,
  XCircle, Clock, Plus, DollarSign, AlertTriangle, ChevronDown, ChevronUp,
} from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function splitEvenly(amount: number, n: number): number[] {
  const totalCents = Math.round(amount * 100);
  const base = Math.floor(totalCents / n);
  const rem = totalCents % n;
  return Array.from({ length: n }, (_, i) => (base + (i < rem ? 1 : 0)) / 100);
}

type SyncState = 'synced' | 'pending' | 'syncing' | 'error' | 'offline';

interface Settlement { from: string; to: string; amount: number }

// ─── Confirmation Status Badge ─────────────────────────────────────────────
function ConfBadge({ status }: { status: string }) {
  if (status === 'confirmed') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
      <CheckCircle2 size={9} /> Confirmed
    </span>
  );
  if (status === 'disputed') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">
      <XCircle size={9} /> Disputed
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">
      <Clock size={9} /> Pending
    </span>
  );
}

// ─── Correction Modal ──────────────────────────────────────────────────────
function CorrectionModal({
  expense, members, me, groupId, token, onDone, onClose,
}: {
  expense: LocalExpense; members: LocalMember[]; me: LocalMember;
  groupId: string; token: string; onDone: () => void; onClose: () => void;
}) {
  const [desc, setDesc] = useState(expense.description);
  const [amount, setAmount] = useState(String(expense.amount));
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const amt = parseFloat(amount);
    if (!desc.trim() || isNaN(amt) || amt <= 0) { alert('Invalid values'); return; }
    setSubmitting(true);
    try {
      const newExpId = crypto.randomUUID();
      const shares = splitEvenly(amt, members.length);
      const splits = members.map((m, i) => ({ member_id: m.id, share: shares[i]! }));

      await db.expenses.put({
        id: newExpId, group_id: groupId, paid_by: expense.paid_by,
        amount: amt, description: desc.trim(),
        created_at: new Date().toISOString(), origin_device: 'web',
        supersedes_expense_id: expense.id, synced: false,
      });
      for (const [i, m] of members.entries()) {
        await db.expenseSplits.put({ id: crypto.randomUUID(), expense_id: newExpId, member_id: m.id, share: shares[i]! });
        await db.expenseConfirmations.put({
          id: crypto.randomUUID(), expense_id: newExpId, member_id: m.id,
          status: m.id === me.id ? 'confirmed' : 'pending',
          created_at: new Date().toISOString(), synced: false,
        });
      }
      if (navigator.onLine) await syncGroup(groupId, token);
      onDone();
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
      <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-[#12121a] border border-white/10 rounded-2xl p-6 w-full max-w-md space-y-4">
        <h2 className="text-[#e8e8f0] font-bold text-lg">Submit Correction</h2>
        <p className="text-[#6b6b80] text-sm">Creates a new expense superseding the disputed one.</p>
        <input className="input-dark w-full" placeholder="Description" value={desc} onChange={e => setDesc(e.target.value)} />
        <input className="input-dark w-full" type="number" placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 bg-white/5 hover:bg-white/10 text-[#e8e8f0] py-2.5 rounded-xl text-sm font-medium transition-all">Cancel</button>
          <button onClick={submit} disabled={submitting} className="flex-1 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-all">
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Add Expense Modal ─────────────────────────────────────────────────────
function AddExpenseModal({
  members, me, groupId, token, onDone, onClose,
}: {
  members: LocalMember[]; me: LocalMember; groupId: string; token: string;
  onDone: () => void; onClose: () => void;
}) {
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [payerId, setPayerId] = useState(me.id);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(members.map(m => m.id)));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) { if (next.size > 1) next.delete(id); }
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    const amt = parseFloat(amount);
    if (!desc.trim() || isNaN(amt) || amt <= 0) { alert('Enter description and a valid amount'); return; }
    if (!members.find(m => m.id === payerId)) { alert('Invalid payer'); return; }
    const splitMembers = members.filter(m => selectedIds.has(m.id));
    if (!selectedIds.has(me.id)) { alert('You must be included in the split'); return; }
    setSubmitting(true);
    try {
      const newExpId = crypto.randomUUID();
      const shares = splitEvenly(amt, splitMembers.length);
      await db.expenses.put({
        id: newExpId, group_id: groupId, paid_by: payerId,
        amount: amt, description: desc.trim(),
        created_at: new Date().toISOString(), origin_device: 'web',
        supersedes_expense_id: null, synced: false,
      });
      for (const [i, m] of splitMembers.entries()) {
        await db.expenseSplits.put({ id: crypto.randomUUID(), expense_id: newExpId, member_id: m.id, share: shares[i]! });
        await db.expenseConfirmations.put({
          id: crypto.randomUUID(), expense_id: newExpId, member_id: m.id,
          status: m.id === me.id ? 'confirmed' : 'pending',
          created_at: new Date().toISOString(), synced: false,
        });
      }
      if (navigator.onLine) await syncGroup(groupId, token);
      onDone();
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
      <motion.div initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="bg-[#12121a] border border-white/10 rounded-2xl p-6 w-full max-w-md space-y-4">
        <h2 className="text-[#e8e8f0] font-bold text-lg">Add Expense</h2>

        <div>
          <input
            className="input-dark w-full text-2xl font-bold placeholder:text-[#6b6b80]/50 placeholder:text-2xl"
            type="number" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)}
            autoFocus
          />
        </div>
        <input className="input-dark w-full" placeholder="What was it for?" value={desc} onChange={e => setDesc(e.target.value)} />

        {/* Payer selector */}
        <div>
          <label className="text-xs text-[#6b6b80] mb-1.5 block">Paid by</label>
          <select
            className="input-dark w-full"
            value={payerId}
            onChange={e => setPayerId(e.target.value)}
          >
            {members.map(m => <option key={m.id} value={m.id}>{m.name}{m.id === me.id ? ' (you)' : ''}</option>)}
          </select>
        </div>

        {/* Split members */}
        <div>
          <label className="text-xs text-[#6b6b80] mb-1.5 block">Split with</label>
          <div className="flex flex-wrap gap-2">
            {members.map(m => (
              <button
                key={m.id}
                onClick={() => toggle(m.id)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-all ${selectedIds.has(m.id)
                  ? 'bg-violet-500/20 border-violet-500/50 text-violet-300'
                  : 'bg-white/5 border-white/10 text-[#6b6b80]'}`}
              >
                {m.name}{m.id === me.id ? ' (you)' : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 bg-white/5 hover:bg-white/10 text-[#e8e8f0] py-2.5 rounded-xl text-sm font-medium transition-all">Cancel</button>
          <button onClick={submit} disabled={submitting} className="flex-1 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-all">
            {submitting ? 'Saving…' : 'Add Expense'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Expense Card ──────────────────────────────────────────────────────────
function ExpenseCard({
  exp, members, me, confirmations, groupId, token, onAction, isCreator,
}: {
  exp: LocalExpense; members: LocalMember[]; me: LocalMember | null;
  confirmations: LocalExpenseConfirmation[];
  groupId: string; token: string; onAction: () => void;
  isCreator: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showCorrection, setShowCorrection] = useState(false);
  const payer = members.find(m => m.id === exp.paid_by);
  const isSuperseded = !!exp.supersedes_expense_id;

  // Build per-member confirmation map (latest status)
  const memberStatuses = members.reduce<Record<string, string>>((acc, m) => {
    const confs = confirmations
      .filter(c => c.expense_id === exp.id && c.member_id === m.id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    acc[m.id] = confs[0]?.status ?? 'pending';
    return acc;
  }, {});

  const myStatus = me ? (memberStatuses[me.id] ?? 'pending') : null;
  const hasDispute = Object.values(memberStatuses).some(s => s === 'disputed');

  const act = async (status: 'confirmed' | 'disputed') => {
    if (!me) return;
    await db.expenseConfirmations.put({
      id: crypto.randomUUID(), expense_id: exp.id, member_id: me.id,
      status, created_at: new Date().toISOString(), synced: false,
    });
    if (navigator.onLine) await syncGroup(groupId, token);
    onAction();
  };

  return (
    <>
      {showCorrection && me && (
        <CorrectionModal
          expense={exp} members={members} me={me} groupId={groupId} token={token}
          onDone={() => { setShowCorrection(false); onAction(); }}
          onClose={() => setShowCorrection(false)}
        />
      )}
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: isSuperseded ? 0.45 : 1, y: 0 }}
        className={`bg-white/[0.04] border rounded-xl overflow-hidden transition-all
          ${hasDispute ? 'border-red-500/30' : isSuperseded ? 'border-white/5' : 'border-white/10'}`}
      >
        {/* Status stripe */}
        <div className={`h-0.5 ${isSuperseded ? 'bg-[#6b6b80]' : hasDispute ? 'bg-red-500' : 'bg-gradient-to-r from-violet-500 to-cyan-500'}`} />

        <div className="p-4">
          <div className="flex justify-between items-start">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className={`font-semibold text-[#e8e8f0] ${isSuperseded ? 'line-through text-[#6b6b80]' : ''}`}>
                  {exp.description}
                </p>
                {isSuperseded && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#6b6b80]/20 text-[#6b6b80] border border-white/10">Superseded</span>
                )}
                {hasDispute && !isSuperseded && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20 flex items-center gap-1">
                    <AlertTriangle size={9} /> Disputed
                  </span>
                )}
                {!exp.synced && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">⏳ Unsynced</span>
                )}
              </div>
              <p className="text-[#6b6b80] text-xs mt-1">
                {payer?.name ?? 'Unknown'} paid <span className="text-[#e8e8f0] font-mono font-semibold">${Number(exp.amount).toFixed(2)}</span>
                {' · '}{new Date(exp.created_at).toLocaleDateString()}
              </p>
            </div>

            <button onClick={() => setExpanded(v => !v)} className="text-[#6b6b80] hover:text-[#e8e8f0] transition-colors ml-2 mt-0.5">
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>

          {/* Per-member status row */}
          <div className="flex flex-wrap gap-1.5 mt-3">
            {members.map(m => (
              <div key={m.id} className="flex items-center gap-1">
                <span className="text-[10px] text-[#6b6b80]">{m.name}</span>
                <ConfBadge status={memberStatuses[m.id] ?? 'pending'} />
              </div>
            ))}
          </div>

          {/* Actions (only for non-superseded expenses) */}
          {!isSuperseded && myStatus && myStatus !== 'confirmed' && (
            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 flex gap-2 overflow-hidden"
                >
                  <button
                    onClick={() => act('confirmed')}
                    className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-all"
                  >
                    ✓ Confirm
                  </button>
                  {myStatus !== 'disputed' && (
                    <button
                      onClick={() => act('disputed')}
                      className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-all"
                    >
                      ✗ Dispute
                    </button>
                  )}
                  {isCreator && hasDispute && me && (
                    <button
                      onClick={() => setShowCorrection(true)}
                      className="flex-1 text-xs font-semibold px-3 py-2 rounded-lg bg-violet-500/15 text-violet-400 border border-violet-500/20 hover:bg-violet-500/25 transition-all"
                    >
                      ✎ Correct
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          )}
          {/* Show correction even when confirmed if disputed by someone */}
          {!isSuperseded && isCreator && hasDispute && myStatus === 'confirmed' && (
            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 overflow-hidden"
                >
                  <button
                    onClick={() => setShowCorrection(true)}
                    className="w-full text-xs font-semibold px-3 py-2 rounded-lg bg-violet-500/15 text-violet-400 border border-violet-500/20 hover:bg-violet-500/25 transition-all"
                  >
                    ✎ Submit Correction
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </motion.div>
    </>
  );
}

// ─── Settlement Card ───────────────────────────────────────────────────────
function SettlementCard({
  s, members, me, groupId, token, paidAmounts, onPaid,
}: {
  s: Settlement; members: LocalMember[]; me: LocalMember | null;
  groupId: string; token: string;
  paidAmounts: Record<string, number>;
  onPaid: () => void;
}) {
  const fromMember = members.find(m => m.id === s.from);
  const toMember = members.find(m => m.id === s.to);
  const isMyDebt = me && s.from === me.id;
  const paidKey = `${s.from}:${s.to}`;
  const paid = paidAmounts[paidKey] ?? 0;
  const remaining = Math.max(0, s.amount - paid);
  const progress = s.amount > 0 ? Math.min(1, paid / s.amount) : 0;

  const markPaid = async () => {
    if (!me || !isMyDebt) return;
    const settlement: LocalSettlement = {
      id: crypto.randomUUID(), group_id: groupId,
      from_member_id: s.from, to_member_id: s.to,
      amount: remaining, created_at: new Date().toISOString(), synced: false,
    };
    await db.settlements.put(settlement);
    if (navigator.onLine) await syncGroup(groupId, token);
    onPaid();
  };

  return (
    <div className={`bg-white/[0.04] border rounded-xl p-4 ${isMyDebt ? 'border-red-500/20' : 'border-white/10'}`}>
      <div className="flex justify-between items-center">
        <div>
          <span className={`font-semibold text-sm ${isMyDebt ? 'text-red-400' : 'text-[#e8e8f0]'}`}>
            {fromMember?.name ?? s.from.slice(0, 8)}
          </span>
          <span className="text-[#6b6b80] text-sm"> → </span>
          <span className="font-semibold text-sm text-emerald-400">
            {toMember?.name ?? s.to.slice(0, 8)}
          </span>
        </div>
        <div className="text-right">
          <p className="font-mono font-bold text-[#e8e8f0]">${remaining.toFixed(2)}</p>
          {paid > 0 && <p className="text-[10px] text-[#6b6b80]">${paid.toFixed(2)} paid</p>}
        </div>
      </div>

      {/* Progress bar */}
      {paid > 0 && (
        <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      {isMyDebt && remaining > 0 && (
        <button
          onClick={markPaid}
          className="mt-3 w-full text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-all flex items-center justify-center gap-1.5"
        >
          <DollarSign size={12} /> Mark as Paid
        </button>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────
export default function GroupDetails({ params }: { params: Promise<{ id: string }> }) {
  const { user, token } = useAuth();
  const router = useRouter();
  const { id: groupId } = use(params);

  const [expenses, setExpenses] = useState<LocalExpense[]>([]);
  const [members, setMembers] = useState<LocalMember[]>([]);
  const [me, setMe] = useState<LocalMember | null>(null);
  const [confirmations, setConfirmations] = useState<LocalExpenseConfirmation[]>([]);
  const [syncState, setSyncState] = useState<SyncState>('synced');
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [settlementFetchedAt, setSettlementFetchedAt] = useState<string | null>(null);
  const [paidAmounts, setPaidAmounts] = useState<Record<string, number>>({});
  const [isOnline, setIsOnline] = useState(true);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [groupName, setGroupName] = useState('Group');

  const loadLocalData = useCallback(async () => {
    const exp = await db.expenses.where('group_id').equals(groupId).toArray();
    exp.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    setExpenses(exp);

    const mems = await db.members.where('group_id').equals(groupId).toArray();
    setMembers(mems);

    const group = await db.groups.get(groupId);
    if (group) setGroupName(group.name);

    if (user) setMe(mems.find(m => m.user_id === user.id) ?? null);

    const allConfs = await db.expenseConfirmations.toArray();
    const expIds = new Set(exp.map(e => e.id));
    setConfirmations(allConfs.filter(c => expIds.has(c.expense_id)));

    // Compute paid amounts from local settlements
    const localSettlements = await db.settlements.where('group_id').equals(groupId).toArray();
    const paid: Record<string, number> = {};
    for (const s of localSettlements) {
      const key = `${s.from_member_id}:${s.to_member_id}`;
      paid[key] = (paid[key] ?? 0) + s.amount;
    }
    setPaidAmounts(paid);

    // Load cached settlements for offline display
    const cached = await db.cachedSettlements.get(groupId);
    if (cached) {
      setSettlements(cached.settlements);
      setSettlementFetchedAt(cached.fetched_at);
    }

    // Derive sync status from unsynced count
    const unsynced = await getUnsyncedCount(groupId);
    if (unsynced > 0) setSyncState('pending');
  }, [groupId, user]);

  const refreshMembers = useCallback(async () => {
    if (!token || !navigator.onLine) return;
    try {
      const res = await fetch(`${API_URL}/groups/${groupId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const serverMembers: LocalMember[] = await res.json();
      for (const m of serverMembers) await db.members.put(m);
    } catch { /* offline */ }
  }, [groupId, token]);

  const fetchSettlements = useCallback(async () => {
    if (!token || !navigator.onLine) return;
    try {
      const res = await fetch(`${API_URL}/groups/${groupId}/settlements`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data: Settlement[] = await res.json();
      const now = new Date().toISOString();
      setSettlements(data);
      setSettlementFetchedAt(now);
      // Cache for offline
      await db.cachedSettlements.put({ group_id: groupId, settlements: data, fetched_at: now });
    } catch { /* offline — use cached */ }
  }, [groupId, token]);

  const handleSync = useCallback(async () => {
    if (!token) return;
    setSyncState('syncing');
    const ok = await syncGroup(groupId, token);
    if (ok) {
      setSyncState('synced');
      setLastSynced(new Date());
    } else {
      setSyncState('error');
    }
    await loadLocalData();
    await fetchSettlements();
  }, [groupId, token, loadLocalData, fetchSettlements]);

  const ensureMembership = useCallback(async (): Promise<LocalMember | null> => {
    if (!user || !token) return null;
    const cached = await db.members.where({ group_id: groupId, user_id: user.id }).first();
    if (cached) return cached;
    if (!navigator.onLine) { alert('Go online to join this group first.'); return null; }
    const res = await fetch(`${API_URL}/groups/${groupId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: user.email.split('@')[0], user_id: user.id }),
    });
    if (!res.ok) { alert('Failed to join group'); return null; }
    const m: LocalMember = await res.json();
    await db.members.put(m);
    return m;
  }, [groupId, user, token]);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    setIsOnline(navigator.onLine);

    const init = async () => {
      await refreshMembers();
      await loadLocalData();
      // Auto-sync on mount if online
      if (navigator.onLine) await handleSync();
      else await fetchSettlements();
    };
    void init();

    const onOnline = () => { setIsOnline(true); void handleSync(); };
    const onOffline = () => { setIsOnline(false); setSyncState('offline'); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, groupId]);

  const syncIndicator = {
    synced: { color: 'text-emerald-400', dot: 'bg-emerald-400', label: '✓ Synced' },
    pending: { color: 'text-amber-400', dot: 'bg-amber-400', label: '● Unsynced' },
    syncing: { color: 'text-violet-400', dot: 'bg-violet-400 animate-pulse', label: 'Syncing…' },
    error: { color: 'text-red-400', dot: 'bg-red-400', label: '✗ Error' },
    offline: { color: 'text-amber-400', dot: 'bg-amber-400', label: 'Offline' },
  }[syncState];

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  };

  if (!user) return null;

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-[#0a0a0f]">
      {/* Offline banner */}
      <AnimatePresence>
        {!isOnline && (
          <motion.div
            initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}
            className="bg-amber-500/15 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2 text-amber-400 text-xs font-medium"
          >
            <WifiOff size={12} /> Offline — expenses save locally and sync when back online
          </motion.div>
        )}
      </AnimatePresence>

      {showAddExpense && me && (
        <AddExpenseModal
          members={members} me={me} groupId={groupId} token={token!}
          onDone={async () => { setShowAddExpense(false); await loadLocalData(); }}
          onClose={() => setShowAddExpense(false)}
        />
      )}

      <div className="max-w-lg mx-auto w-full px-4 py-6 flex-1 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-[#6b6b80] hover:text-[#e8e8f0] transition-colors text-sm">
            <ArrowLeft size={16} /> Back
          </button>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs">
              <div className={`w-1.5 h-1.5 rounded-full ${syncIndicator.dot}`} />
              <span className={syncIndicator.color}>{syncIndicator.label}</span>
            </div>
            <button
              onClick={handleSync}
              disabled={syncState === 'syncing' || !isOnline}
              className="text-[#6b6b80] hover:text-[#e8e8f0] disabled:opacity-30 transition-all"
              title="Sync now"
            >
              <RefreshCw size={14} className={syncState === 'syncing' ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Group name */}
        <div>
          <h1 className="text-xl font-bold text-[#e8e8f0]">{groupName}</h1>
          {lastSynced && <p className="text-[10px] text-[#6b6b80] mt-0.5">Last synced {timeAgo(lastSynced.toISOString())}</p>}
        </div>

        {/* Members row */}
        {members.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {members.map(m => (
              <span key={m.id} className={`text-[11px] px-2.5 py-1 rounded-full border ${m.id === me?.id
                ? 'bg-violet-500/15 border-violet-500/30 text-violet-300'
                : 'bg-white/5 border-white/10 text-[#6b6b80]'}`}>
                {m.name}{m.id === me?.id ? ' (you)' : ''}
              </span>
            ))}
          </div>
        )}

        {/* Settlements panel */}
        <div className="bg-white/[0.04] border border-white/10 rounded-xl p-4 space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-xs font-bold text-[#6b6b80] uppercase tracking-widest">💸 Settlements</h2>
            {settlementFetchedAt && !isOnline && (
              <span className="text-[10px] text-amber-400">cached · {timeAgo(settlementFetchedAt)}</span>
            )}
          </div>
          {settlements.length === 0 ? (
            <p className="text-xs text-[#6b6b80]">
              {isOnline ? 'All square, or no fully-confirmed expenses yet.' : 'No cached settlements. Go online to fetch.'}
            </p>
          ) : (
            <div className="space-y-2">
              {settlements.map((s, i) => (
                <SettlementCard
                  key={i} s={s} members={members} me={me} groupId={groupId} token={token!}
                  paidAmounts={paidAmounts}
                  onPaid={async () => { await loadLocalData(); await fetchSettlements(); }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Expenses list */}
        <div className="flex justify-between items-center">
          <h2 className="text-base font-bold text-[#e8e8f0]">Expenses</h2>
          <button
            onClick={async () => {
              const member = me ?? await ensureMembership();
              if (member) { setMe(member); setShowAddExpense(true); }
            }}
            className="flex items-center gap-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-violet-900/30"
          >
            <Plus size={13} /> Add Expense
          </button>
        </div>

        <div className="space-y-2 pb-8">
          <AnimatePresence>
            {expenses.map(exp => (
              <ExpenseCard
                key={exp.id}
                exp={exp}
                members={members}
                me={me}
                confirmations={confirmations}
                groupId={groupId}
                token={token!}
                isCreator={exp.paid_by === me?.id}
                onAction={async () => { await loadLocalData(); if (isOnline) await fetchSettlements(); }}
              />
            ))}
          </AnimatePresence>
          {expenses.length === 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mb-3">
                <DollarSign size={20} className="text-violet-400" />
              </div>
              <p className="text-[#e8e8f0] font-semibold text-sm">No expenses yet</p>
              <p className="text-[#6b6b80] text-xs mt-1">Add one to start tracking</p>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
