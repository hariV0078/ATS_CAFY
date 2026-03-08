import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@/utils/supabase/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
    apiVersion: '2026-02-25.clover'
});

export async function POST(req: Request) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
            return new NextResponse('Unauthorized', { status: 401 });
        }

        const { data: customerData } = await supabase
            .from('customers')
            .select('stripe_customer_id')
            .eq('id', user.id)
            .single();

        if (!customerData?.stripe_customer_id) {
            return new NextResponse('No Stripe customer associated with user', { status: 400 });
        }

        const { origin } = new URL(req.url);

        const session = await stripe.billingPortal.sessions.create({
            customer: customerData.stripe_customer_id,
            return_url: `${origin}/account/subscription`,
        });

        return NextResponse.json({ url: session.url });
    } catch (error: any) {
        console.error('Stripe Portal Error:', error);
        return new NextResponse(error.message, { status: 500 });
    }
}
