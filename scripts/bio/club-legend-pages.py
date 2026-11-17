#!/usr/bin/env python3
# scripts/bio/club-legend-pages.py — club official legend pages for Golazos legends LALIGA has no page
# for (2026-11-08; migration 20261108234026_audit_20261108_club_official_bio).
#
# Fetch (run first, from the same directory; 1 request/second, honest user agent):
#   curl -s https://www.realmadrid.com/sitemap_legends_routes-en-US.xml | grep -oE '<loc>[^<]+' | sed 's/<loc>//' > rm_legends.txt
#   while read u; do curl -sS -A 'Mozilla/5.0 (compatible; RipPacksCity/1.0)' "$u" -o "rm_pages/$(basename "$u").html"; sleep 1; done < rm_legends.txt
#   then parse each page's JSON-LD "birthDate" / "birthPlace" and the visible "Full name" into rm_legends.json
#   (the JSON-LD date equals the visible "Date of birth" on all 343 pages that carry one).
#   fcbarcelona.com Barça Legends pages (/en/football/barca-legends/players/<id>/<name>) state
#   "Place of birth" / "Date of birth" in the page text; the four used are listed in `barca` below.
# Match (this file): the moment's on-chain MatchHighlightedTeam must be the club; the name must match
#   inside that club's list; age 15-41 at the match dates. Output club_out.json, committed as
#   docs/research/club-legend-pages-2026-11-08.json and loaded into club_player_candidates.

import json,re,unicodedata,collections
def sl(s):
    s=(s or '').replace('ø','o').replace('Ø','O').replace('ß','ss').replace('æ','ae').replace('ł','l')
    s=unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')
PART={'de','da','dos','del','la','las','los','do','van','der','den','di','y','e','el'}
plays=json.load(open('plays.json'))
rm=json.load(open('rm_legends.json'))
pages=[dict(source='realmadrid.com',url=x['url'],name=x['full_name'] or x['slug'].replace('-',' '),slug=x['slug'],dob=x['birthDate'],pob=x['birthPlace'],club='Real Madrid') for x in rm if x['birthDate']]
barca={'abidal':('https://www.fcbarcelona.com/en/football/barca-legends/players/1053733/abidal','1979-09-11','Saint Genis-Laval (France)'),
       'deco':('https://www.fcbarcelona.com/en/football/barca-legends/players/1196619/deco','1977-08-27','Sao Bernardo do Campo (Brazil)'),
       'ronaldinho':('https://www.fcbarcelona.com/en/football/barca-legends/players/1493844/ronaldinho','1980-03-21','Porto Alegre (Brazil)'),
       'bojan':('https://www.fcbarcelona.com/en/football/barca-legends/players/3636824/bojan','1990-08-28','Linyola, Lleida')}
pages+=[dict(source='fcbarcelona.com',url=u,name=k,slug=k,dob=d,pob=p,club='FC Barcelona') for k,(u,d,p) in barca.items()]
byp=collections.defaultdict(list)
for r in plays: byp[r[1]].append(r)
out=[]
for pid,rs in byp.items():
    r=rs[0]; first,last,known,jersey=r[2],r[3],r[4],r[5]
    clubs={x[8] for x in rs}; dates=sorted(x[7][:10] for x in rs)
    sur={t for t in sl(last).split('-') if len(t)>=3 and t not in PART}
    forms={sl(x) for x in (known,jersey) if x}
    cands=[]
    for p in pages:
        if p['club'] not in clubs: continue
        toks=set(sl(p['name']).split('-'))|set(p['slug'].split('-'))
        full_ok = bool(sur) and sur <= toks
        nick_ok = p['slug'] in forms   # Barça pages carry the known name only
        ft=sl(first).split('-')[0] if first else ''
        given_ok = bool(ft) and ft in toks and bool(sur & toks)   # "Roberto Carlos da Silva Rocha" vs "Roberto Carlos da Silva"
        if full_ok or nick_ok or given_ok: cands.append(p)
    if len(cands)>1:  # several pages: keep those carrying EVERY given-name token (Roberto Carlos vs Zé Roberto)
        fts={t for t in sl(first).split('-') if t}
        cands=[p for p in cands if fts <= (set(sl(p['name']).split('-'))|set(p['slug'].split('-')))]
    if len(cands)!=1: continue
    p=cands[0]; d=p['dob']
    age=lambda on: int(on[:4])-int(d[:4])-((on[5:10])<(d[5:10]))
    if not (15<=age(dates[0])<=41 and age(dates[-1])<=43): continue
    out.append(dict(pid=pid, play_ids=[int(x[0]) for x in rs], source=p['source'], url=p['url'], name=p['name'], dob=d, pob=p['pob']))
json.dump(out,open('club_out.json','w'),ensure_ascii=False)
print(len(out)); [print(o['name'],o['dob'],o['pob'],o['source']) for o in out]
