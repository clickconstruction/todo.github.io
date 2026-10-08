# Database rule tests

Each `.sql` file here runs inside a transaction that ends in `rollback`, using a
throwaway test user, so it is safe to run against the production project.
Run one with `python3 dev/sbq.py supabase/tests/<file>.sql` (the Supabase CLI's
saved login), or paste it into the Supabase SQL editor. Every row of the final
`select` should have `ok = true`.
