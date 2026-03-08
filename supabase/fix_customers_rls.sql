-- Allow users to insert their own customer record (required for checkout flow)
CREATE POLICY "Users can insert own customer record"
  ON public.customers FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Notify postgrest to reload the schema
NOTIFY pgrst, 'reload schema';
