#!/usr/bin/env python3
# scripts/bio/nfl-player-pages.py — NFL.com player pages for Panini football keys ESPN cannot identify
# (2026-11-08; migration 20261109003919_audit_20261108_nfl_official_bio). Input nfl_pop.json:
# [[name_slug, label]]. Fetch nfl.com/players/<slug>/ (1 req/s, honest UA; robots allows /players/),
# read JSON-LD birthDate + alumniOf college + the photo caption's team; unique = no <slug>-2..-5 page.
# The published set also drops keys the ESPN box-score crosswalk calls ambiguous / family_ambiguous
# (EXCL in the loader) and head-coach names (COACHES).

# ---- fetch + uniqueness ----
import json,re,subprocess,time,html,os
pop=[["panini_blockchain",s,l] for s,l in json.load(open('nfl_pop.json'))]
COACHES={'andy-reid','bill-parcells','brian-daboll','jimmy-johnson','marv-levy','matt-lafleur','mike-mcdaniel','rex-ryan'}
cache=json.load(open('nfl_pages.json')) if os.path.exists('nfl_pages.json') else {}
def fetch(slug):
    if slug in cache: return cache[slug]
    r=subprocess.run(['curl','-sS','-m','25','-A','Mozilla/5.0 (compatible; RipPacksCity/1.0)','-o','-','-w','\n%{http_code}','https://www.nfl.com/players/%s/'%slug],capture_output=True,text=True)
    body,_,code=r.stdout.rpartition('\n'); time.sleep(1)
    out={'code':int(code or 0)}
    m=re.search(r'"@type":"Person","name":"([^"]+)","birthDate":"([0-9-]+)"',body)
    if m: out.update(name=html.unescape(m.group(1)),dob=m.group(2))
    c=re.search(r'"alumniOf":\{"@type":"CollegeOrUniversity","name":"([^"]+)"',body) or re.search(r'"@type":"CollegeOrUniversity","name":"([^"]+)"',body)
    if c: out['college']=html.unescape(c.group(1))
    t=re.search(r'"caption":"[^",]+, ([^"]+)"',body)
    if t: out['team']=html.unescape(t.group(1))
    cache[slug]=out; json.dump(cache,open('nfl_pages.json','w'))
    return out
res=[]
for c,slug,label in pop:
    if slug in COACHES: res.append(dict(c=c,slug=slug,label=label,status='coach-guard')); continue
    variants=[slug]
    alt=re.sub(r'\b([a-z])-(?=[a-z]\b|[a-z]-)', r'\1', slug)  # a-j-green -> aj-green
    if alt!=slug: variants.append(alt)
    base=None
    for v in variants:
        p=fetch(v)
        if p.get('dob'): base=(v,p); break
    if not base: res.append(dict(c=c,slug=slug,label=label,status='no-page')); continue
    v,p=base
    sib=fetch(v+'-2')
    if sib.get('dob'): res.append(dict(c=c,slug=slug,label=label,status='namesakes',page=v)); continue
    res.append(dict(c=c,slug=slug,label=label,status='unique',page=v,**{k:p.get(k) for k in ('name','dob','college','team')}))
json.dump(res,open('nfl_res.json','w'),ensure_ascii=False)
import collections; print(collections.Counter(r['status'] for r in res))


# ---- namesake pages -2..-5 ----
import json
res=json.load(open('nfl_res.json'))
for r in res:
    if r['status']!='unique': continue
    sibs=[n for n in (2,3,4,5) if fetch(f"{r['page']}-{n}").get('dob')]
    if sibs: r['status']='namesakes'; r['sibs']=sibs
json.dump(res,open('nfl_res.json','w'),ensure_ascii=False)
print([ (r['slug'],r['sibs']) for r in res if r.get('sibs')]); import collections; print(collections.Counter(r['status'] for r in res))
