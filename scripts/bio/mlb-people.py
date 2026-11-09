#!/usr/bin/env python3
# scripts/bio/mlb-people.py — MLB's official stats API for every baseball player RPC carries (Candy MLB,
# Panini baseball). 2026-11-08, migration 20261109001623_audit_20261108_mlb_official_bio.
# Input mlb_pop.json: [collection, name_slug, label, card_teams[], espn_dob] (exported from the DB).
# Step 1 fetches /api/v1/people/search?names=<label>&hydrate=currentTeam,education (≈3 req/s; one
# nickname retry, Mike<->Michael …). Step 2 matches: an MLB name form equals the key AND the ESPN DOB
# agrees, or the card's team is in the MLB team history (year-by-year splits fetched only when
# needed), or the name is unique in MLB's register with a debut and the card names no team.
# Note: MLB Advanced Media's notice limits use to individual, non-commercial purposes — Trevor
# approved its use 2026-11-08.

# ---- step 1: fetch ----
import json,time,urllib.request,urllib.parse,os
UA={'User-Agent':'Mozilla/5.0 (compatible; RipPacksCity/1.0; +https://www.rippackscity.com)'}
NICK=[('Mike','Michael'),('Nick','Nicholas'),('Matt','Matthew'),('Chris','Christopher'),('Alex','Alexander'),('Josh','Joshua'),('Jake','Jacob'),
      ('Tony','Anthony'),('Will','William'),('Jon','Jonathan'),('Dan','Daniel'),('Andy','Andrew'),('Joe','Joseph'),('Tom','Thomas'),('Bob','Robert'),
      ('Ben','Benjamin'),('Sam','Samuel'),('Zach','Zachary'),('Pete','Peter'),('Jim','James'),('Ed','Edward'),('Greg','Gregory'),('Rob','Robert'),('Cam','Cameron')]
def get(url):
    for i in range(3):
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=30).read())
        except Exception as e: time.sleep(2)
    return None
def search(name):
    d=get('https://statsapi.mlb.com/api/v1/people/search?'+urllib.parse.urlencode({'names':name,'hydrate':'currentTeam,education'}))
    time.sleep(0.3); return (d or {}).get('people',[]) if d is not None else None
rows=json.load(open('mlb_pop.json'))
cache=json.load(open('mlb_raw.json')) if os.path.exists('mlb_raw.json') else {}
for i,(c,slug,label,teams,dob) in enumerate(rows):
    if label in cache: continue
    if ' | ' in label or '/' in label: cache[label]={'multi':True}; continue
    ppl=search(label); tried=[label]
    if ppl==[]:
        f=label.split(' ')[0]
        for a,b in NICK:
            alt=None
            if f==a: alt=b+label[len(a):]
            elif f==b: alt=a+label[len(b):]
            if alt:
                tried.append(alt); ppl=search(alt)
                if ppl: break
    cache[label]={'people':ppl,'tried':tried}
    if i%50==0: json.dump(cache,open('mlb_raw.json','w'),ensure_ascii=False)
json.dump(cache,open('mlb_raw.json','w'),ensure_ascii=False); print('done',len(cache))


# ---- step 2: match ----
import json,re,unicodedata,time,urllib.request,os,collections
UA={'User-Agent':'Mozilla/5.0 (compatible; RipPacksCity/1.0; +https://www.rippackscity.com)'}
def sl(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')
rows=json.load(open('mlb_pop.json')); raw=json.load(open('mlb_raw.json'))
tcache=json.load(open('mlb_teams.json')) if os.path.exists('mlb_teams.json') else {}
def teams_of(pid):
    k=str(pid)
    if k not in tcache:
        u=f'https://statsapi.mlb.com/api/v1/people/{pid}?hydrate=stats(group=[hitting,pitching],type=[yearByYear])'
        try: d=json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=30).read())
        except Exception: d={}
        ts=set()
        for p in d.get('people',[]):
            for st in p.get('stats',[]):
                for sp in st.get('splits',[]):
                    t=(sp.get('team') or {}).get('name')
                    if t and (sp.get('sport') or {}).get('id') in (1,None): ts.add(t)
        tcache[k]=sorted(ts); time.sleep(0.3)
    return set(tcache[k])
out=[]; stat=collections.Counter()
for c,slug,label,teams,edob in rows:
    r=raw.get(label)
    if not r or r.get('multi'): stat['multi/none']+=1; continue
    keys={slug}|{sl(t) for t in r.get('tried',[])}
    hits=[]
    for p in r.get('people') or []:
        forms={sl(p.get('fullName')), sl(f"{p.get('useName','')} {p.get('lastName','')}"), sl(f"{p.get('firstName','')} {p.get('lastName','')}"),
               sl(f"{p.get('useName','')} {p.get('useLastName') or p.get('lastName','')}")}
        if forms & keys: hits.append(p)
    if not hits: stat['no exact hit']+=1; continue
    teams=set(teams or [])
    def team_ok(p):
        if not teams: return False
        if (p.get('currentTeam') or {}).get('name') in teams: return True
        return bool(teams_of(p['id']) & teams)
    pick=None; how=None
    if edob:
        same=[p for p in hits if p.get('birthDate')==edob]
        if len(same)==1: pick,how=same[0],'mlb-dob-espn'
        elif not same: stat['espn dob disagrees with every hit']+=1; continue
    if pick is None:
        t=[p for p in hits if team_ok(p)]
        if len(t)==1: pick,how=t[0],'mlb-team'
        elif len(hits)==1 and hits[0].get('mlbDebutDate') and not teams: pick,how=hits[0],'mlb-unique-debuted'
    if pick is None: stat['ambiguous/unconfirmed (%d hits)'%min(len(hits),3)]+=1; continue
    stat[how]+=1
    out.append(dict(c=c,slug=slug,label=label,mlb_id=pick['id'],name=pick.get('fullName'),dob=pick.get('birthDate'),
                    city=pick.get('birthCity'),state=pick.get('birthStateProvince'),country=pick.get('birthCountry'),
                    college=', '.join(x.get('name') for x in (pick.get('education') or {}).get('colleges',[]) if x.get('name')) or None,
                    how=how))
json.dump(tcache,open('mlb_teams.json','w')); json.dump(out,open('mlb_out.json','w'),ensure_ascii=False)
print(len(out), dict(stat))
