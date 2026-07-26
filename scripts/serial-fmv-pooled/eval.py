import numpy as np, pandas as pd, json, math

df = pd.read_csv('model_df.csv', dtype={'set_id':str,'player_id':str,'edition_id':str})
df['player_id'] = df.player_id.fillna('NONE').replace('nan','NONE')
df['set_id'] = df.set_id.fillna('NONE').replace('nan','NONE')
df = df.sort_values('sold_at').reset_index(drop=True)
TIERS=['COMMON','RARE','LEGENDARY','FANDOM']

def med_ape(a,p):
    a=np.asarray(a,float); p=np.asarray(p,float); m=~np.isnan(p)
    return float(np.median(np.abs(p[m]-a[m])/a[m])), int(m.sum())
def mean_ape(a,p):
    a=np.asarray(a,float); p=np.asarray(p,float); m=~np.isnan(p)
    return float(np.mean(np.abs(p[m]-a[m])/a[m]))

# ---------- Power-law refit on a given train set ----------
def fit_power(tr, min_n=40, min_r=0.35):
    M={}
    # first: per tier
    for t in TIERS:
        d=tr[(tr.bucket=='first')&(tr.tier==t)]
        if len(d)>=8:
            x=np.log(d.base_fmv.values); yy=np.log(d.price.values)
            b=np.polyfit(x,yy,1); beta=b[0]; k=math.exp(b[1])
            r=np.corrcoef(x,yy)[0,1]
            ok=(len(d)>=min_n and r>=min_r and 0.15<beta<1.25)
            M[('first',t)]=dict(k=k,beta=beta,fmin=d.base_fmv.min(),fmax=d.base_fmv.max(),ok=ok,n=len(d),r=r)
    # perfect: pooled ALL
    d=tr[tr.bucket=='perfect']
    if len(d)>=8:
        x=np.log(d.base_fmv.values); yy=np.log(d.price.values)
        b=np.polyfit(x,yy,1); beta=b[0]; k=math.exp(b[1]); r=np.corrcoef(x,yy)[0,1]
        ok=(len(d)>=min_n and r>=min_r and 0.15<beta<1.25)
        M[('perfect','ALL')]=dict(k=k,beta=beta,fmin=d.base_fmv.min(),fmax=d.base_fmv.max(),ok=ok,n=len(d),r=r)
    return M
def power_pred(M,row):
    key=('perfect','ALL') if row.bucket=='perfect' else ('first',row.tier)
    m=M.get(key)
    if m is None or not m['ok']: return np.nan
    fmv=min(max(row.base_fmv,m['fmin']),m['fmax'])
    return max(row.base_fmv, m['k']*fmv**m['beta'])

# ---------- Pooled model ----------
def build_X(d, players, sets, feats):
    n=len(d); cols=[]; pen=[]; names=[]
    def add(nm,v,p): cols.append(np.asarray(v,float)); pen.append(p); names.append(nm)
    add('intercept',np.ones(n),0.0)
    add('log_fmv',d.log_fmv.values,0.0)
    if 'circ' in feats: add('log_circ',d.log_circ.values,0.0)
    for t in TIERS[1:]: add('tier_'+t,(d.tier==t).astype(float),0.0)
    add('bucket_perfect',(d.bucket=='perfect').astype(float),0.0)
    if 'interaction' in feats:
        for t in TIERS[1:]: add('pxX_'+t,((d.bucket=='perfect')&(d.tier==t)).astype(float),0.0)
    if 'player' in feats:
        for p in players: add('player_'+p,(d.player_id==p).astype(float),1.0)
    if 'set' in feats:
        for s in sets: add('set_'+s,(d.set_id==s).astype(float),2.0)
    return np.column_stack(cols), np.array(pen), names
def fit_ridge(X,y,pen,lp,ls):
    L=np.zeros(X.shape[1]); L[pen==1.0]=lp; L[pen==2.0]=ls
    return np.linalg.solve(X.T@X+np.diag(L), X.T@y)

def eval_split(df, train_frac=0.80, recent_train_months=None, feats=('circ','interaction','player','set'), lp=20, ls=10):
    cut=int(len(df)*train_frac)
    tr=df.iloc[:cut].copy(); te=df.iloc[cut:].copy()
    if recent_train_months:
        tmax=tr.sold_at.max(); tr=tr[tr.sold_at> tmax - recent_train_months*30*86400].copy()
    players=sorted(tr.player_id.unique()); sets=sorted(tr.set_id.unique())
    pset=set(players); sset=set(sets)
    tee=te.copy()
    Xtr,pen,_=build_X(tr,players,sets,feats); y=tr.y.values
    beta=fit_ridge(Xtr,y,pen,lp,ls)
    Xte,_,_=build_X(tee,players,sets,feats)  # unknown levels -> all-zero dummy cols already
    yhat=Xte@beta
    pooled=np.maximum(te.base_fmv.values*np.exp(yhat), te.base_fmv.values)
    # power refit on SAME tr
    M=fit_power(tr)
    power=np.array([power_pred(M,r) for r in te.itertuples()])
    return te, pooled, power, len(tr)

print("=== Fair out-of-time eval: refit BOTH on train, test recent 20% ===\n")
te,pooled,power,ntr = eval_split(df, feats=('circ','interaction','player','set'), lp=20, ls=10)
both=~np.isnan(power)
print(f"train n={ntr}, test n={len(te)}, power covers {both.sum()}")
print(f"  pooled  med-APE={med_ape(te.price,pooled)[0]:.3f} mean-APE={mean_ape(te.price,pooled):.3f}")
print(f"  power   med-APE={med_ape(te.price[both],power[both])[0]:.3f} mean-APE={mean_ape(te.price[both],power[both]):.3f}")
print(f"  pooled(on power-covered) med-APE={med_ape(te.price[both],pooled[both])[0]:.3f}")

print("\n=== Ablations (fair refit, test recent 20%), on power-covered rows ===")
for feats in [('circ',), ('interaction',), ('circ','interaction'), ('circ','interaction','set'),
              ('circ','interaction','player'), ('circ','interaction','player','set')]:
    for (lp,ls) in [(20,10)]:
        te,pooled,power,ntr=eval_split(df,feats=feats,lp=lp,ls=ls)
        both=~np.isnan(power)
        pm=med_ape(te.price[both],pooled[both])[0]; wm=med_ape(te.price[both],power[both])[0]
        print(f"  feats={str(feats):45s} pooled_med={pm:.3f}  power_med={wm:.3f}  delta={pm-wm:+.3f}")

print("\n=== Recent-window training for pooled (match power's 180d regime) ===")
for mo in [6,9,12,18,None]:
    te,pooled,power,ntr=eval_split(df,recent_train_months=mo,feats=('circ','interaction','player','set'),lp=20,ls=10)
    both=~np.isnan(power)
    print(f"  train_window={str(mo):4} months  train_n={ntr:4d}  pooled_med={med_ape(te.price[both],pooled[both])[0]:.3f}  power_med={med_ape(te.price[both],power[both])[0]:.3f}")

print("\n=== Shrinkage sweep on fair split (feats=full), power-covered rows ===")
best=None
for lp in [5,10,20,40,80,160,320]:
    for ls in [5,10,20,40,80]:
        te,pooled,power,ntr=eval_split(df,feats=('circ','interaction','player','set'),lp=lp,ls=ls)
        both=~np.isnan(power)
        pm=med_ape(te.price[both],pooled[both])[0]
        if best is None or pm<best[0]: best=(pm,lp,ls)
te,pooled,power,ntr=eval_split(df,feats=('circ','interaction','player','set'),lp=best[1],ls=best[2])
both=~np.isnan(power)
print(f"  best lp={best[1]} ls={best[2]} pooled_med={best[0]:.3f}  vs power_med={med_ape(te.price[both],power[both])[0]:.3f}")
