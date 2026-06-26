'use client';
import { useAuth } from '@/lib/auth';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { db, LocalGroup } from '@/lib/db';
import Link from 'next/link';
import { motion } from 'framer-motion';

export default function Dashboard() {
  const { user, token, logout } = useAuth();
  const router = useRouter();
  const [groups, setGroups] = useState<LocalGroup[]>([]);

  useEffect(() => {
    if (!token) {
      router.push('/login');
      return;
    }
    loadGroups();
  }, [token, router]);

  const loadGroups = async () => {
    const local = await db.groups.toArray();
    setGroups(local);
  };

  const createGroup = async () => {
    const name = prompt('Group Name:');
    if (!name) return;
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const res = await fetch(`${API_URL}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      await db.groups.put({ id: data.id, name: data.name });
      loadGroups();
    } catch(err) {
      alert('Failed to create group');
    }
  };

  if (!user) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex-1 flex flex-col pt-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold">Your Groups</h1>
          <p className="text-xs text-gray-400 mt-1">{user.email}</p>
        </div>
        <div className="space-x-2">
          <button onClick={createGroup} className="btn-primary text-sm px-4 py-2">+ New</button>
          <button onClick={logout} className="text-gray-400 text-sm hover:text-white transition">Logout</button>
        </div>
      </div>

      <div className="space-y-4">
        {groups.map(g => (
          <Link key={g.id} href={`/groups/${g.id}`} className="block glass p-4 rounded-xl hover:bg-white/10 transition">
            <h2 className="text-lg font-semibold">{g.name}</h2>
          </Link>
        ))}
        {groups.length === 0 && (
          <div className="text-center text-gray-500 py-8">No groups yet. Create one!</div>
        )}
      </div>
    </motion.div>
  );
}
