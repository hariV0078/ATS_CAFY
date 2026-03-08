import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createAdminClient } from '@/utils/supabase/admin';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
    apiVersion: '2026-02-25.clover'
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

async function syncSubscription(subscriptionId: string) {
    console.log(`Syncing subscription: ${subscriptionId}`);
    const supabaseAdmin = createAdminClient();

    const subscription = (await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price']
    })) as any;

    // Get the user_id from the customers mapping table
    const { data: customerData, error: customerError } = await supabaseAdmin
        .from('customers')
        .select('id')
        .eq('stripe_customer_id', subscription.customer as string)
        .maybeSingle();

    if (customerError) {
        console.error(`Database error fetching customer mapping: ${customerError.message}`);
        throw customerError;
    }

    if (!customerData?.id) {
        console.warn(`No user found for customer ${subscription.customer}`);
        return;
    }

    const { error: upsertError } = await supabaseAdmin.from('subscriptions').upsert({
        id: subscription.id,
        user_id: customerData.id,
        status: subscription.status,
        price_id: (subscription as any).items.data[0]?.price?.id || null,
        quantity: (subscription as any).items.data[0]?.quantity || 1,
        cancel_at_period_end: subscription.cancel_at_period_end,
        cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
        canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        created: new Date(subscription.created * 1000).toISOString(),
        ended_at: subscription.ended_at ? new Date(subscription.ended_at * 1000).toISOString() : null,
        trial_start: subscription.trial_start ? new Date(subscription.trial_start * 1000).toISOString() : null,
        trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
    });

    if (upsertError) {
        console.error(`Database error upserting subscription: ${upsertError.message}`);
        throw upsertError;
    }

    console.log(`Successfully synced subscription ${subscription.id} for user ${customerData.id}`);
}

export async function POST(req: Request) {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature') as string;

    let event: Stripe.Event;
    console.log(`Webhook received: ${req.method} ${req.url}`);

    try {
        if (!webhookSecret) {
            throw new Error('Missing stripe webhook secret');
        }
        event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (error: any) {
        console.error(`Webhook Error: ${error.message}`);
        return new NextResponse(`Webhook Error: ${error.message}`, { status: 400 });
    }

    const supabaseAdmin = createAdminClient();

    try {
        console.log(`Processing event: ${event.type}`);
        switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted':
                const subscription = event.data.object as Stripe.Subscription;
                await syncSubscription(subscription.id);
                break;

            case 'checkout.session.completed':
                const session = event.data.object as Stripe.Checkout.Session;
                if (session.mode === 'subscription' && session.subscription) {
                    await syncSubscription(session.subscription as string);
                }
                break;

            case 'invoice.payment_succeeded':
                const invoice = event.data.object as any;
                if (invoice.subscription) {
                    await syncSubscription(invoice.subscription as string);
                }
                break;

            default:
                console.log(`Unhandled event type ${event.type}`);
        }
    } catch (error: any) {
        console.error('Error syncing Stripe to Supabase:', error);
        return new NextResponse(`Webhook handler failed: ${error.message}`, { status: 500 });
    }

    return NextResponse.json({ received: true });
}
