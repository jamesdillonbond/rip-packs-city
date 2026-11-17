# Ten Top Shot players are split across two spellings of their own name, and 54 of their editions sit on a second, near-empty player page

**Filed 2026-09-02 ~03:4x PT (10:4xZ), Claude Code cloud session. NOTHING CHANGED** — both available
fixes move user-visible URLs or user-visible names, so this is a product decision, not a chore.

Found by re-deriving deep-audit register **D26** ("duplicate TS player rows sharing one slug"), which
is the **symptom** of this. D26's producer diagnosis — *"three competing `external_id` conventions keep
minting twins"* — describes what the rows LOOK like, not what makes them.

## 1. The measurement

`get_player_detail` resolves a player from the URL slug with
`regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')`. **That expression maps every non-ASCII
letter to a hyphen.** `editions.player_name` carries two spellings for ten Top Shot players, so each of
them slugifies to two different URLs:

| player | spelling A | editions | spelling B | editions |
|---|---|---:|---|---:|
| Alperen Şengün | `alperen-eng-n` | **43** | `alperen-sengun` | **31** |
| Marine Johannès | `marine-johann-s` | 16 | `marine-johannes` | 4 |
| Temi Fágbénlé | `temi-f-gb-nl-` | 7 | `temi-fagbenle` | 2 |
| Vít Krejčí | `v-t-krej-` | 6 | `vit-krejci` | 1 |
| Manu Ginóbili | `manu-gin-bili` | 4 | `manu-ginobili` | 5 |
| Karlo Matković | `karlo-matkovi-` | 4 | `karlo-matkovic` | 4 |
| Noémie Brochant | `no-mie-brochant` | 3 | `noemie-brochant` | 4 |
| Frieda Bühner | `frieda-b-hner` | 3 | `frieda-buhner` | 3 |
| Dražen Petrović | `dra-en-petrovi-` | 2 | `drazen-petrovic` | 1 |
| Toni Kukoč | `toni-kuko-` | 1 | `toni-kukoc` | 1 |

**145 editions across 10 players, of which 54 sit under the minority spelling.**

⚠ **The user-facing consequence is a WRONG NUMBER, not a 404.** `get_player_detail` counts a player's
editions with `(e.player_id = v_player.id OR e.player_name = v_player.name)` — keyed on the winner's
**exact** name — so Alperen Şengün's page reports **43 editions when he has 74**, and his other 31 live
at a second URL that looks like a different, thinner player. Both pages render, neither says anything
is missing, and the totals (`total_circulation`, `fmv_total_usd`, `floor_total_usd`) are understated by
the same split.

⚠ **And the canonical URLs themselves are damaged:** `alperen-eng-n`, `temi-f-gb-nl-`,
`no-mie-brochant`, `v-t-krej-` are today's live slugs for those players.

## 2. The producer, and why D26's framing points one level too low

`ensure_players_from_edition_names` mints a player row for any `editions.player_name` slug that
resolves to nothing, stamping `external_id = '<collection_slug>-<name_slug>'` — which is exactly the
`nba_top_shot-betnijah-laney` shape D26 counted. It does `DISTINCT ON (collection_id, name_slug)` and
its `NOT EXISTS` predicate is byte-for-byte `get_player_detail`'s, **so it is working exactly as
written**: two spellings are two slugs, and two slugs are two players.

The DUPLICATE that D26 sees appears **afterwards**, when one of the two rows is renamed and the two
slugs collapse onto each other. `upsert_player_canonical` does `name = COALESCE(v_name, p.name)` — it
overwrites the name from whatever the caller passed.

⭐ **So the twin is not created by a race; it is manufactured retroactively by a rename.** Corroborated
on all 12 live pairs: **12 of 12** numeric-id rows carry an `updated_at` LATER than their slug-id
twin's `created_at`. ⚠ **That is corroboration, not proof** — `updated_at` moves on any column, and
`players` keeps no name history. The direct evidence is section 1's table: the two spellings are real,
they are in `editions`, and they differ exactly where a diacritic is.

ⓘ Two of D26's twelve pairs are **not** diacritics and are genuine name changes:
`Betnijah Laney` / `Betnijah Laney-Hamilton` (4 / 5 editions) and `Marcus Morris` / `Marcus Morris Sr.`
(7 / 6). Those are the same defect with a different origin and the same fix ambiguity.

## 3. Re-derived counts for D26 itself

| | 2026-08-09 (filed) | 2026-09-02 |
|---|---:|---:|
| duplicate slugs | 14 | **12** |
| player rows involved | 28 | **24** |
| pairs with more than one distinct `name` | 0 | **0** |
| other collections affected | — | **0** |

**It shrank; it did not grow.** D26's impact assessment ("all pairs share one name, so the tie-break
winner claims both halves") still holds *for the players table*. What it does not cover is the
editions-side split above, which is where the wrong number comes from.

## 4. ⛔ Why nothing was changed

Both fixes are user-visible and neither is mine to choose:

1. **Normalise `editions.player_name` to one spelling per player.** ⚠ Which one wins is a product
   call: the diacritic spelling is the person's actual name, and it is also the one that produces
   `alperen-eng-n` as a URL.
2. **Slugify on an UNACCENTED name** (`unaccent` is already installed and is what section 1 groups on).
   This is the better fix — it collapses the pairs, fixes the URLs, and makes `ensure_players_from_
   edition_names` stop minting twins — **but it changes the canonical URL of every player with a
   diacritic in their name**, which is an SEO and inbound-link decision on a public site.

⛔ **Do not do (2) without also handling redirects**, and note it touches `get_player_detail`,
`ensure_players_from_edition_names` and `upsert_player_canonical` — all three slugify with the same
literal expression, and a partial change would split the pairs further rather than merge them.

## 5. Falsifier / re-derive

Re-run section 1's query. **If the ten groups collapse to fewer than ten without either fix shipping,
something upstream started normalising names and the producer has moved** — find it before assuming
the problem is solved. If the count grows, the ingest is still minting new spellings and the URL
damage is spreading.

```sql
WITH e AS (
  SELECT trim(player_name) AS raw,
         regexp_replace(lower(trim(player_name)), '[^a-z0-9]+', '-', 'g') AS slug,
         regexp_replace(lower(unaccent(trim(player_name))), '[^a-z0-9]+', '-', 'g') AS norm_slug,
         count(*) AS editions
  FROM editions
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND player_name IS NOT NULL AND trim(player_name) <> ''
  GROUP BY 1,2,3
), g AS (SELECT norm_slug FROM e GROUP BY 1 HAVING count(DISTINCT slug) > 1)
SELECT e.* FROM e JOIN g USING (norm_slug) ORDER BY e.norm_slug, e.editions DESC;
```

⚠ **Scope stated rather than implied:** measured on `nba_top_shot` only, because that is where D26
lives. **The other four published collections were NOT swept**, and the same slug expression governs
them — LaLiga Golazos in particular is full of diacritics and is the obvious next read.

---

## 🔁 SCOPE GAP CLOSED, same session — and my own prediction about it was WRONG

Section 5 said only `nba_top_shot` was swept and named **LaLiga Golazos** as the obvious next read
because it "is full of diacritics". Swept across all five published collections:

| collection | players split | editions involved | editions stranded on the other spelling |
|---|---:|---:|---:|
| `nba_top_shot` | **10** | 145 | **54** |
| `laliga_golazos` | **1** | 3 | **1** |
| `nfl_all_day` | 0 | — | — |
| `disney_pinnacle` | 0 | — | — |
| `ufc_strike` | 0 | — | — |

⭐ **Golazos has ONE, not the pile I predicted.** Its player names carry plenty of diacritics — they
are simply spelled *consistently*, so they slugify to one ugly-but-stable slug each rather than two.
👉 **The defect is not "names contain diacritics", it is "TWO INGESTS DISAGREE about one name".**
Top Shot has two producers writing `editions.player_name` (the NBA-stats numeric lane and the
on-chain/Studio lane); the other four collections do not, and that — not the character set — is what
makes Top Shot the only one with a real population.

⚠ **Which also narrows the fix.** Slugifying on `unaccent` (option 2) would change the canonical URL
of every diacritic player in **all five** collections to repair **11 players in two of them**. Option
1 — reconcile the two Top Shot spellings — now looks like the proportionate one, and its "which
spelling wins" question is answerable per player rather than as a policy: **prefer the spelling the
on-chain metadata uses**, since that is what a collector sees on the moment itself. ⛔ Still a product
call, still not shipped, but the choice is smaller than section 4 implied.
