import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Decentralized Splitwise",
  description: "Offline-first immutable expense splitting",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased min-h-screen">
        <AuthProvider>
          <main className="max-w-md mx-auto min-h-screen relative p-4 flex flex-col">
            {children}
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
