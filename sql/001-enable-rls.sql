-- Real-Estate vendor DB — Enable Row Level Security
-- Run in the Supabase SQL Editor for THIS project (qqvegzrpiprkrucunkms).
--
-- CONTEXT: This MCP server connects with the ANON key (not the service role) and
-- only ever does read-only SELECTs. The only table read live is `properties`
-- (a public real-estate listings catalog); `findUserByEmail` is dead code and the
-- server performs NO writes.
--
-- STRATEGY (differs from the within-actions DB, which is deny-all):
--   * Enable RLS on every table in public  -> anon/authenticated denied by default.
--   * Add ONE policy: public SELECT on `properties` -> the catalog stays readable,
--     which is correct (listings are public). Everything else (incl. `users`) and
--     all writes remain blocked.
-- The server keeps working with no code/env changes (anon still reads properties).

-- 1. Enable + force RLS on every base table in the public schema.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', r.tablename);
    RAISE NOTICE 'RLS enabled on %', r.tablename;
  END LOOP;
END $$;

-- 2. Allow public read of the listings catalog ONLY.
DROP POLICY IF EXISTS "public read properties" ON public.properties;
CREATE POLICY "public read properties"
  ON public.properties
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Verify:
--   -- RLS on for every table:
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname;
--   -- exactly one policy, on properties:
--   SELECT tablename, policyname, cmd, roles FROM pg_policies WHERE schemaname = 'public';
