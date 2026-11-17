do $$
begin
  if to_regproc('public.audit_20260828_sample_grail_mv_commit') is null then
    raise exception 'anchor missing: sampler function not found — aborting';
  end if;
  if exists (select 1 from cron.job where jobname = 'rpc-audit-grail-mv-commit-control') then
    raise exception 'collision: cron job rpc-audit-grail-mv-commit-control already exists — aborting';
  end if;
  perform cron.schedule(
    'rpc-audit-grail-mv-commit-control',
    '21,27,33 * * * *',
    'select public.audit_20260828_sample_grail_mv_commit();'
  );
end $$;