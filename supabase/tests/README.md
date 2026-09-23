# Database rule tests

Each `.sql` file here runs inside a transaction that ends in `rollback`, using a
throwaway test user, so it is safe to run against the production project
(e.g. via the Supabase SQL editor or the MCP `execute_sql` tool). Every row of
the final `select` should have `ok = true`.
