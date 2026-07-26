import numpy as np, pandas as pd, json, math
from eval import df, TIERS, build_X, fit_ridge

FEATS=('circ','interaction','set'); LS=10.0; LOOKBACK=730; GATE=6
PREM_LO=round(float(np.percentile(df.premium,1)),4); PREM_HI=round(float(np.percentile(df.premium,99)),2)
prod=df[df.sold_at> df.sold_at.max()-LOOKBACK*86400].copy()
players=sorted(prod.player_id.unique()); sets=sorted(prod.set_id.unique())
X,pen,names=build_X(prod,players,sets,FEATS); beta=fit_ridge(X,prod.y.values,pen,80,LS)
coef=dict(zip(names,beta)); scount=prod.groupby('set_id').size().to_dict()
FMIN=round(float(prod.base_fmv.min()),2); FMAX=round(float(prod.base_fmv.max()),2)
# only support>=GATE sets are ever reached (set-only gate) -> seed exactly those
set_eff=sorted([[s, round(float(coef['set_'+s]),5), int(scount.get(s,0))]
         for s in sets if s!='NONE' and scount.get(s,0)>=GATE and abs(coef['set_'+s])>1e-6], key=lambda r:r[0])
g={k:round(float(coef.get(k,0.0)),6) for k in
   ['intercept','log_fmv','log_circ','tier_RARE','tier_LEGENDARY','tier_FANDOM','bucket_perfect','pxX_RARE','pxX_LEGENDARY','pxX_FANDOM']}
CID='95f28a17-224a-4025-96ad-adf8a4c63bfd'
out=dict(collection_id=CID, algo_version='pooled-1.0.0-set', lookback_days=LOOKBACK, ls=LS,
  gate_min_support=GATE, n_train=int(len(prod)), n_sets=len(set_eff),
  fmv_min=FMIN, fmv_max=FMAX, prem_lo=PREM_LO, prem_hi=PREM_HI, g=g, set_eff=set_eff)
json.dump(out, open('model_setonly.json','w'))
print("model row VALUES:")
print(f"  intercept={g['intercept']} b_fmv={g['log_fmv']} b_circ={g['log_circ']}")
print(f"  tier_rare={g['tier_RARE']} tier_leg={g['tier_LEGENDARY']} tier_fan={g['tier_FANDOM']}")
print(f"  bucket_perfect={g['bucket_perfect']} px_rare={g['pxX_RARE']} px_leg={g['pxX_LEGENDARY']} px_fan={g['pxX_FANDOM']}")
print(f"  fmv_min={FMIN} fmv_max={FMAX} prem_lo={PREM_LO} prem_hi={PREM_HI} n_train={len(prod)} n_sets={len(set_eff)}")
print("CHECKSUM set: n=%d sum_eff=%.5f sum_sup=%d" % (len(set_eff), sum(r[1] for r in set_eff), sum(r[2] for r in set_eff)))
# chunked insert files, one tuple per line, ~24 rows each
def chunkfile(rows, i0, i1, path):
    lines=[f"('{CID}','{r[0]}',{r[1]},{r[2]})" for r in rows[i0:i1]]
    open(path,'w').write("INSERT INTO public.serial_fmv_pooled_set_effect (collection_id,set_id,effect,support_n) VALUES\n"+",\n".join(lines)+";\n")
n=len(set_eff); step=24; ch=0
for i in range(0,n,step):
    ch+=1; chunkfile(set_eff,i,min(i+step,n),f"setchunk_{ch}.sql")
print("chunks:", ch)
