'use client';
import React, { createContext, useContext, useState } from 'react';
import { useRouter } from 'next/navigation';
import { db } from './db';

interface User {
  id: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(() => {
    if (typeof window === 'undefined') return null;
    const storedUser = localStorage.getItem('settle_user');
    if (!storedUser) return null;
    try {
      return JSON.parse(storedUser) as User;
    } catch {
      localStorage.removeItem('settle_user');
      return null;
    }
  });
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('settle_token');
  });
  const router = useRouter();

  const login = (newToken: string, newUser: User) => {
    // Clear any stale data from a previous session before storing the new one
    void db.delete().then(() => db.open());
    localStorage.setItem('settle_token', newToken);
    localStorage.setItem('settle_user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
    router.push('/');
  };

  const logout = () => {
    // Clear ALL local Dexie data so stale data never bleeds between sessions
    void db.delete().then(() => db.open());
    localStorage.removeItem('settle_token');
    localStorage.removeItem('settle_user');
    setToken(null);
    setUser(null);
    router.push('/login');
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
