#!/usr/bin/env python3
# scripts/bio/laliga-player-pages.py — LALIGA official player pages for every Golazos PlayerDataID
# (2026-11-08; migration 20261108225425_audit_20261108_laliga_official_bio).
#
# Inputs (same directory as the run):
#   plays.json        Golazos plays from Flow mainnet: [play_id, PlayerDataID, first, last, known, jersey,
#                     country, match_date, highlighted_team] — Golazos.getPlayData(id) for every id.
#   all_players.txt   the <loc> URLs of https://assets.laliga.com/sitemap/sitemap-players-*.xml.
# Step 1 (fetch): for each player, candidate slugs (sitemap matches on name forms, then a few guesses)
#   are fetched from https://www.laliga.com/en-ES/player/<slug> (robots.txt allows /en-ES/), 3 workers,
#   0.5 s between requests per worker, pages cached in ll_pages/. Reads the page's __NEXT_DATA__ player
#   object and the Opta ids in its squad-photo paths. LALIGA's API is NOT used.
# Step 2 (decide): laliga-id when the photo path carries the chain's Opta id; otherwise every page whose
#   name matches and whose country does not contradict the chain is a 'laliga-name-dob-espn' candidate —
#   the database publishes one only when its DOB equals the linked ESPN DOB; a stricter
#   'laliga-name-country-era' label (given name/nickname + surname token + nationality + age 20-41 on
#   the match dates) may publish where ESPN states no DOB (refresh_laliga_official_bio). Output: laliga_out.json, committed as
#   docs/research/laliga-player-pages-2026-11-08.json and loaded into laliga_player_candidates.

# ---- step 1: fetch ----
import json, re, time, unicodedata, urllib.request, os
UA='Mozilla/5.0 (compatible; RipPacksCity/1.0; +https://www.rippackscity.com)'
plays=json.load(open('plays.json'))
sitemap=set(re.sub(r'.*/player/','',u) for u in open('all_players.txt').read().split() if '/en-ES/player/' in u)
def sl(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')
players={}
for r in plays: players.setdefault(r[1],r)
def page(slug):
    f=f'll_pages/{slug}.json'
    if os.path.exists(f): return json.load(open(f))
    try:
        req=urllib.request.Request('https://www.laliga.com/en-ES/player/'+slug,headers={'User-Agent':UA})
        h=urllib.request.urlopen(req,timeout=30).read().decode('utf8','replace'); st=200
    except urllib.error.HTTPError as e: h=''; st=e.code
    except Exception as e: h=''; st=-1
    time.sleep(0.5)
    out={'slug':slug,'status':st}
    m=re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',h,re.S)
    if m:
        try:
            p=json.loads(m.group(1))['props']['pageProps'].get('player')
            if p:
                out.update(id=p.get('id'),name=p.get('name'),nickname=p.get('nickname'),firstname=p.get('firstname'),lastname=p.get('lastname'),
                  dob=p.get('date_of_birth'),pob=p.get('place_of_birth'),country=(p.get('country') or {}).get('id'),
                  roles=[x.get('slug') for x in p.get('roles') or []],
                  teams=sorted({(s.get('team') or {}).get('nickname') or '' for s in p.get('squads') or []} | {(s.get('team') or {}).get('name') or '' for s in p.get('squads') or []}))
        except Exception as e: out['parse_error']=str(e)
    out['img_ids']=sorted(set(re.findall(r'assets\.laliga\.com/squad/\d+/t\d+/p(\d+)/',h)))
    json.dump(out,open(f,'w'),ensure_ascii=False); return out
from concurrent.futures import ThreadPoolExecutor
def cands_for(r):
    first,last,known,jersey=r[2],r[3],r[4],r[5]
    ft=sl(first).split('-')[0] if first else ''
    lt_all=sl(last).split('-') if last else []
    lt=lt_all[0] if lt_all else ''
    bases=[]
    for s in [known,jersey,f'{first} {last}',last,lt,f"{ft} {lt}",first if not last else '',ft]:
        b=sl(s)
        if b and b not in bases: bases.append(b)
    extra=[]
    if ft and lt: extra += [f'{ft[0]}-{lt}', f'{ft}-{lt[0]}']
    if ft and len(lt_all)>1: extra += [f'{ft[0]}-{lt_all[-1]}', lt_all[-1]]
    allb=bases+[e for e in extra if e not in bases]
    cands=[]
    for b in allb:
        for s in sorted((x for x in sitemap if x==b or re.fullmatch(re.escape(b)+r'-\d+',x)), key=lambda x:(len(x),x)):
            if s not in cands: cands.append(s)
    for b in bases[:3]:
        for s in [b,f'{b}-1']:
            if s not in cands: cands.append(s)
    return cands[:24]
def work(item):
    pid,r=item
    pages=[]
    for s in cands_for(r):
        p=page(s)
        if p.get('id'): pages.append(p)
        if pid in p.get('img_ids',[]) and len(p['img_ids'])==1: break
    return pid,pages
res={}
with ThreadPoolExecutor(3) as ex:
    for i,(pid,pages) in enumerate(ex.map(work, players.items())):
        res[pid]=pages
        if i%10==0: json.dump(res,open('ll_cands.json','w'),ensure_ascii=False)
json.dump(res,open('ll_cands.json','w'),ensure_ascii=False)
print('done',len(res))


# ---- step 2: decide ----
import json, re, unicodedata, collections
ISO={'Algeria':'DZ','Argentina':'AR','Belgium':'BE','Brazil':'BR','Cameroon':'CM','Canada':'CA','Chile':'CL','China PR':'CN','Colombia':'CO',
 'Congo DR':'CD','Costa Rica':'CR','Croatia':'HR',"Côte d'Ivoire":'CI','Denmark':'DK','Ecuador':'EC','France':'FR','Gabon':'GA','Georgia':'GE',
 'Germany':'DE','Ghana':'GH','Israel':'IL','Italy':'IT','Japan':'JP','Korea Republic':'KR','Kosovo':'XK','Mali':'ML','Mexico':'MX','Morocco':'MA',
 'Mozambique':'MZ','Netherlands':'NL','Nigeria':'NG','North Macedonia':'MK','Norway':'NO','Poland':'PL','Portugal':'PT','Republic of Korea':'KR',
 'Senegal':'SN','Serbia':'RS','Slovenia':'SI','Spain':'ES','Sweden':'SE','Switzerland':'CH','Turkey':'TR','USA':'US','Ukraine':'UA','Uruguay':'UY',
 'Venezuela':'VE','Wales':'GB'}
def sl(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')
plays=json.load(open('plays.json')); cands=json.load(open('ll_cands.json'))
byp=collections.defaultdict(list)
for r in plays: byp[r[1]].append(int(r[0]))
info={r[1]:r for r in plays}
ctry=collections.defaultdict(set)
for r in plays: ctry[r[1]].add(r[6])
out=[]; stats=collections.Counter()
for pid,pages in cands.items():
    r=info[pid]; first,last,known,jersey,country=r[2],r[3],r[4],r[5],r[6]
    forms={sl(x) for x in [known,jersey,f'{first} {last}'] if x}
    ftok=sl(first).split('-')[0] if first else ''; ltoks=set(sl(last).split('-')) if last else set()
    def namematch(p):
        pf={sl(p.get('name')),sl(p.get('nickname'))}
        if forms & pf: return True
        pfn=sl(p.get('firstname')).split('-')[0] if p.get('firstname') else ''
        pln=set(sl(p.get('lastname')).split('-')) if p.get('lastname') else set()
        return bool(ftok) and ftok==pfn and bool(ltoks & pln)
    idp=[p for p in pages if pid in p.get('img_ids',[]) and len(p['img_ids'])==1]
    if idp:
        p=idp[0]; stats['laliga-id']+=1
        recs=[dict(verified_by='laliga-id',**p)]
    else:
        isos={ISO.get(c) for c in ctry[pid]} | ({'GB','WL','GBW'} if 'Wales' in ctry[pid] else set())
        nm=[p for p in pages if namematch(p)
            and (p.get('country') is None or p.get('country') in isos)
            and (not p.get('img_ids') or pid in p['img_ids'])]
        recs=[dict(verified_by='laliga-name-dob-espn',**p) for p in nm]
        stats['name candidates: %d' % min(len(nm),3)]+=1
        # Strict name + nationality + era (for legends whose ESPN record states no DOB): the chain's
        # nickname or given name matches AND a real surname token matches, the page's country is the
        # chain's (not merely absent), and the page's DOB puts the player at 15-41 on every match date.
        PART={'de','da','dos','del','la','las','los','do','van','der','den','di','y','e','el'}
        sur={t for t in (sl(last).split('-') if last else []) if len(t)>=3 and t not in PART}
        def strict(p):
            toks=set(sl(p.get('name')).split('-'))|set(sl(p.get('lastname')).split('-'))
            given=(ftok and ftok==(sl(p.get('firstname')).split('-')[0] if p.get('firstname') else '')) or \
                  (known and sl(known) in {sl(p.get('nickname')), sl(p.get('name'))})
            return bool(given) and bool(sur & toks)
        dates=sorted(r2[7][:10] for r2 in plays if r2[1]==pid and r2[7])
        def era(p):
            d=(p.get('dob') or '')[:10]
            if not d or not dates: return False
            age=lambda on: int(on[:4])-int(d[:4])-((on[5:10])<(d[5:10]))
            # 20, not 15: this rule has no second source, and its failure mode is a YOUNGER namesake
            # (Lucas Pérez b. 1988 vs LALIGA's Lucas Pérez Calvo b. 2003 — 19 on a 2022 match date).
            return 20<=age(dates[0])<=41 and age(dates[-1])<=43
        st=[p for p in nm if p.get('country') in isos and strict(p) and era(p)]
        people={(sl(p.get('name')),(p.get('dob') or '')[:10]) for p in st}
        if len(people)==1:
            recs += [dict(verified_by='laliga-name-country-era',**p) for p in st]
            stats['strict+era']+=1
    by_slug={}
    for rec in recs:  # one row per page: the stricter era label wins over the plain name label
        if rec['slug'] not in by_slug or rec['verified_by']=='laliga-name-country-era': by_slug[rec['slug']]=rec
    for rec in by_slug.values():
        if rec.get('dob') or rec.get('pob'):
            out.append(dict(pid=pid, play_ids=byp[pid], slug=rec['slug'], laliga_id=rec.get('id'), name=rec.get('name'),
                            dob=(rec.get('dob') or '')[:10] or None, pob=(rec.get('pob') or '').strip() or None, verified_by=rec['verified_by']))
json.dump(out,open('laliga_out.json','w'),ensure_ascii=False)
print(len(cands),'players', dict(stats), len(out),'records')
