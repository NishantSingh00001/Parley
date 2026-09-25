#!/usr/bin/env python3
"""End-to-end API tests for Parley (Python 3 standard library only).

Run the app with `netlify dev`, then:  python3 tests/api_test.py [base-url]
It signs up test users and posts test messages, so it refuses to run against
anything but localhost unless you pass --yes.
"""
import json, sys, urllib.request, threading, time, concurrent.futures as cf, random
args = [a for a in sys.argv[1:] if not a.startswith('--')]
B = (args[0] if args else 'http://localhost:8888').rstrip('/')
if not B.startswith(('http://localhost', 'http://127.0.0.1')) and '--yes' not in sys.argv:
    sys.exit(f'Refusing to create test data on {B}. Pass --yes if you really mean it.')
FAILED = []
def call(method, path, body=None, token=None, raw=False, headers=None):
    h = {'content-type':'application/json'} if body is not None and not isinstance(body, bytes) else {}
    if headers: h.update(headers)
    if token: h['authorization'] = 'Bearer ' + token
    data = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
    req = urllib.request.Request(B+path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b or b'null'))
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b)
        except Exception: return e.code, b[:200]
def ok(c, msg):
    print(('PASS ' if c else 'FAIL ') + msg)
    if not c: FAILED.append(msg)
s, A = call('POST', '/api/auth/guest'); ok(s==201 and A['user']['guest'], f"guest A {A['user']['name']} @{A['user']['handle']}")
s, Bu = call('POST', '/api/auth/guest'); ok(s==201, f"guest B {Bu['user']['name']}")
h = 'nishant' + str(random.randint(100,999))
s, C = call('POST', '/api/auth/signup', {'handle': h, 'name': 'Nishant Singh', 'password': 'secret-pass-1'}); ok(s==201, f"signup C @{h}")
s, r = call('POST', '/api/auth/signup', {'handle': h, 'name': 'Xavier', 'password': 'another-pass'}); ok(s==409, f"duplicate handle -> {s} {r}")
s, r = call('POST', '/api/auth/login', {'handle': h, 'password': 'wrong-pass'}); ok(s==401, f"wrong password -> {s}")
s, r = call('POST', '/api/auth/login', {'handle': '@'+h.upper(), 'password': 'secret-pass-1'}); ok(s==200 and r['user']['handle']==h, "login with @HANDLE")
s, r = call('POST', '/api/auth/signup', {'handle': 'ab', 'name': 'X', 'password': 'short'}); ok(s==400, f"bad signup -> {r['error']}")
s, r = call('GET', '/api/bootstrap'); ok(s==401, "bootstrap without token -> 401")
s, r = call('GET', '/api/bootstrap', token='abc.def.ghi'); ok(s==401, "forged token -> 401")
ta, tb, tc = A['token'], Bu['token'], C['token']
s, boot = call('GET', '/api/bootstrap', token=ta); ok(s==200 and len(boot['convs'])==4, f"bootstrap rooms: {[c['id'] for c in boot['convs']]}")
s, r = call('GET', '/api/convs/lobby/messages?after=-1', token=ta); ok(s==200 and r['messages'] and r['messages'][0]['type']=='system', f"lobby welcome: {r['messages'][0]['text'][:50]}")
base = r['head']['seq']
# concurrency: 40 messages from 3 users at once
def send(i):
    t = [ta, tb, tc][i % 3]
    return call('POST', '/api/convs/lobby/messages', {'text': f'hello {i}'}, token=t)
t0=time.time()
with cf.ThreadPoolExecutor(12) as ex: res = list(ex.map(send, range(40)))
codes = [c for c,_ in res]
seqs = sorted(r['message']['seq'] for c,r in res if c==201)
limited = codes.count(429)
ok(len(seqs)+limited==40 and seqs == list(range(base+1, base+1+len(seqs))), f"40 concurrent sends: {len(seqs)} stored with contiguous unique seqs, {limited} rate-limited, {time.time()-t0:.1f}s")
s, r = call('GET', f'/api/convs/lobby/messages?after={base}', token=tb)
got = [m['text'] for m in r['messages']]
ok(len(got)==len(seqs), f"B reads back {len(got)} new messages")
# DM
s, dm = call('POST', '/api/convs', {'type':'dm', 'with': Bu['user']['id']}, token=ta); ok(s==201, f"DM created {dm['conv']['id'][:20]}…")
cid = dm['conv']['id']
s, dm2 = call('POST', '/api/convs', {'type':'dm', 'with': A['user']['id']}, token=tb); ok(dm2['conv']['id']==cid, "same DM id from the other side")
s, m1 = call('POST', f'/api/convs/{cid}/messages', {'text':'hey B, @gemini what is RFM?'}, token=ta); ok(s==201 and m1['message']['mentionsGemini'], "DM message with @gemini flagged")
s, boot_b = call('GET', '/api/bootstrap', token=tb); ok(boot_b['inbox']['convs'][cid]['unread']==1, f"B unread in DM = {boot_b['inbox']['convs'][cid]['unread']}")
s, r = call('POST', f'/api/convs/{cid}/read', {'seq': m1['message']['seq']}, token=tb); ok(s==200, "B marks read")
s, r = call('GET', f'/api/convs/{cid}', token=ta); ok(r['conv']['head']['reads'].get(Bu['user']['id'])==m1['message']['seq'], "A sees B's read receipt")
s, r = call('GET', f'/api/convs/{cid}/messages', token=tc); ok(s==401, f"C can't read A-B DM -> {s}")
s, r = call('GET', f'/api/sync?c={cid}&s=-1', token=tc); ok(s==200 and cid not in r['heads'] and not r['messages'], "C's sync can't peek at A-B DM")
# group
s, g = call('POST', '/api/convs', {'type':'group', 'name':'Final year squad', 'members':[Bu['user']['id'], C['user']['id']]}, token=ta); ok(s==201 and len(g['conv']['members'])==3, "group created with 3 members")
gid = g['conv']['id']
s, r = call('POST', f'/api/convs/{gid}/messages', {'text':'placement drive tomorrow?'}, token=tc); ok(s==201, "C posts in group")
s, bc = call('GET', '/api/bootstrap', token=ta); ok(bc['inbox']['convs'][gid]['unread']==1 and bc['inbox']['convs'][gid]['preview'].startswith('placement'), "A group unread + preview")
# reactions / edit / delete
seq = m1['message']['seq']
s, r = call('PATCH', f'/api/convs/{cid}/messages/{seq}', {'react':'🔥'}, token=tb); ok(r['message']['reactions']=={'🔥':[Bu['user']['id']]}, "B reacts 🔥")
s, r = call('PATCH', f'/api/convs/{cid}/messages/{seq}', {'react':'🔥'}, token=tb); ok(r['message']['reactions']=={}, "B un-reacts")
s, r = call('PATCH', f'/api/convs/{cid}/messages/{seq}', {'text':'edited by B'}, token=tb); ok(s==401, "B can't edit A's message")
s, r = call('PATCH', f'/api/convs/{cid}/messages/{seq}', {'text':'hey B (edited)'}, token=ta); ok(r['message']['edited'] and r['message']['text']=='hey B (edited)', "A edits own message")
s, h = call('GET', f'/api/convs/{cid}', token=ta); ok(h['conv']['head']['rv']>=3, f"head rv bumped to {h['conv']['head']['rv']}")
# reply + moderation in room
s, r = call('POST', '/api/convs/lobby/messages', {'text':'this is shit', 'replyTo': seqs[0]}, token=tc); ok(r['message']['text']=='this is s•••' and r['message']['replyTo']['seq']==seqs[0], f"room moderation + reply: {r['message']['text']!r}")
# typing
s, r = call('POST', f'/api/convs/{cid}/typing', {}, token=ta)
s, h = call('GET', f'/api/convs/{cid}', token=tb); ok(A['user']['id'] in h['conv']['head']['typing'], "typing indicator stored")
# files
boundary='----parley'
png=bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'+'1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')
body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n').encode()+png+f'\r\n--{boundary}--\r\n'.encode()
s, f = call('POST', '/api/files', body, token=ta, headers={'content-type': f'multipart/form-data; boundary={boundary}'}); ok(s==201 and f['file']['mime']=='image/png', f"upload -> {s} {f.get('file',{}).get('id')}")
s, r = call('POST', f'/api/convs/{cid}/messages', {'fileId': f['file']['id']}, token=ta); ok(s==201 and r['message']['type']=='file', "file message")
s, raw = call('GET', f"/api/files/{f['file']['id']}", raw=True); ok(s==200 and raw==png, "download matches upload")
s, r = call('POST', f'/api/convs/{cid}/messages', {'fileId': f['file']['id']}, token=tb); ok(s==400, "B can't attach A's upload")
# AI without key
s, r = call('POST', f'/api/convs/{cid}/ai/reply', {'seq': seq}, token=ta); ok(s==503, f"AI reply without key -> {s}")
s, r = call('GET', '/api/nope', token=ta); ok(s==400, f"unknown route -> {s}")
s, r = call('GET', '/api/users?q=nishant', token=ta); ok(any(u['handle']==C['user']['handle'] for u in r['users']), f"user search finds C ({C['user']['handle']} in {[u['handle'] for u in r['users']]})")
s, sy = call('GET', f'/api/sync?c={cid}&s={seq-1}&rv=0', token=tb); ok(sy['messages'] and sy['heads'][cid]['seq']>=seq and sy['edits'], f"sync fallback: {len(sy['messages'])} msgs, {len(sy['edits'])} edits")

print()
print(f'{len(FAILED)} failed' if FAILED else 'All checks passed.')
sys.exit(1 if FAILED else 0)
