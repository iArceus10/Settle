'use client';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { motion } from 'framer-motion';
import Link from 'next/link';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login } = useAuth();
  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) throw new Error('Signup failed');
      const data = await res.json();
      login(data.token, data.user);
    } catch (err) {
      alert('Signup failed');
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex-1 flex flex-col justify-center">
      <div className="glass rounded-2xl p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-white">Create Account</h1>
          <p className="text-gray-400 text-sm">Join the decentralized splitwise</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input className="input-premium w-full" type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input className="input-premium w-full" type="password" placeholder="Password (min 6 chars)" value={password} onChange={e => setPassword(e.target.value)} required />
          <button type="submit" className="btn-primary w-full mt-4">Sign Up</button>
        </form>
        <div className="text-center text-sm text-gray-400">
          Already have an account? <Link href="/login" className="text-blue-400 hover:text-blue-300">Sign In</Link>
        </div>
      </div>
    </motion.div>
  );
}
