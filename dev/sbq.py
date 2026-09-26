#!/usr/bin/env python3
# Run SQL on the todo-tooling Supabase project through the Management API, using the Supabase CLI's
# saved login (the same route the Supabase MCP's apply_migration takes). Used to apply a migration and
# to run the rule tests in supabase/tests/. The token is read, sent in the request header, and never
# printed.
#   python3 dev/sbq.py supabase/migrations/<file>.sql
#   python3 dev/sbq.py supabase/tests/<file>.sql          (every row of the result should say ok: true)
#   python3 dev/sbq.py -c "<sql>"
import json, os, subprocess, sys, urllib.request

REF = 'cgssdelgtxlrfgozchps'

def token():
    p = os.path.expanduser('~/.supabase/access-token')
    if os.path.exists(p):
        return open(p).read().strip()
    for svc in ('Supabase CLI', 'supabase'):
        r = subprocess.run(['security', 'find-generic-password', '-s', svc, '-w'], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    sys.exit('no saved Supabase CLI login found (run: supabase login)')

if len(sys.argv) < 2:
    sys.exit(__doc__ or 'usage: sbq.py <file.sql> | -c "<sql>"')
sql = sys.argv[2] if sys.argv[1] == '-c' else open(sys.argv[1]).read()
req = urllib.request.Request(
    f'https://api.supabase.com/v1/projects/{REF}/database/query',
    data=json.dumps({'query': sql}).encode(),
    headers={'Authorization': f'Bearer {token()}', 'Content-Type': 'application/json', 'User-Agent': 'todotooling-migrate/1.0'})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        out = r.read().decode()
        try:
            rows = json.loads(out)
            print(json.dumps(rows, indent=1)[:20000] if rows else 'ok (no rows)')
        except ValueError:
            print(out[:20000])
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read().decode()[:2000])
    sys.exit(1)
