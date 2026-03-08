'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState, useEffect } from 'react';
import { getSubscriptionStatus } from '../../actions/subscriptionActions';

// TO DO: Replace with your actual Stripe Price ID
const PRO_PRICE_ID = 'price_1T8phzEj3rV8qCmFGviBCokH';

export default function SubscriptionPage() {
    const [isPro, setIsPro] = useState(false);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);

    useEffect(() => {
        const fetchStatus = async () => {
            const { isPro } = await getSubscriptionStatus();
            setIsPro(isPro);
            setLoading(false);
        };
        fetchStatus();
    }, []);

    const handleCheckout = async () => {
        setActionLoading(true);
        try {
            const res = await fetch('/api/stripe/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ priceId: PRO_PRICE_ID })
            });
            const data = await res.json();
            if (data.url) {
                window.location.href = data.url;
            }
        } catch (e) {
            console.error(e);
            alert('Failed to initiate checkout.');
        }
        setActionLoading(false);
    };

    const handleManageBilling = async () => {
        setActionLoading(true);
        try {
            const res = await fetch('/api/stripe/portal', {
                method: 'POST'
            });
            const data = await res.json();
            if (data.url) {
                window.location.href = data.url;
            }
        } catch (e) {
            console.error(e);
            alert('Failed to open billing portal.');
        }
        setActionLoading(false);
    };

    if (loading) {
        return <div className="text-slate-500 animate-pulse">Loading subscription status...</div>;
    }

    return (
        <div className="max-w-3xl">
            <div className="mb-8">
                <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Your Subscription</h2>
                <p className="text-slate-500 dark:text-slate-400">View and manage your billing plan.</p>
            </div>

            <div className="border border-[var(--border)] rounded-lg p-8 bg-slate-50 dark:bg-slate-900/20">
                <div className="flex items-start justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            {isPro ? 'Pro Plan' : 'Free Plan'}
                            <span className="text-xs font-semibold bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400 px-2.5 py-0.5 rounded-full">Current</span>
                        </h3>
                        <p className="text-slate-500 dark:text-slate-400 mt-2 text-sm">
                            {isPro
                                ? 'Full access to all premium features and unrestricted search.'
                                : 'Basic access to the public database with limited filtering.'}
                        </p>
                    </div>
                </div>

                <div className="mt-8 space-y-3">
                    <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                        <CheckCircle2 className="w-4 h-4 text-brand-500" />
                        <span>Browse 1000+ UK Sponsored Jobs</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                        <CheckCircle2 className="w-4 h-4 text-brand-500" />
                        <span>Search Companies database {isPro ? '(Unlimited)' : '(Limited)'}</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                        <CheckCircle2 className="w-4 h-4 text-brand-500" />
                        <span>Save Profile Preferences</span>
                    </div>
                </div>

                <div className="mt-8 pt-6 border-t border-[var(--border)]">
                    {isPro ? (
                        <button
                            onClick={handleManageBilling}
                            disabled={actionLoading}
                            className="bg-white border hover:bg-slate-50 text-slate-700 font-medium px-4 py-2 rounded-md shadow-sm transition-colors text-sm flex items-center gap-2"
                        >
                            {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            Manage Subscription
                        </button>
                    ) : (
                        <button
                            onClick={handleCheckout}
                            disabled={actionLoading}
                            className="bg-brand-600 hover:bg-brand-500 text-white font-medium px-4 py-2 rounded-md shadow-sm transition-colors text-sm flex items-center gap-2"
                        >
                            {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                            Upgrade to Pro (£0.99/Week)
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
