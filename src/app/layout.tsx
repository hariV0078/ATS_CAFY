import type { Metadata } from "next";
import { Suspense } from "react";
import { DM_Sans } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import { createClient } from "@/utils/supabase/server";

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Getlanded | UK Sponsored Jobs",
  description: "Discover tech roles from verified UK visa sponsors and land your dream job.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let user = null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch (error) {
    console.error('Error in RootLayout auth check:', error);
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${dmSans.variable} font-sans antialiased`} suppressHydrationWarning>
        <Suspense fallback={<div className="h-16" />}>
          <Navbar user={user} />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
