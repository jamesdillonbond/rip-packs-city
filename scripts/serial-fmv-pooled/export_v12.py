"""Fit the LIVE production pooled serial-FMV model (v1.2.0 = set-only + recency + jersey-1 double-special).

Self-contained. Inputs (see README for extraction):
  model_df.csv  -- modelable TS #1/perfect sales (premium, log_fmv, log_circ, bucket, tier, set_id, edition_id, sold_at)
  jersey.json   -- {edition_id: jersey_number} for TS editions (editions.jersey_number)

Emits model_v12.json (model row + set effects) and vchunk_*.sql seed statements.
Design: y = ln(premium) ~ intercept + b_log_fmv*ln(fmv) + b_log_circ*ln(circ) + tier(fixed)
        + bucket_perfect + bucket x tier + jersey1[serial#1 & jersey#1] + set[pooled ridge].
Fit is recency-weighted (180d half-life). Only set is penalized (partial pooling); gate keeps set support>=6.
Badge and player factors were evaluated and rejected (see docs/models/topshot-special-serial-trends-2026-07-26.md).
"""
import numpy as np, pandas as pd, json, math
TIERS=['COMMON','RARE','LEGENDARY','FANDOM']; CID='95f28a17-224a-4025-96ad-adf8a4c63bfd'
LS=10.0; GATE=6; LOOKBACK=730; HALFLIFE=180

df=pd.read_csv('model_df.csv', dtype={'set_id':str,'player_id':str,'edition_id':str})
df['set_id']=df.set_id.fillna('NONE').replace('nan','NONE')
df=df.sort_values('sold_at').reset_index(drop=True)
jmap=json.load(open('jersey.json'))
df['j1']=((df.bucket=='first') & (df.edition_id.map(lambda e: jmap.get(e))==1)).astype(float)
PREM_LO=round(float(np.percentile(df.premium,1)),4); PREM_HI=round(float(np.percentile(df.premium,99)),2)

prod=df[df.sold_at > df.sold_at.max()-LOOKBACK*86400].copy()
sets=sorted(prod.set_id.unique())
cols=[]; pen=[]; names=[]
def add(nm,v,p): cols.append(np.asarray(v,float)); pen.append(p); names.append(nm)
add('intercept',np.ones(len(prod)),0); add('log_fmv',prod.log_fmv.values,0); add('log_circ',prod.log_circ.values,0)
for t in TIERS[1:]: add('tier_'+t,(prod.tier==t).astype(float),0)
add('bucket_perfect',(prod.bucket=='perfect').astype(float),0)
for t in TIERS[1:]: add('pxX_'+t,((prod.bucket=='perfect')&(prod.tier==t)).astype(float),0)
add('j1',prod.j1.values,0)
for s in sets: add('set_'+s,(prod.set_id==s).astype(float),2.0)  # penalty group 2 = pooled set
X=np.column_stack(cols); pen=np.array(pen)
age=(prod.sold_at.max()-prod.sold_at.values)/86400.0; w=0.5**(age/HALFLIFE); W=np.sqrt(w)[:,None]
L=np.zeros(X.shape[1]); L[pen==2.0]=LS
beta=np.linalg.solve((X*W).T@(X*W)+np.diag(L), (X*W).T@(prod.y.values*np.sqrt(w)))
coef=dict(zip(names,beta)); scount=prod.groupby('set_id').size().to_dict()
FMIN=round(float(prod.base_fmv.min()),2); FMAX=round(float(prod.base_fmv.max()),2)
set_eff=sorted([[s, round(float(coef['set_'+s]),5), int(scount.get(s,0))]
         for s in sets if s!='NONE' and scount.get(s,0)>=GATE and abs(coef['set_'+s])>1e-6], key=lambda r:r[0])
g={k:round(float(coef.get(k,0.0)),6) for k in
   ['intercept','log_fmv','log_circ','tier_RARE','tier_LEGENDARY','tier_FANDOM','bucket_perfect','pxX_RARE','pxX_LEGENDARY','pxX_FANDOM','j1']}
out=dict(collection_id=CID, algo_version='pooled-1.2.0-set-recency-j1', lookback_days=LOOKBACK, ls=LS,
  halflife_days=HALFLIFE, gate_min_support=GATE, n_train=int(len(prod)), n_sets=len(set_eff),
  fmv_min=FMIN, fmv_max=FMAX, prem_lo=PREM_LO, prem_hi=PREM_HI, g=g, set_eff=set_eff)
json.dump(out, open('model_v12.json','w'))
print("model row:", g)
print(f"jersey1 x{math.exp(g['j1']):.3f} | n_train={len(prod)} n_sets={len(set_eff)} fmv[{FMIN},{FMAX}]")
print("CHECKSUM set: n=%d sum_eff=%.5f sum_sup=%d"%(len(set_eff),sum(r[1] for r in set_eff),sum(r[2] for r in set_eff)))
def chunkfile(rows,i0,i1,path):
    lines=[f"('{CID}','{r[0]}',{r[1]},{r[2]})" for r in rows[i0:i1]]
    open(path,'w').write("INSERT INTO public.serial_fmv_pooled_set_effect (collection_id,set_id,effect,support_n) VALUES\n"+",\n".join(lines)+";\n")
for k,i in enumerate(range(0,len(set_eff),24),1): chunkfile(set_eff,i,min(i+24,len(set_eff)),f"vchunk_{k}.sql")
