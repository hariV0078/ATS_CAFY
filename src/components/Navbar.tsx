
'use client';

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Logo from './Logo';
import { Menu, X, MessageSquare } from 'lucide-react';

interface NavbarProps {
    user: any;
}

const Navbar: React.FC<NavbarProps> = ({ user }) => {
    const pathname = usePathname();
    const [mobileOpen, setMobileOpen] = useState(false);
    const navRef = useRef<HTMLElement>(null);

    // Close menu when clicking outside the navbar
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (navRef.current && !navRef.current.contains(e.target as Node)) {
                setMobileOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Prevent body scroll when mobile menu is open
    useEffect(() => {
        if (mobileOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    }, [mobileOpen]);

    const navLinks = [
        { name: 'Jobs', href: '/jobs' },
        { name: 'Companies', href: '/companies' },
        { name: 'Sponsorship Hub', href: '/sponsorship-hub' },
        { name: 'Applied', href: '/applied' },
    ];

    const isActive = (path: string) => pathname === path;

    const isAuthPage = ['/login', '/signup', '/forgot-password', '/reset-password'].includes(pathname);

    if (isAuthPage) {
        return null;
    }

    return (
        <>
            <nav ref={navRef} className="fixed top-0 w-full z-50 glass border-b border-(--border)">
                <div className="max-w-full mx-auto px-4 sm:px-6 lg:px-12 h-16 flex items-center justify-between">
                    {/* Logo */}
                    <Link href="/" className="flex items-center gap-2" onClick={() => setMobileOpen(false)}>
                        <div className="text-[#0066FF]">
                            <Logo className="w-8 h-8" />
                        </div>
                        <span className="text-xl font-black text-[#0066FF] tracking-tighter">
                            Getlanded
                        </span>
                    </Link>

                    {/* Desktop Navigation */}
                    <div className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
                        <a
                            href="https://getlanded.canny.io/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold text-slate-400 hover:text-[#0066FF] transition-colors flex items-center gap-1.5"
                        >
                            <MessageSquare className="w-3.5 h-3.5" />
                            Report a bug or suggest a feature
                        </a>
                        <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1"></div>
                        {navLinks.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href}
                                className={`${isActive(link.href)
                                    ? 'text-[#0066FF] font-semibold border-b-2 border-[#0066FF] pb-1'
                                    : 'hover:text-[#0066FF] transition-colors'
                                    }`}
                            >
                                {link.name}
                            </Link>
                        ))}

                        {user ? (
                            <div className="flex items-center gap-4">
                                <form action="/auth/signout" method="POST">
                                    <button type="submit" className="text-slate-500 hover:text-rose-500 font-semibold text-sm transition-colors">
                                        Sign out
                                    </button>
                                </form>
                                <Link href="/account/profile" className={`bg-[#0066FF] hover:bg-[#0052CC] text-white px-5 py-2 flex items-center gap-2 rounded-none transition-all shadow-md font-bold text-sm active:scale-95 ${pathname.startsWith('/account') ? 'ring-2 ring-offset-2 ring-[#0066FF]' : ''}`}>
                                    Account
                                </Link>
                            </div>
                        ) : (
                            <Link href="/login" className="bg-[#0066FF] hover:bg-[#0052CC] text-white px-5 py-2 rounded-none transition-all shadow-md font-bold text-sm active:scale-95">
                                Sign in
                            </Link>
                        )}
                    </div>

                    {/* Mobile — Hamburger button */}
                    <button
                        className="flex md:hidden items-center justify-center p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        onClick={() => setMobileOpen((prev) => !prev)}
                        aria-label="Toggle menu"
                    >
                        {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                    </button>
                </div>

                {/* Mobile Drawer — slides down below navbar */}
                <div
                    className={`md:hidden overflow-hidden transition-all duration-300 ease-in-out border-t border-(--border) ${mobileOpen ? 'max-h-[400px] opacity-100' : 'max-h-0 opacity-0'
                        } glass`}
                >
                    <div className="px-4 py-4 flex flex-col gap-1">
                        {navLinks.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href}
                                onClick={() => setMobileOpen(false)}
                                className={`px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${isActive(link.href)
                                    ? 'text-[#0066FF] bg-blue-50 dark:bg-blue-900/20'
                                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                                    }`}
                            >
                                {link.name}
                            </Link>
                        ))}

                        <div className="border-t border-(--border) mt-2 pt-3 flex flex-col gap-2">
                            {user ? (
                                <>
                                    <Link
                                        key={link.href}
                                        href={link.href}
                                        onClick={() => setMobileOpen(false)}
                                        className={`block px-5 py-3 rounded-2xl text-base font-semibold transition-colors ${isActive(link.href)
                                            ? 'text-[#0066FF] bg-blue-50 dark:bg-blue-900/20'
                                            : 'text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                                            }`}
                                    >
                                        {link.name}
                                    </Link>
                                ))}
                            </div>

                            {/* Account / auth actions */}
                            <div className="w-full max-w-sm flex flex-col gap-3 text-center">
                                {user ? (
                                    <>
                                        <Link
                                            href="/account/profile"
                                            onClick={() => setMobileOpen(false)}
                                            className={`block px-5 py-3 rounded-2xl text-base font-semibold transition-colors ${pathname.startsWith('/account')
                                                ? 'text-[#0066FF] bg-blue-50 dark:bg-blue-900/20'
                                                : 'text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                                                }`}
                                        >
                                            Account
                                        </Link>
                                        <form action="/auth/signout" method="POST">
                                            <button
                                                type="submit"
                                                className="w-full text-center px-5 py-3 rounded-2xl text-base font-semibold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                                            >
                                                Sign out
                                            </button>
                                        </form>
                                    </>
                                ) : (
                                    <Link
                                        href="/login"
                                        onClick={() => setMobileOpen(false)}
                                        className="block w-full text-center bg-[#0066FF] hover:bg-[#0052CC] text-white px-5 py-3 rounded-2xl font-bold text-base transition-colors"
                                    >
                                        Sign in
                                    </Link>
                                )}

                                <a
                                    href="https://getlanded.canny.io/"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-1 block px-5 py-3 rounded-2xl text-sm font-semibold text-slate-500 hover:text-[#0066FF] hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors"
                                >
                                    <span className="inline-flex items-center justify-center gap-2">
                                        <MessageSquare className="w-4 h-4" />
                                        Report a bug or suggest a feature
                                    </span>
                                </a>
                            </div>
                        </div>
                    </div>
                )}
            </nav>
        </>
    );
};

export default Navbar;
