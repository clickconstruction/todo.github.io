-- Trigger-only helper: nobody needs to call it via RPC. (Triggers don't require EXECUTE at fire time.)
revoke execute on function public.forbid_delete() from public, anon, authenticated;
