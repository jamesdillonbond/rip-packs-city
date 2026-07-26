import numpy as np, pandas as pd, json, math
TIERS=['COMMON','RARE','LEGENDARY','FANDOM']
df=pd.read_csv('model_df.csv', dtype={'set_id':str,'player_id':str,'edition_id':str})
df['set_id']=df.set_id.fillna('NONE').replace('nan','NONE')
df=df.sort_values('sold_at').reset_index(drop=True)
LS=10.0; GATE=6; LOOKBACK=730; HALFLIFE=180
PREM_LO=round(float(np.percentile(df.premium,1)),4); PREM_HI=round(float(np.percentile(df.premium,99)),2)
CID='95f28a17-224a-4025-96ad-adf8a4c63bfd'

prod=df[df.sold_at> df.sold_at.max()-LOOKBACK*86400].copy()
sets=sorted(prod.set_id.unique())
# design (set-only): intercept, log_fmv, log_circ, tier(3), bucket_perfect, interaction(3), set[pooled]
def build(d):
    n=len(d); cols=[]; pen=[]; names=[]
    def add(nm,v,p): cols.append(np.asarray(v,float)); pen.append(p); names.append(nm)
    add('intercept',np.ones(n),0.0); add('log_fmv',d.log_fmv.values,0.0); add('log_circ',d.log_circ.values,0.0)
    for t in TIERS[1:]: add('tier_'+t,(d.tier==t).astype(float),0.0)
    add('bucket_perfect',(d.bucket=='perfect').astype(float),0.0)
    for t in TIERS[1:]: add('pxX_'+t,((d.bucket=='perfect')&(d.tier==t)).astype(float),0.0)
    for s in sets: add('set_'+s,(d.set_id==s).astype(float),2.0)
    return np.column_stack(cols), np.array(pen), names
X,pen,names=build(prod)
age=(prod.sold_at.max()-prod.sold_at.values)/86400.0
w=0.5**(age/HALFLIFE)                       # recency weights (180d half-life)
Wr=np.sqrt(w)[:,None]; Xw=X*Wr; yw=prod.y.values*np.sqrt(w)
L=np.zeros(X.shape[1]); L[pen==2.0]=LS
beta=np.linalg.solve(Xw.T@Xw+np.diag(L), Xw.T@yw)
coef=dict(zip(names,beta))
scount=prod.groupby('set_id').size().to_dict()   # support = raw count (data quantity)
FMIN=round(float(prod.base_fmv.min()),2); FMAX=round(float(prod.base_fmv.max()),2)
set_eff=sorted([[s, round(float(coef['set_'+s]),5), int(scount.get(s,0))]
         for s in sets if s!='NONE' and scount.get(s,0)>=GATE and abs(coef['set_'+s])>1e-6], key=lambda r:r[0])
g={k:round(float(coef.get(k,0.0)),6) for k in
   ['intercept','log_fmv','log_circ','tier_RARE','tier_LEGENDARY','tier_FANDOM','bucket_perfect','pxX_RARE','pxX_LEGENDARY','pxX_FANDOM']}
out=dict(collection_id=CID, algo_version='pooled-1.1.0-set-recency', lookback_days=LOOKBACK, ls=LS,
  halflife_days=HALFLIFE, gate_min_support=GATE, n_train=int(len(prod)), n_sets=len(set_eff),
  fmv_min=FMIN, fmv_max=FMAX, prem_lo=PREM_LO, prem_hi=PREM_HI, g=g, set_eff=set_eff)
json.dump(out, open('model_final.json','w'))
print("model row:", {k:g[k] for k in g})
print(f"fmv[{FMIN},{FMAX}] prem[{PREM_LO},{PREM_HI}] n_train={len(prod)} n_sets={len(set_eff)}")
print("CHECKSUM set: n=%d sum_eff=%.5f sum_sup=%d"%(len(set_eff),sum(r[1] for r in set_eff),sum(r[2] for r in set_eff)))
# chunked insert files
def chunkfile(rows,i0,i1,path):
    lines=[f"('{CID}','{r[0]}',{r[1]},{r[2]})" for r in rows[i0:i1]]
    open(path,'w').write("INSERT INTO public.serial_fmv_pooled_set_effect (collection_id,set_id,effect,support_n) VALUES\n"+",\n".join(lines)+";\n")
n=len(set_eff); ch=0
for i in range(0,n,24):
    ch+=1; chunkfile(set_eff,i,min(i+24,n),f"fchunk_{ch}.sql")
print("chunks:",ch)
