import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';

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

        // Check if user already has a stripe customer ID
        const { data: customerData } = await supabase
            .from('customers')
            .select('stripe_customer_id')
            .eq('id', user.id)
            .single();

        let customerId = customerData?.stripe_customer_id;

        if (!customerId) {
            // Create a new customer in Stripe
            const customer = await stripe.customers.create({
                email: user.email,
                metadata: {
                    supabaseUUID: user.id
                }
            });

            customerId = customer.id;

            // Use admin client to bypass RLS for this critical mapping
            const supabaseAdmin = createAdminClient();
            const { error: insertError } = await supabaseAdmin
                .from('customers')
                .upsert({ id: user.id, stripe_customer_id: customerId });

            if (insertError) {
                console.error('Error saving customer mapping:', insertError);
                throw new Error('Failed to create customer record');
            }

            console.log(`Saved customer mapping: ${user.id} -> ${customerId}`);
        } else {
            console.log(`Found existing customer mapping: ${user.id} -> ${customerId}`);
        }

        const { priceId } = await req.json();

        const { origin } = new URL(req.url);

        // Create Checkout Sessions
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: 'subscription',
            payment_method_types: ['card'],
            customer_update: {
                address: 'auto',
                name: 'auto',
            },
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: `${origin}/account/subscription?success=true`,
            cancel_url: `${origin}/account/subscription?canceled=true`,
        });

        return NextResponse.json({ url: session.url });
    } catch (error: any) {
        console.error('Stripe Checkout Error:', error);
        return new NextResponse(error.message, { status: 500 });
    }
}
