'use server';

import { createClient } from '@/utils/supabase/server';
import { cache } from 'react';

export const getSubscriptionStatus = cache(async () => {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return { isPro: false, subscription: null };
    }

    const { data: subscription, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['trialing', 'active'])
        .maybeSingle();

    if (error) {
        console.error('Error fetching subscription status:', error);
    }

    console.log(`Subscription check for ${user.id}:`, subscription);

    return {
        isPro: !!subscription,
        subscription: subscription || null,
    };
});

export async function bypassPaymentForTesting() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        throw new Error('Unauthorized');
    }

    const now = new Date();
    const future = new Date();
    future.setFullYear(now.getFullYear() + 10); // 10 years in the future

    const { error } = await supabase
        .from('subscriptions')
        .upsert({
            id: `sub_bypass_${Math.random().toString(36).substring(7)}`,
            user_id: user.id,
            status: 'active',
            price_id: 'price_bypass_testing',
            quantity: 1,
            current_period_start: now.toISOString(),
            current_period_end: future.toISOString(),
            created: now.toISOString(),
        });

    if (error) {
        console.error('Error bypassing payment:', error);
        throw error;
    }

    return { success: true };
}
