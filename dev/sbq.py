#!/usr/bin/env python3
# Run SQL on the todo-tooling Supabase project through the Management API, using the Supabase CLI's
# saved login (the same route the Supabase MCP's apply_migration takes). Used to apply a migration and
# to run the rule tests in supabase/tests/. The token is read, sent in the request header, and never
# printed.
#   python3 dev/sbq.py supabase/migrations/<file>.sql
#   python3 dev/sbq.py supabase/tests/<file>.sql          (every row of the result should say ok: true)
#   python3 dev/sbq.py -c "<sql>"
# The login is looked up the way the CLI does: SUPABASE_ACCESS_TOKEN, then the macOS keychain
# ("Supabase CLI", account = the profile, default "supabase"), then ~/.supabase/access-token.
import base64, json, os, subprocess, sys, urllib.request

REF = 'cgssdelgtxlrfgozchps'

def keychain(service, account=None):
    cmd = ['security', 'find-generic-password', '-s', service] + (['-a', account] if account else []) + ['-w']
    r = subprocess.run(cmd, capture_output=True, text=True)
    v = r.stdout.strip() if r.returncode == 0 else ''
    if v.startswith('go-keyring-base64:'):  # go-keyring wraps values it can't store as-is
        v = base64.b64decode(v[len('go-keyring-base64:'):]).decode()
    return v

def token():
    tried = []
    def ok(v, source):
        if not v: return None
        if v.startswith('sbp_'): return v
        tried.append(f'{source} (not an sbp_ token, {len(v)} chars)')
        return None
    env = ok(os.environ.get('SUPABASE_ACCESS_TOKEN', ''), 'SUPABASE_ACCESS_TOKEN')
    if env: return env
    profile = os.environ.get('SUPABASE_PROFILE', 'supabase')
    for svc, acct in (('Supabase CLI', profile), ('Supabase CLI', None), ('supabase', None)):
        v = ok(keychain(svc, acct), f'keychain {svc}/{acct or "*"}')
        if v: return v
    p = os.path.expanduser('~/.supabase/access-token')
    if os.path.exists(p):
        v = ok(open(p).read().strip(), p)
        if v: return v
    sys.exit('No usable Supabase CLI login found. Tried: ' + ('; '.join(tried) or 'nothing stored') + '. Run `supabase login`, or set SUPABASE_ACCESS_TOKEN.')

if len(sys.argv) < 2:
    sys.exit('usage: sbq.py <file.sql> | -c "<sql>"')
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
