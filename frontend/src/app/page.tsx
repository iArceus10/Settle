'use client';
import { useAuth } from '@/lib/auth';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { db, LocalGroup } from '@/lib/db';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, Plus, LogOut, ArrowRight, Wifi, WifiOff } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function Dashboard() {
  const { user, token, logout } = useAuth();
  const router = useRouter();
  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [joinId, setJoinId] = useState('');
  const [joining, setJoining] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showJoinInput, setShowJoinInput] = useState(false);

  const loadGroups = useCallback(async () => {
    // Always load from local first for instant display
    const local = await db.groups.toArray();
    setGroups(local);

    // Then fetch from server and merge
    if (!token || !navigator.onLine) return;
    try {
      const res = await fetch(`${API_URL}/groups`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const serverGroups: LocalGroup[] = await res.json();
      for (const g of serverGroups) {
        await db.groups.put({ id: g.id, name: g.name });
      }
      const merged = await db.groups.toArray();
      setGroups(merged);
    } catch {
      // offline — keep local
    }
  }, [token]);

  useEffect(() => {
    if (!token) { router.push('/login'); return; }
    setIsOnline(navigator.onLine);
    void loadGroups();
    const onOnline = () => { setIsOnline(true); void loadGroups(); };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [token, router, loadGroups]);

  const createGroup = async () => {
    const name = prompt('Group name:');
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_URL}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim(), member_name: user?.email.split('@')[0] }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      await db.groups.put({ id: data.id, name: data.name });
      if (data.member) await db.members.put(data.member);
      await loadGroups();
      router.push(`/groups/${data.id}`);
    } catch {
      alert('Failed to create group. Are you online?');
    } finally {
      setCreating(false);
    }
  };

  const joinGroup = async () => {
    if (!joinId.trim()) return;
    setJoining(true);
    try {
      const res = await fetch(`${API_URL}/groups/${joinId.trim()}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: user?.email.split('@')[0], user_id: user?.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to join group');
      }
      const member = await res.json();
      await db.members.put(member);
      // Fetch and cache the group info
      const gRes = await fetch(`${API_URL}/groups`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (gRes.ok) {
        const serverGroups: LocalGroup[] = await gRes.json();
        for (const g of serverGroups) await db.groups.put({ id: g.id, name: g.name });
      }
      setJoinId('');
      setShowJoinInput(false);
      await loadGroups();
      router.push(`/groups/${joinId.trim()}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to join group');
    } finally {
      setJoining(false);
    }
  };

  if (!user) return null;

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-[#0a0a0f]">
      {/* Offline banner */}
      <AnimatePresence>
        {!isOnline && (
          <motion.div
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -40, opacity: 0 }}
            className="bg-amber-500/15 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2 text-amber-400 text-xs font-medium"
          >
            <WifiOff size={12} />
            Offline — showing cached data
          </motion.div>
        )}
      </AnimatePresence>

      <div className="max-w-lg mx-auto w-full px-4 py-8 flex-1 flex flex-col">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-2xl font-bold text-[#e8e8f0] tracking-tight">Settle</h1>
            <p className="text-[#6b6b80] text-xs mt-0.5 flex items-center gap-1">
              {isOnline ? <Wifi size={10} className="text-emerald-400" /> : <WifiOff size={10} className="text-amber-400" />}
              {user.email}
            </p>
          </div>
          <button onClick={logout} className="text-[#6b6b80] hover:text-[#e8e8f0] transition-colors flex items-center gap-1.5 text-sm">
            <LogOut size={14} />
            Sign out
          </button>
        </motion.div>

        {/* Action bar */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={createGroup}
            disabled={creating || !isOnline}
            className="flex-1 flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm font-semibold px-4 py-3 rounded-xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-violet-900/30"
          >
            <Plus size={16} />
            {creating ? 'Creating…' : 'New Group'}
          </button>
          <button
            onClick={() => setShowJoinInput(v => !v)}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-[#e8e8f0] text-sm font-medium px-4 py-3 rounded-xl transition-all duration-200"
          >
            <Users size={16} />
            Join
          </button>
        </div>

        {/* Join by ID */}
        <AnimatePresence>
          {showJoinInput && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-6 overflow-hidden"
            >
              <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
                <p className="text-xs text-[#6b6b80]">Paste a group ID to join it</p>
                <div className="flex gap-2">
                  <input
                    className="flex-1 bg-white/5 border border-white/10 text-[#e8e8f0] placeholder:text-[#6b6b80] px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-violet-500 transition-colors"
                    placeholder="Group UUID…"
                    value={joinId}
                    onChange={e => setJoinId(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && joinGroup()}
                  />
                  <button
                    onClick={joinGroup}
                    disabled={joining || !joinId.trim() || !isOnline}
                    className="bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-all"
                  >
                    {joining ? '…' : 'Join'}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Groups list */}
        <div className="space-y-3 flex-1">
          <AnimatePresence>
            {groups.map((g, i) => (
              <motion.div
                key={g.id}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <Link
                  href={`/groups/${g.id}`}
                  className="block bg-white/[0.04] hover:bg-white/[0.07] border border-white/10 hover:border-violet-500/30 rounded-xl p-4 transition-all duration-200 group"
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <h2 className="text-[#e8e8f0] font-semibold">{g.name}</h2>
                      <p className="text-[#6b6b80] text-xs mt-0.5 font-mono">{g.id.slice(0, 12)}…</p>
                    </div>
                    <ArrowRight size={16} className="text-[#6b6b80] group-hover:text-violet-400 group-hover:translate-x-0.5 transition-all" />
                  </div>
                </Link>
              </motion.div>
            ))}
          </AnimatePresence>

          {groups.length === 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.2 } }} className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-14 h-14 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mb-4">
                <Users size={24} className="text-violet-400" />
              </div>
              <p className="text-[#e8e8f0] font-semibold">No groups yet</p>
              <p className="text-[#6b6b80] text-sm mt-1">Create one or join with an ID</p>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
