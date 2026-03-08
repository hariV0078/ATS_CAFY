-- Create custom types for subscription status
CREATE TYPE public.subscription_status AS ENUM ('active', 'canceled', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'trialing');

-- Create subscriptions table linked to auth.users
CREATE TABLE public.subscriptions (
  id TEXT PRIMARY KEY, -- this is the stripe subscription ID
  user_id UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
  status public.subscription_status NOT NULL,
  price_id TEXT,
  quantity INTEGER,
  cancel_at_period_end BOOLEAN,
  cancel_at TIMESTAMP WITH TIME ZONE,
  canceled_at TIMESTAMP WITH TIME ZONE,
  current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  created TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
  ended_at TIMESTAMP WITH TIME ZONE,
  trial_start TIMESTAMP WITH TIME ZONE,
  trial_end TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Allow users to view their own subscription
CREATE POLICY "Users can view own subscription" 
  ON public.subscriptions FOR SELECT 
  USING (auth.uid() = user_id);

-- Create a table for Stripe customers mapping
CREATE TABLE public.customers (
  id UUID REFERENCES auth.users(id) PRIMARY KEY, -- auth.users.id
  stripe_customer_id TEXT UNIQUE
);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- Allow users to view their own customer data
CREATE POLICY "Users can view own customer record" 
  ON public.customers FOR SELECT 
  USING (auth.uid() = id);

-- Notify postgrest to reload the schema
NOTIFY pgrst, 'reload schema';
