#!/usr/bin/env python3
# scripts/bio/laliga-panini-soccer.py — LALIGA birthplaces for Panini soccer players (2026-11-08).
#
# ESPN's soccer athlete records carry citizenship but no birthplace, so Panini soccer cards had none.
# LALIGA's own player pages state one. Identity needs TWO signals, both checked here AND re-checked in
# the database at load time:
#   1. a LALIGA name form (full name, nickname, or first + last name) slugs to the card's key, AND
#   2. the LALIGA date of birth equals the date of birth on the ONE ESPN athlete linked to that key.
# A key whose matching pages state two different people is skipped; a page without a place is skipped.
#
# Inputs (same directory as the run):
#   ll_pages/<slug>.json  LALIGA pages cached by laliga-player-pages.py step 1, extended to every slug in
#                         the players sitemap (same fetcher, 3 workers, honest User-Agent, /en-ES/ only).
#   pan_soccer.json       [name_slug, espn_dob, citizenship] for each Panini soccer key with exactly one
#                         linked ESPN soccer athlete stating a DOB (panini_espn_crosswalk x espn_athlete_bio).
# Output: pan_ll_out.json, committed as docs/research/laliga-panini-soccer-2026-11-08.json and loaded
#   into player_official_bio (collection panini_blockchain, source laliga.com, verified_by
#   laliga-name-dob-espn) via pg_net, md5-checked.
import json, os, re, unicodedata, collections, hashlib

def sl(s):
    s = (s or '').replace('ø', 'o').replace('Ø', 'O').replace('ß', 'ss').replace('æ', 'ae').replace('ł', 'l')
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')

pages = []
for f in os.listdir('ll_pages'):
    p = json.load(open('ll_pages/' + f))
    if p.get('id') and p.get('dob'):
        pages.append(p)
byform = collections.defaultdict(list)
for p in pages:
    forms = {sl(p.get('name')), sl(p.get('nickname')), sl(f"{p.get('firstname') or ''} {p.get('lastname') or ''}")}
    for fm in forms:
        if fm:
            byform[fm].append(p)

out = []; st = collections.Counter()
for slug, dob, cit in json.load(open('pan_soccer.json')):
    c = [p for p in byform.get(slug, []) if p['dob'][:10] == dob]
    if not c: st['no page / dob differs'] += 1; continue
    if len({p['dob'][:10] for p in c}) > 1: st['ambiguous'] += 1; continue
    best = sorted(c, key=lambda p: (not p.get('pob'), p['slug']))[0]
    if not best.get('pob'): st['no birthplace on page'] += 1; continue
    out.append(dict(slug=slug, laliga_slug=best['slug'], name=best.get('name'), dob=dob, pob=best['pob'].strip()))
    st['matched'] += 1
json.dump(out, open('pan_ll_out.json', 'w'), ensure_ascii=False)
print(len(pages), 'pages', dict(st), hashlib.md5(open('pan_ll_out.json', 'rb').read()).hexdigest())
