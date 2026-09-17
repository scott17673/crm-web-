-- EDI CRM MCP v9: CRM-wide reporting, lost records, previewed bulk operations,
-- CSV export/import, and the cloud lead-finder queue. Reads use allow-listed
-- filters only; every write keeps exact typed references or a short-lived
-- preview token bound to a fingerprint, an operation_id, and the audit ledger.

create schema if not exists private;

create table if not exists private.crm_bulk_previews (
  token uuid primary key default gen_random_uuid(),
  actor text not null,
  operation jsonb not null,
  targets jsonb not null,
  fingerprint text not null,
  created_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  consumed_at timestamp with time zone,
  consumed_operation_id uuid
);

create table if not exists private.crm_import_previews (
  token uuid primary key default gen_random_uuid(),
  actor text not null,
  company_type text not null,
  source_name text,
  rows jsonb not null,
  decisions jsonb not null,
  plan_hash text not null,
  created_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  consumed_at timestamp with time zone,
  consumed_operation_id uuid
);

alter table private.crm_bulk_previews enable row level security;
alter table private.crm_import_previews enable row level security;
revoke all on table private.crm_bulk_previews from public, anon, authenticated;
revoke all on table private.crm_import_previews from public, anon, authenticated;
grant select, insert, update on table private.crm_bulk_previews to service_role;
grant select, insert, update on table private.crm_import_previews to service_role;

-- Private bucket for CSV exports; files are only reachable through short-lived
-- signed URLs created by the MCP server.
insert into storage.buckets (id, name, public)
values ('crm-exports', 'crm-exports', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Company facts: one row per company with the aggregates reports need.
-- ---------------------------------------------------------------------------

create or replace function private.crm_manufacturer_industry_bucket(p_industry text)
returns text
language sql
immutable
set search_path = ''
as $function$
  -- Mirrors the CRM website: known categories (and legacy aliases) or "Others".
  select coalesce(nullif(private.crm_canonical_manufacturer_industry(
    case btrim(coalesce(p_industry, ''))
      when 'Mining/Aggregate' then 'Aggregate / Asphalt'
      when 'Mining / Aggregate' then 'Aggregate / Asphalt'
      when 'Asphalt Plants' then 'Aggregate / Asphalt'
      else p_industry
    end), ''), 'Others');
$function$;

create or replace function private.crm_company_facts()
returns table (
  company_type text,
  company_id bigint,
  company_name text,
  stage text,
  industry text,
  industry_bucket text,
  region text,
  email text,
  phone text,
  person_name text,
  person_title text,
  lost_reason text,
  deal_value numeric,
  tags text[],
  visible_tags text[],
  archived boolean,
  finder_skip boolean,
  open_pipeline boolean,
  notes text,
  created_at timestamp with time zone,
  last_contact date,
  contact_count integer,
  last_activity_date date,
  first_activity_date date,
  activity_count integer,
  open_task_count integer,
  overdue_task_count integer,
  next_task_due date,
  aliases text[]
)
language sql
stable
set search_path = ''
as $function$
  with companies as (
    select 'manufacturer'::text as company_type, m.id as company_id, m.company as company_name, m.stage,
      coalesce(m.industry, '') as industry, null::text as region, null::text as email, null::text as phone,
      null::text as person_name, null::text as person_title, null::text as lost_reason, null::numeric as deal_value,
      coalesce(m.tags, '{}'::text[]) as tags, m.signals as notes, m.created_at, m.last_contact
    from public.manufacturers as m
    union all
    select 'vendor'::text, v.id, v.company, v.stage, coalesce(v.industry, ''), v.region, v.email, v.phone,
      v.name, v.title, null::text, null::numeric, coalesce(v.tags, '{}'::text[]), v.notes, v.created_at, v.last_contact
    from public.vendors as v
    union all
    select 'lost'::text, l.id, l.company, null::text, coalesce(l.industry, ''), l.region, l.email, l.phone,
      l.name, l.title, l.lost_reason, l.deal_value, coalesce(l.tags, '{}'::text[]), l.notes, l.created_at, l.last_contact
    from public.lost_contacts as l
  ),
  contact_agg as (
    select 'manufacturer'::text as t, mc.manufacturer_id as id, count(*)::integer as n
    from public.manufacturer_contacts as mc group by mc.manufacturer_id
    union all
    select 'vendor'::text, vc.vendor_id, count(*)::integer
    from public.vendor_contacts as vc group by vc.vendor_id
  ),
  activity_rows as (
    select a.contact_type, a.contact_id, a.date, private.crm_task_marker(a.created_by) as marker
    from public.activities as a
    where a.contact_id > 0
  ),
  activity_agg as (
    select ar.contact_type as t, ar.contact_id as id,
      count(*) filter (where ar.marker is null)::integer as activity_count,
      max(ar.date) filter (where ar.marker is null) as last_activity_date,
      min(ar.date) filter (where ar.marker is null) as first_activity_date,
      count(*) filter (where ar.marker->>'state' = 'open')::integer as open_tasks,
      count(*) filter (where ar.marker->>'state' = 'open' and ar.date < private.crm_toronto_today())::integer as overdue_tasks,
      min(ar.date) filter (where ar.marker->>'state' = 'open') as next_due
    from activity_rows as ar
    group by ar.contact_type, ar.contact_id
  ),
  alias_agg as (
    select al.company_type as t, al.company_id as id, array_agg(al.alias order by al.alias) as aliases
    from public.crm_company_aliases as al
    group by al.company_type, al.company_id
  )
  select
    c.company_type,
    c.company_id,
    btrim(c.company_name),
    c.stage,
    nullif(c.industry, ''),
    case when c.company_type = 'manufacturer' then private.crm_manufacturer_industry_bucket(c.industry)
      else nullif(c.industry, '') end,
    nullif(c.region, ''),
    nullif(c.email, ''),
    nullif(c.phone, ''),
    nullif(c.person_name, ''),
    nullif(c.person_title, ''),
    nullif(c.lost_reason, ''),
    c.deal_value,
    c.tags,
    array(select t from unnest(c.tags) as t where t not like '\_\_%'),
    '__deleted' = any(c.tags),
    '__finder_skip' = any(c.tags),
    -- Same idea as the website's active pipeline: live stages, not archived, and
    -- manufacturers not marked to skip by the lead finder.
    (not '__deleted' = any(c.tags)
      and c.stage in ('Prospect', 'Outreach', 'Qualified', 'Proposal', 'Negotiation')
      and not (c.company_type = 'manufacturer' and '__finder_skip' = any(c.tags))),
    c.notes,
    c.created_at,
    c.last_contact,
    coalesce(ca.n, 0) + case when c.company_type = 'lost' and btrim(coalesce(c.person_name, '')) <> '' then 1 else 0 end,
    aa.last_activity_date,
    aa.first_activity_date,
    coalesce(aa.activity_count, 0),
    coalesce(aa.open_tasks, 0),
    coalesce(aa.overdue_tasks, 0),
    aa.next_due,
    coalesce(al.aliases, '{}'::text[])
  from companies as c
  left join contact_agg as ca on ca.t = c.company_type and ca.id = c.company_id
  left join activity_agg as aa on aa.t = c.company_type and aa.id = c.company_id
  left join alias_agg as al on al.t = c.company_type and al.id = c.company_id;
$function$;

create or replace function private.crm_date_filter(p_filters jsonb, p_key text)
returns date
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if p_filters is null or not p_filters ? p_key or jsonb_typeof(p_filters->p_key) = 'null' then
    return null;
  end if;
  if coalesce(p_filters->>p_key, '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Filter % must be a YYYY-MM-DD date', p_key using errcode = '22023';
  end if;
  return (p_filters->>p_key)::date;
end;
$function$;

create or replace function private.crm_text_array_filter(p_filters jsonb, p_key text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if p_filters is null or not p_filters ? p_key or jsonb_typeof(p_filters->p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_filters->p_key) <> 'array' then
    raise exception 'Filter % must be a list', p_key using errcode = '22023';
  end if;
  if jsonb_array_length(p_filters->p_key) > 100 then
    raise exception 'Filter % allows at most 100 values', p_key using errcode = '22023';
  end if;
  return array(select btrim(v) from jsonb_array_elements_text(p_filters->p_key) as v where btrim(v) <> '');
end;
$function$;

-- Applies the allow-listed company filters shared by queries, summaries,
-- exports, and bulk previews, returning the matching typed company keys.
create or replace function private.crm_filtered_company_keys(p_filters jsonb)
returns table (company_type text, company_id bigint)
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_key text;
  v_types text[];
  v_stages text[];
  v_industries text[];
  v_region text;
  v_tags_any text[];
  v_tags_all text[];
  v_archived text;
  v_open_pipeline boolean;
  v_last_before date;
  v_last_after date;
  v_created_after date;
  v_created_before date;
  v_name text;
  v_name_key text;
  v_name_tokens text[];
  v_text text;
  v_contact_name text;
  v_contact_norm text;
  v_contact_tokens text[];
  v_contact_title text;
  v_has_contacts boolean;
  v_has_activity boolean;
  v_activity_after date;
  v_activity_before date;
  v_no_activity_since date;
  v_batch text;
  v_has_open_tasks boolean;
  v_company_ids bigint[];
begin
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'Filters must be an object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('company_types', 'stages', 'industries', 'region', 'tags_any', 'tags_all', 'archived',
      'open_pipeline', 'last_contact_before', 'last_contact_after', 'created_after', 'created_before', 'name',
      'text', 'contact_name', 'contact_title', 'has_contacts', 'has_activity', 'activity_after',
      'activity_before', 'no_activity_since', 'import_batch_id', 'has_open_tasks', 'company_ids') then
      raise exception 'Unknown filter %', v_key using errcode = '22023';
    end if;
  end loop;

  v_types := private.crm_text_array_filter(v_f, 'company_types');
  if v_types is not null and exists (select 1 from unnest(v_types) as t where t not in ('manufacturer', 'vendor', 'lost')) then
    raise exception 'company_types must contain manufacturer, vendor, or lost' using errcode = '22023';
  end if;
  v_stages := private.crm_text_array_filter(v_f, 'stages');
  if v_stages is not null then
    if exists (select 1 from unnest(v_stages) as s where private.crm_canonical_stage(s) is null) then
      raise exception 'stages must be valid CRM stages' using errcode = '22023';
    end if;
    v_stages := array(select private.crm_canonical_stage(s) from unnest(v_stages) as s);
  end if;
  v_industries := array(select lower(i) from unnest(private.crm_text_array_filter(v_f, 'industries')) as i);
  if cardinality(v_industries) = 0 then v_industries := null; end if;
  v_region := nullif(btrim(coalesce(v_f->>'region', '')), '');
  v_tags_any := array(select lower(t) from unnest(private.crm_text_array_filter(v_f, 'tags_any')) as t);
  if cardinality(v_tags_any) = 0 then v_tags_any := null; end if;
  v_tags_all := array(select lower(t) from unnest(private.crm_text_array_filter(v_f, 'tags_all')) as t);
  if cardinality(v_tags_all) = 0 then v_tags_all := null; end if;
  v_archived := coalesce(nullif(v_f->>'archived', ''), 'exclude');
  if v_archived not in ('exclude', 'include', 'only') then
    raise exception 'archived must be exclude, include, or only' using errcode = '22023';
  end if;
  v_open_pipeline := (v_f->>'open_pipeline')::boolean;
  v_last_before := private.crm_date_filter(v_f, 'last_contact_before');
  v_last_after := private.crm_date_filter(v_f, 'last_contact_after');
  v_created_after := private.crm_date_filter(v_f, 'created_after');
  v_created_before := private.crm_date_filter(v_f, 'created_before');
  v_activity_after := private.crm_date_filter(v_f, 'activity_after');
  v_activity_before := private.crm_date_filter(v_f, 'activity_before');
  v_no_activity_since := private.crm_date_filter(v_f, 'no_activity_since');
  v_name := nullif(btrim(coalesce(v_f->>'name', '')), '');
  if v_name is not null then
    v_name_key := replace(private.normalize_crm_company_words(v_name), ' ', '');
    v_name_tokens := array(select t from unnest(string_to_array(private.normalize_crm_company_words(v_name), ' ')) as t
      where length(t) >= 2 and t not in ('and', 'the', 'of'));
    if v_name_key = '' then v_name_key := lower(v_name); end if;
  end if;
  v_text := nullif(btrim(coalesce(v_f->>'text', '')), '');
  if v_text is not null and length(v_text) < 2 then
    raise exception 'text filter needs at least 2 characters' using errcode = '22023';
  end if;
  v_contact_name := nullif(btrim(coalesce(v_f->>'contact_name', '')), '');
  if v_contact_name is not null then
    v_contact_norm := private.normalize_crm_person_name(v_contact_name);
    v_contact_tokens := array(select t from unnest(string_to_array(v_contact_norm, ' ')) as t where length(t) >= 2);
    if cardinality(v_contact_tokens) = 0 then
      v_contact_tokens := array(select t from unnest(string_to_array(v_contact_norm, ' ')) as t where t <> '');
    end if;
  end if;
  v_contact_title := nullif(private.normalize_crm_person_name(v_f->>'contact_title'), '');
  v_has_contacts := (v_f->>'has_contacts')::boolean;
  v_has_activity := (v_f->>'has_activity')::boolean;
  v_has_open_tasks := (v_f->>'has_open_tasks')::boolean;
  v_batch := nullif(btrim(coalesce(v_f->>'import_batch_id', '')), '');
  if v_f ? 'company_ids' then
    v_company_ids := array(select (x)::bigint from jsonb_array_elements_text(v_f->'company_ids') as x);
  end if;

  return query
  select f.company_type, f.company_id
  from private.crm_company_facts() as f
  where (v_types is null or f.company_type = any(v_types))
    and (v_company_ids is null or f.company_id = any(v_company_ids))
    and (v_archived = 'include' or (v_archived = 'exclude' and not f.archived) or (v_archived = 'only' and f.archived))
    and (v_stages is null or f.stage = any(v_stages))
    and (v_industries is null
      or lower(coalesce(f.industry_bucket, '')) = any(v_industries)
      or (f.company_type <> 'manufacturer' and exists (
        select 1 from unnest(v_industries) as i where lower(coalesce(f.industry, '')) like '%' || i || '%')))
    -- Manufacturers have no region column; their location is usually in the
    -- company name (e.g. "- Brampton Plant") or notes.
    and (v_region is null
      or f.region ilike '%' || v_region || '%'
      or (f.company_type = 'manufacturer' and (f.company_name ilike '%' || v_region || '%' or f.notes ilike '%' || v_region || '%')))
    and (v_tags_any is null or exists (select 1 from unnest(f.visible_tags) as t where lower(t) = any(v_tags_any)))
    and (v_tags_all is null or not exists (
      select 1 from unnest(v_tags_all) as wanted where not exists (select 1 from unnest(f.visible_tags) as t where lower(t) = wanted)))
    and (v_open_pipeline is null or f.open_pipeline = v_open_pipeline)
    and (v_last_before is null or f.last_contact is null or f.last_contact < v_last_before)
    and (v_last_after is null or f.last_contact >= v_last_after)
    and (v_created_after is null or (f.created_at at time zone 'America/Toronto')::date >= v_created_after)
    and (v_created_before is null or (f.created_at at time zone 'America/Toronto')::date < v_created_before)
    and (v_name is null
      or private.crm_company_query_score(f.company_name, v_name_key, v_name_tokens, v_name) > 0
      or exists (select 1 from unnest(f.aliases) as a where private.crm_company_query_score(a, v_name_key, v_name_tokens, v_name) > 0))
    and (v_text is null
      or f.company_name ilike '%' || v_text || '%'
      or f.notes ilike '%' || v_text || '%'
      or exists (select 1 from unnest(f.aliases) as a where a ilike '%' || v_text || '%'))
    and (v_contact_name is null or exists (
      select 1 from public.manufacturer_contacts as mc
      where f.company_type = 'manufacturer' and mc.manufacturer_id = f.company_id
        and private.crm_person_query_matches(mc.name, null, null, v_contact_norm, v_contact_tokens, null)
      union all
      select 1 from public.vendor_contacts as vc
      where f.company_type = 'vendor' and vc.vendor_id = f.company_id
        and private.crm_person_query_matches(vc.name, null, null, v_contact_norm, v_contact_tokens, null)
      union all
      select 1 where f.company_type in ('vendor', 'lost')
        and private.crm_person_query_matches(f.person_name, null, null, v_contact_norm, v_contact_tokens, null)))
    and (v_contact_title is null or exists (
      select 1 from public.manufacturer_contacts as mc
      where f.company_type = 'manufacturer' and mc.manufacturer_id = f.company_id
        and position(v_contact_title in private.normalize_crm_person_name(mc.title)) > 0
      union all
      select 1 from public.vendor_contacts as vc
      where f.company_type = 'vendor' and vc.vendor_id = f.company_id
        and position(v_contact_title in private.normalize_crm_person_name(vc.title)) > 0
      union all
      select 1 where f.company_type in ('vendor', 'lost')
        and position(v_contact_title in private.normalize_crm_person_name(f.person_title)) > 0))
    and (v_has_contacts is null or (f.contact_count > 0) = v_has_contacts)
    and (v_has_activity is null or (f.activity_count > 0) = v_has_activity)
    and (v_has_open_tasks is null or (f.open_task_count > 0) = v_has_open_tasks)
    and ((v_activity_after is null and v_activity_before is null) or exists (
      select 1 from public.activities as a
      where a.contact_type = f.company_type and a.contact_id = f.company_id
        and private.crm_task_marker(a.created_by) is null
        and (v_activity_after is null or a.date >= v_activity_after)
        and (v_activity_before is null or a.date < v_activity_before)))
    and (v_no_activity_since is null or f.last_activity_date is null or f.last_activity_date < v_no_activity_since)
    and (v_batch is null or ('__import_batch_new:' || v_batch) = any(f.tags));
end;
$function$;

create or replace function private.crm_fact_summary_json(
  p_company_type text,
  p_company_id bigint,
  p_company_name text,
  p_stage text,
  p_industry text,
  p_region text,
  p_visible_tags text[],
  p_archived boolean,
  p_open_pipeline boolean,
  p_created_at timestamp with time zone,
  p_last_contact date,
  p_contact_count integer,
  p_last_activity_date date,
  p_activity_count integer,
  p_open_task_count integer,
  p_overdue_task_count integer,
  p_next_task_due date,
  p_aliases text[],
  p_person_name text,
  p_lost_reason text,
  p_deal_value numeric
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'company_id', p_company_id,
    'company_type', p_company_type,
    'company_name', p_company_name,
    'stage', p_stage,
    'industry', p_industry,
    'region', p_region,
    'tags', to_jsonb(p_visible_tags),
    'aliases', to_jsonb(p_aliases),
    'archived', p_archived,
    'open_pipeline', p_open_pipeline,
    'created_date', (p_created_at at time zone 'America/Toronto')::date,
    'last_contact', p_last_contact,
    'contact_count', p_contact_count,
    'activity_count', p_activity_count,
    'last_activity_date', p_last_activity_date,
    'open_task_count', p_open_task_count,
    'overdue_task_count', p_overdue_task_count,
    'next_task_due', p_next_task_due,
    'person_name', p_person_name,
    'lost_reason', p_lost_reason,
    'deal_value', p_deal_value
  )) || jsonb_build_object('last_contact', p_last_contact, 'stage', p_stage);
$function$;

create or replace function public.mcp_query_crm_companies(
  p_filters jsonb,
  p_sort text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_sort text := coalesce(nullif(p_sort, ''), 'last_contact_desc');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_rows jsonb;
begin
  if v_sort not in ('last_contact_desc', 'last_contact_asc', 'last_activity_desc', 'last_activity_asc',
    'created_desc', 'created_asc', 'name_asc', 'name_desc', 'next_task_due_asc') then
    raise exception 'Unknown sort %', v_sort using errcode = '22023';
  end if;
  if v_offset > 20000 then
    raise exception 'Offset is too large' using errcode = '22023';
  end if;

  with keys as (
    select k.company_type, k.company_id from private.crm_filtered_company_keys(p_filters) as k
  ),
  facts as (
    select f.* from private.crm_company_facts() as f
    join keys as k on k.company_type = f.company_type and k.company_id = f.company_id
  ),
  ordered as (
    select f.*, count(*) over () as total_count
    from facts as f
    order by
      case when v_sort = 'last_contact_desc' then f.last_contact end desc nulls last,
      case when v_sort = 'last_contact_asc' then f.last_contact end asc nulls first,
      case when v_sort = 'last_activity_desc' then f.last_activity_date end desc nulls last,
      case when v_sort = 'last_activity_asc' then f.last_activity_date end asc nulls first,
      case when v_sort = 'created_desc' then f.created_at end desc nulls last,
      case when v_sort = 'created_asc' then f.created_at end asc nulls last,
      case when v_sort = 'name_asc' then lower(f.company_name) end asc,
      case when v_sort = 'name_desc' then lower(f.company_name) end desc,
      case when v_sort = 'next_task_due_asc' then f.next_task_due end asc nulls last,
      f.company_type, f.company_id
    limit v_limit offset v_offset
  )
  select
    coalesce(max(o.total_count), 0),
    coalesce(jsonb_agg(private.crm_fact_summary_json(o.company_type, o.company_id, o.company_name, o.stage,
      o.industry_bucket, o.region, o.visible_tags, o.archived, o.open_pipeline, o.created_at, o.last_contact,
      o.contact_count, o.last_activity_date, o.activity_count, o.open_task_count, o.overdue_task_count,
      o.next_task_due, o.aliases, o.person_name, o.lost_reason, o.deal_value)), '[]'::jsonb)
  into v_total, v_rows
  from ordered as o;

  if v_total = 0 and v_offset > 0 then
    select count(*) into v_total from private.crm_filtered_company_keys(p_filters);
  end if;

  return jsonb_build_object(
    'ok', true,
    'total', v_total,
    'count', jsonb_array_length(v_rows),
    'limit', v_limit,
    'offset', v_offset,
    'next_offset', case when v_offset + jsonb_array_length(v_rows) < v_total then v_offset + jsonb_array_length(v_rows) end,
    'sort', v_sort,
    'companies', v_rows
  );
end;
$function$;

create or replace function public.mcp_crm_pipeline_summary(
  p_filters jsonb,
  p_stale_days integer,
  p_recent_days integer,
  p_list_limit integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_today date := private.crm_toronto_today();
  v_stale_days integer := least(greatest(coalesce(p_stale_days, 60), 1), 3650);
  v_recent_days integer := least(greatest(coalesce(p_recent_days, 14), 1), 3650);
  v_list_limit integer := least(greatest(coalesce(p_list_limit, 10), 0), 50);
  v_week_start date := v_today - ((extract(isodow from v_today)::integer) - 1);
  v_result jsonb;
begin
  with keys as (
    select k.company_type, k.company_id from private.crm_filtered_company_keys(p_filters) as k
  ),
  facts as (
    select f.* from private.crm_company_facts() as f
    join keys as k on k.company_type = f.company_type and k.company_id = f.company_id
  ),
  tasks as (
    select a.id, a.note, a.date, private.crm_task_marker(a.created_by) as marker, f.company_type, f.company_id, f.company_name
    from public.activities as a
    join facts as f on f.company_type = a.contact_type and f.company_id = a.contact_id
    where private.crm_task_marker(a.created_by)->>'state' = 'open'
  )
  select jsonb_build_object(
    'ok', true,
    'as_of', v_today,
    'filters', coalesce(p_filters, '{}'::jsonb),
    'stale_days', v_stale_days,
    'recent_days', v_recent_days,
    'dashboard', jsonb_build_object(
      'manufacturers', (select count(*) from facts where company_type = 'manufacturer' and not archived),
      'in_pipeline', (select count(*) from facts where company_type = 'manufacturer' and not archived
        and not finder_skip and coalesce(stage, '') not in ('Unqualified', 'Not Interested', 'Closed Lost', 'Closed Won')),
      'vendors', (select count(*) from facts where company_type = 'vendor' and not archived),
      'preferred_vendors', (select count(*) from facts where company_type = 'vendor' and not archived and 'Preferred' = any(visible_tags)),
      'lost_records', (select count(*) from facts where company_type = 'lost' and not archived),
      'lost_value', (select coalesce(sum(deal_value), 0) from facts where company_type = 'lost' and not archived)
    ),
    'total_companies', (select count(*) from facts),
    'by_company_type', (select coalesce(jsonb_object_agg(company_type, n), '{}'::jsonb)
      from (select company_type, count(*) n from facts group by company_type) x),
    'by_stage', (select coalesce(jsonb_object_agg(coalesce(stage, '(none)'), n), '{}'::jsonb)
      from (select stage, count(*) n from facts group by stage) x),
    'by_type_and_stage', (select coalesce(jsonb_object_agg(company_type, stages), '{}'::jsonb)
      from (select company_type, jsonb_object_agg(coalesce(stage, '(none)'), n) stages
        from (select company_type, stage, count(*) n from facts group by company_type, stage) y group by company_type) x),
    'manufacturers_by_industry', (select coalesce(jsonb_object_agg(industry_bucket, n), '{}'::jsonb)
      from (select industry_bucket, count(*) n from facts where company_type = 'manufacturer' group by industry_bucket) x),
    'open_pipeline_companies', (select count(*) from facts where open_pipeline),
    'stale_prospects', jsonb_build_object(
      'definition', format('open pipeline (Prospect, Outreach, Qualified, Proposal, Negotiation; not archived or finder-skipped) with no last contact on or after %s', v_today - v_stale_days),
      'count', (select count(*) from facts where open_pipeline and (last_contact is null or last_contact < v_today - v_stale_days)),
      'oldest', (select coalesce(jsonb_agg(jsonb_build_object('company_id', company_id, 'company_type', company_type,
          'company_name', company_name, 'stage', stage, 'last_contact', last_contact)), '[]'::jsonb)
        from (select * from facts where open_pipeline and (last_contact is null or last_contact < v_today - v_stale_days)
          order by last_contact asc nulls first, company_name limit v_list_limit) s)
    ),
    'recently_contacted', jsonb_build_object(
      'count', (select count(*) from facts where last_contact >= v_today - v_recent_days),
      'latest', (select coalesce(jsonb_agg(jsonb_build_object('company_id', company_id, 'company_type', company_type,
          'company_name', company_name, 'stage', stage, 'last_contact', last_contact)), '[]'::jsonb)
        from (select * from facts where last_contact >= v_today - v_recent_days
          order by last_contact desc, company_name limit v_list_limit) s)
    ),
    'companies_without_contacts', jsonb_build_object(
      'count', (select count(*) from facts where company_type in ('manufacturer', 'vendor') and contact_count = 0),
      'open_pipeline_count', (select count(*) from facts where open_pipeline and contact_count = 0),
      'sample', (select coalesce(jsonb_agg(jsonb_build_object('company_id', company_id, 'company_type', company_type,
          'company_name', company_name, 'stage', stage)), '[]'::jsonb)
        from (select * from facts where open_pipeline and contact_count = 0 order by last_contact desc nulls last limit v_list_limit) s)
    ),
    'companies_without_activity', jsonb_build_object(
      'count', (select count(*) from facts where activity_count = 0),
      'open_pipeline_count', (select count(*) from facts where open_pipeline and activity_count = 0),
      'sample', (select coalesce(jsonb_agg(jsonb_build_object('company_id', company_id, 'company_type', company_type,
          'company_name', company_name, 'stage', stage, 'created_date', (created_at at time zone 'America/Toronto')::date)), '[]'::jsonb)
        from (select * from facts where open_pipeline and activity_count = 0 order by created_at desc limit v_list_limit) s)
    ),
    'tasks', jsonb_build_object(
      'open', (select count(*) from tasks),
      'open_regular', (select count(*) from tasks where not coalesce(note, '') ~* '^\s*reach[\s-]*out\y'),
      'open_reach_out', (select count(*) from tasks where coalesce(note, '') ~* '^\s*reach[\s-]*out\y'),
      'overdue', (select count(*) from tasks where date < v_today),
      'due_today', (select count(*) from tasks where date = v_today),
      'due_this_week', (select count(*) from tasks where date >= v_week_start and date < v_week_start + 7),
      'no_due_date', (select count(*) from tasks where date is null),
      'open_by_owner', (select coalesce(jsonb_object_agg(owner, n), '{}'::jsonb)
        from (select marker->>'owner' owner, count(*) n from tasks group by marker->>'owner') x),
      'overdue_list', (select coalesce(jsonb_agg(jsonb_build_object('task_id', id, 'title', note, 'due_date', date,
          'owner', marker->>'owner', 'company_id', company_id, 'company_type', company_type, 'company_name', company_name)), '[]'::jsonb)
        from (select * from tasks where date < v_today order by date asc, id limit v_list_limit) s)
    )
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function private.crm_note_preview(p_note text, p_length integer)
returns text
language sql
immutable
set search_path = ''
as $function$
  select left(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    coalesce(p_note, ''),
    '<img[^>]*>', '[image]', 'gi'),
    'data:image/[^\s"'')]+', '[image]', 'gi'),
    '<br\s*/?>|</(div|p|li)>', ' ', 'gi'),
    '<[^>]+>', '', 'g')), greatest(coalesce(p_length, 300), 20));
$function$;

create or replace function public.mcp_crm_activity_report(
  p_filters jsonb,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_key text;
  v_today date := private.crm_toronto_today();
  v_start date;
  v_end date;
  v_types text[];
  v_owners text[];
  v_company_types text[];
  v_stages text[];
  v_industries text[];
  v_company_id bigint;
  v_company_type text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 0), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('start_date', 'end_date', 'activity_types', 'owners', 'company_types', 'stages',
      'industries', 'company_id', 'company_type') then
      raise exception 'Unknown filter %', v_key using errcode = '22023';
    end if;
  end loop;
  -- Default range: the current Monday-to-today week, like the website's weekly review.
  v_start := coalesce(private.crm_date_filter(v_f, 'start_date'), v_today - ((extract(isodow from v_today)::integer) - 1));
  v_end := coalesce(private.crm_date_filter(v_f, 'end_date'), v_today);
  if v_end < v_start then
    raise exception 'end_date must be on or after start_date' using errcode = '22023';
  end if;
  if v_end - v_start > 1100 then
    raise exception 'Date range is limited to about three years' using errcode = '22023';
  end if;
  v_types := private.crm_text_array_filter(v_f, 'activity_types');
  if v_types is not null and exists (select 1 from unnest(v_types) as t where t not in ('Call', 'Email', 'Meeting', 'Note', 'Auto-Enriched')) then
    raise exception 'activity_types must be Call, Email, Meeting, Note, or Auto-Enriched' using errcode = '22023';
  end if;
  v_owners := array(select lower(o) from unnest(private.crm_text_array_filter(v_f, 'owners')) as o);
  if cardinality(v_owners) = 0 then v_owners := null; end if;
  v_company_types := private.crm_text_array_filter(v_f, 'company_types');
  v_stages := array(select private.crm_canonical_stage(s) from unnest(private.crm_text_array_filter(v_f, 'stages')) as s);
  if cardinality(v_stages) = 0 then v_stages := null; end if;
  v_industries := array(select lower(i) from unnest(private.crm_text_array_filter(v_f, 'industries')) as i);
  if cardinality(v_industries) = 0 then v_industries := null; end if;
  if v_f ? 'company_id' then
    v_company_id := (v_f->>'company_id')::bigint;
    v_company_type := v_f->>'company_type';
    if v_company_type not in ('manufacturer', 'vendor', 'lost') then
      raise exception 'company_type is required with company_id' using errcode = '22023';
    end if;
  end if;

  with facts as (
    select f.* from private.crm_company_facts() as f
  ),
  acts as (
    select a.id, a.date, a.type, coalesce(nullif(btrim(a.created_by), ''), 'Unknown') as owner, a.note, a.created_at,
      f.company_type, f.company_id, f.company_name, f.stage, f.industry_bucket, f.first_activity_date
    from public.activities as a
    join facts as f on f.company_type = a.contact_type and f.company_id = a.contact_id
    where a.contact_id > 0
      and private.crm_task_marker(a.created_by) is null
      and a.date >= v_start and a.date <= v_end
      and (v_types is null or a.type = any(v_types))
      and (v_owners is null or lower(coalesce(nullif(btrim(a.created_by), ''), 'Unknown')) = any(v_owners))
      and (v_company_types is null or f.company_type = any(v_company_types))
      and (v_stages is null or f.stage = any(v_stages))
      and (v_industries is null or lower(coalesce(f.industry_bucket, '')) = any(v_industries))
      and (v_company_id is null or (f.company_id = v_company_id and f.company_type = v_company_type))
  )
  select jsonb_build_object(
    'ok', true,
    'start_date', v_start,
    'end_date', v_end,
    'total', (select count(*) from acts),
    'by_type', (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb) from (select type, count(*) n from acts group by type) x),
    'by_owner', (select coalesce(jsonb_object_agg(owner, n), '{}'::jsonb) from (select owner, count(*) n from acts group by owner) x),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('date', date, 'count', n) order by date), '[]'::jsonb)
      from (select date, count(*) n from acts group by date) x),
    'by_week', (select coalesce(jsonb_agg(jsonb_build_object('week_start', week_start, 'count', n) order by week_start), '[]'::jsonb)
      from (select date - ((extract(isodow from date)::integer) - 1) week_start, count(*) n from acts group by 1) x),
    'companies_contacted_count', (select count(distinct (company_type, company_id)) from acts),
    'companies_contacted', (select coalesce(jsonb_agg(jsonb_build_object('company_id', company_id, 'company_type', company_type,
        'company_name', company_name, 'stage', stage, 'activity_count', n, 'last_activity_date', last_date, 'types', types,
        'first_touch_in_range', first_touch)
        order by last_date desc, company_name), '[]'::jsonb)
      from (select company_id, company_type, company_name, stage, count(*) n, max(date) last_date,
          jsonb_agg(distinct type) types, bool_or(first_activity_date >= v_start) first_touch
        from acts group by company_id, company_type, company_name, stage) x),
    'first_touch_companies_count', (select count(distinct (company_type, company_id)) from acts where first_activity_date >= v_start),
    'activities_limit', v_limit,
    'activities_offset', v_offset,
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('activity_id', id, 'activity_date', date,
        'activity_type', type, 'performed_by', owner, 'company_id', company_id, 'company_type', company_type,
        'company_name', company_name, 'note_preview', private.crm_note_preview(note, 300))), '[]'::jsonb)
      from (select * from acts order by date desc, created_at desc, id desc limit v_limit offset v_offset) x)
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.mcp_find_crm_tasks(
  p_filters jsonb,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_key text;
  v_today date := private.crm_toronto_today();
  v_state text := coalesce(nullif(v_f->>'task_state', ''), 'open');
  v_owner text;
  v_due_before date;
  v_due_after date;
  v_overdue boolean;
  v_due_today boolean;
  v_query text;
  v_company_id bigint;
  v_company_type text;
  v_company_types text[];
  v_stages text[];
  v_task_id bigint;
  v_reach_out text := coalesce(nullif(v_f->>'reach_out', ''), 'include');
  v_include_archived boolean := coalesce((v_f->>'include_archived_companies')::boolean, false);
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('task_state', 'owner', 'due_before', 'due_after', 'overdue', 'due_today', 'query', 'company_id',
      'company_type', 'company_types', 'company_stages', 'task_id', 'reach_out', 'include_archived_companies') then
      raise exception 'Unknown filter %', v_key using errcode = '22023';
    end if;
  end loop;
  if v_state not in ('open', 'done', 'all') then
    raise exception 'task_state must be open, done, or all' using errcode = '22023';
  end if;
  if v_reach_out not in ('include', 'only', 'exclude') then
    raise exception 'reach_out must be include, only, or exclude' using errcode = '22023';
  end if;
  v_owner := case lower(btrim(coalesce(v_f->>'owner', ''))) when '' then null when 'scott' then 'Scott' when 'jeff' then 'Jeff' else 'invalid' end;
  if v_owner = 'invalid' then
    raise exception 'owner must be Scott or Jeff' using errcode = '22023';
  end if;
  v_due_before := private.crm_date_filter(v_f, 'due_before');
  v_due_after := private.crm_date_filter(v_f, 'due_after');
  v_overdue := (v_f->>'overdue')::boolean;
  v_due_today := (v_f->>'due_today')::boolean;
  v_query := nullif(btrim(coalesce(v_f->>'query', '')), '');
  v_task_id := (v_f->>'task_id')::bigint;
  v_company_types := private.crm_text_array_filter(v_f, 'company_types');
  if v_f ? 'company_type' then
    v_company_type := v_f->>'company_type';
    if v_company_type not in ('manufacturer', 'vendor', 'lost') then
      raise exception 'company_type must be manufacturer, vendor, or lost' using errcode = '22023';
    end if;
  end if;
  if v_f ? 'company_id' then
    v_company_id := (v_f->>'company_id')::bigint;
    if v_company_type is null then
      raise exception 'company_type is required with company_id so the CRM record is unambiguous' using errcode = '22023';
    end if;
  end if;
  v_stages := array(select private.crm_canonical_stage(s) from unnest(private.crm_text_array_filter(v_f, 'company_stages')) as s);
  if cardinality(v_stages) = 0 then v_stages := null; end if;

  with tasks as (
    select a.id, a.note, a.date, a.created_at, private.crm_task_marker(a.created_by) as marker,
      a.contact_type, a.contact_id
    from public.activities as a
    where a.contact_id > 0 and private.crm_task_marker(a.created_by) is not null
  ),
  companies as (
    select 'manufacturer'::text as t, m.id, m.company, m.stage, coalesce('__deleted' = any(m.tags), false) as archived from public.manufacturers as m
    union all
    select 'vendor'::text, v.id, v.company, v.stage, coalesce('__deleted' = any(v.tags), false) from public.vendors as v
    union all
    select 'lost'::text, l.id, l.company, null::text, coalesce('__deleted' = any(l.tags), false) from public.lost_contacts as l
  ),
  matched as (
    select t.*, c.company, c.stage, c.archived,
      coalesce(t.note, '') ~* '^\s*reach[\s-]*out\y' as is_reach_out
    from tasks as t
    join companies as c on c.t = t.contact_type and c.id = t.contact_id
    where (v_state = 'all' or t.marker->>'state' = v_state)
      and (v_owner is null or t.marker->>'owner' = v_owner)
      and (v_due_before is null or t.date < v_due_before)
      and (v_due_after is null or t.date >= v_due_after)
      and (v_overdue is null or ((t.marker->>'state' = 'open' and t.date < v_today) = v_overdue))
      and (v_due_today is null or ((t.date = v_today) = v_due_today))
      and (v_query is null or t.note ilike '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      and (v_task_id is null or t.id = v_task_id)
      and (v_company_type is null or t.contact_type = v_company_type)
      and (v_company_id is null or t.contact_id = v_company_id)
      and (v_company_types is null or t.contact_type = any(v_company_types))
      and (v_stages is null or c.stage = any(v_stages))
      and (v_include_archived or not c.archived)
  ),
  filtered as (
    select * from matched
    where v_reach_out = 'include' or (v_reach_out = 'only' and is_reach_out) or (v_reach_out = 'exclude' and not is_reach_out)
  )
  select jsonb_build_object(
    'ok', true,
    'total', (select count(*) from filtered),
    'task_state_filter', v_state,
    'limit', v_limit,
    'offset', v_offset,
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object(
        'task_id', id, 'company_id', contact_id, 'company_type', contact_type, 'company_name', btrim(company),
        'company_stage', stage, 'company_archived', archived, 'title', coalesce(note, ''), 'due_date', date,
        'state', marker->>'state', 'owner', marker->>'owner', 'overdue', marker->>'state' = 'open' and date < v_today,
        'reach_out', is_reach_out, 'created_at', created_at)), '[]'::jsonb)
      from (select * from filtered order by date asc nulls last, created_at desc, id limit v_limit offset v_offset) x)
  ) into v_result;
  return v_result;
end;
$function$;


-- ---------------------------------------------------------------------------
-- Lost records
-- ---------------------------------------------------------------------------

create or replace function private.crm_clean_visible_tags(p_tags jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_tag text;
  v_result text[] := '{}';
begin
  if p_tags is null or jsonb_typeof(p_tags) = 'null' then
    return v_result;
  end if;
  if jsonb_typeof(p_tags) <> 'array' or jsonb_array_length(p_tags) > 20 then
    raise exception 'Tags must be a list of at most 20 values' using errcode = '22023';
  end if;
  for v_tag in select btrim(t) from jsonb_array_elements_text(p_tags) as t loop
    if v_tag = '' then
      continue;
    end if;
    if length(v_tag) > 50 or v_tag like '\_\_%' or position(',' in v_tag) > 0 then
      raise exception 'Tag "%" is not allowed; tags must be 1 to 50 characters, contain no commas, and must not start with __', v_tag
        using errcode = '22023';
    end if;
    if not exists (select 1 from unnest(v_result) as e where lower(e) = lower(v_tag)) then
      v_result := v_result || v_tag;
    end if;
  end loop;
  return v_result;
end;
$function$;

create or replace function public.mcp_create_crm_lost_record(
  p_operation_id uuid,
  p_fields jsonb,
  p_allow_similar_names boolean,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_f jsonb := coalesce(p_fields, '{}'::jsonb);
  v_key text;
  v_company text;
  v_person text;
  v_title text;
  v_email text;
  v_phone text;
  v_industry text;
  v_region text;
  v_reason text;
  v_deal numeric := 0;
  v_notes text;
  v_tags text[];
  v_fingerprint text;
  v_replay jsonb;
  v_candidates jsonb;
  v_row jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'Lost record fields must be an object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('company_name', 'person_name', 'person_title', 'email', 'phone', 'industry', 'region',
      'lost_reason', 'deal_value', 'notes', 'tags') then
      raise exception 'Field % is not a lost-record field', v_key using errcode = '22023';
    end if;
  end loop;
  v_company := btrim(regexp_replace(coalesce(v_f->>'company_name', ''), '\s+', ' ', 'g'));
  if length(v_company) < 2 or length(v_company) > 300 or length(replace(private.normalize_crm_company_words(v_company), ' ', '')) < 2 then
    raise exception 'Company name must contain a distinctive 2 to 300 character name' using errcode = '22023';
  end if;
  v_person := btrim(regexp_replace(coalesce(v_f->>'person_name', ''), '\s+', ' ', 'g'));
  v_title := btrim(regexp_replace(coalesce(v_f->>'person_title', ''), '\s+', ' ', 'g'));
  if length(v_person) > 200 or length(v_title) > 200 then
    raise exception 'Person name and title must contain at most 200 characters' using errcode = '22023';
  end if;
  v_email := btrim(coalesce(v_f->>'email', ''));
  if v_email <> '' and (length(v_email) > 320 or v_email !~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$') then
    raise exception 'Email must be a single valid email address' using errcode = '22023';
  end if;
  v_phone := btrim(coalesce(v_f->>'phone', ''));
  v_industry := btrim(coalesce(v_f->>'industry', ''));
  v_region := btrim(coalesce(v_f->>'region', ''));
  if length(v_phone) > 50 or length(v_industry) > 200 or length(v_region) > 200 then
    raise exception 'Phone (50), industry (200), or region (200) is too long' using errcode = '22023';
  end if;
  v_reason := btrim(coalesce(v_f->>'lost_reason', ''));
  if v_reason <> '' and v_reason not in ('Price', 'Competitor', 'No Budget', 'No Decision', 'Bad Fit', 'Timing', 'Other') then
    raise exception 'Lost reason must be one of Price, Competitor, No Budget, No Decision, Bad Fit, Timing, Other'
      using errcode = '22023';
  end if;
  if v_f ? 'deal_value' and jsonb_typeof(v_f->'deal_value') <> 'null' then
    if jsonb_typeof(v_f->'deal_value') <> 'number' or (v_f->>'deal_value')::numeric < 0 then
      raise exception 'Deal value must be a non-negative number' using errcode = '22023';
    end if;
    v_deal := (v_f->>'deal_value')::numeric;
  end if;
  v_notes := coalesce(v_f->>'notes', '');
  if length(v_notes) > 20000 then
    raise exception 'Notes must contain at most 20000 characters' using errcode = '22023';
  end if;
  v_tags := private.crm_clean_visible_tags(v_f->'tags');

  v_fingerprint := md5(jsonb_build_object('fields', v_f)::text);
  perform pg_advisory_xact_lock(hashtext('edi_crm_mcp_create_company'));
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'create_lost_record', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_candidates := private.crm_company_name_matches(v_company, null, null);
  if jsonb_path_exists(v_candidates, '$[*] ? (@.match == "exact")') then
    return jsonb_build_object('ok', false, 'status', 'duplicate_blocked', 'changed', false,
      'duplicate_candidates', v_candidates, 'replayed', false);
  end if;
  if jsonb_array_length(v_candidates) > 0 and not coalesce(p_allow_similar_names, false) then
    return jsonb_build_object('ok', false, 'status', 'possible_duplicates', 'changed', false,
      'duplicate_candidates', v_candidates, 'replayed', false);
  end if;

  -- Same columns the CRM website's Add Company form writes on the Lost tab.
  insert into public.lost_contacts (company, name, title, email, phone, industry, region, lost_reason,
    deal_value, tags, notes, last_contact)
  values (v_company, v_person, v_title, v_email, v_phone, v_industry, v_region, v_reason, v_deal, v_tags,
    v_notes, private.crm_toronto_today())
  returning to_jsonb(lost_contacts.*) into v_row;

  v_result := jsonb_build_object('ok', true, 'status', 'created', 'changed', true,
    'company', private.crm_company_summary('lost', v_row) || jsonb_build_object('person_name', v_row->>'name',
      'person_title', v_row->>'title'),
    'similar_names', v_candidates);
  return private.mcp_operation_record(v_actor, p_operation_id, 'create_lost_record', v_fingerprint,
    'lost', (v_row->>'id')::bigint, null, private.crm_audit_row(v_row), v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Bulk operations: preview returns the exact affected set and a 15-minute
-- token bound to a fingerprint of those rows; apply refuses stale previews.
-- ---------------------------------------------------------------------------

create or replace function private.crm_bulk_fingerprint(p_targets jsonb)
returns text
language sql
stable
set search_path = ''
as $function$
  select md5(coalesce(string_agg(
    x.company_type || ':' || x.company_id || ':' || coalesce(x.company, '') || ':' || coalesce(x.stage, '') || ':' ||
    coalesce(x.industry, '') || ':' || coalesce(x.tags::text, ''), '|' order by x.company_type, x.company_id), ''))
  from (
    select 'manufacturer'::text as company_type, m.id as company_id, m.company, m.stage, m.industry, m.tags
    from public.manufacturers as m
    where m.id in (select (t->>'company_id')::bigint from jsonb_array_elements(p_targets) as t where t->>'company_type' = 'manufacturer')
    union all
    select 'vendor'::text, v.id, v.company, v.stage, v.industry, v.tags
    from public.vendors as v
    where v.id in (select (t->>'company_id')::bigint from jsonb_array_elements(p_targets) as t where t->>'company_type' = 'vendor')
    union all
    select 'lost'::text, l.id, l.company, null::text, l.industry, l.tags
    from public.lost_contacts as l
    where l.id in (select (t->>'company_id')::bigint from jsonb_array_elements(p_targets) as t where t->>'company_type' = 'lost')
  ) as x;
$function$;

create or replace function private.crm_bulk_snapshot(p_targets jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('company_type', x.company_type, 'company_id', x.company_id,
    'company_name', x.company, 'stage', x.stage, 'industry', x.industry, 'tags', to_jsonb(coalesce(x.tags, '{}'::text[])))
    order by x.company_type, x.company_id), '[]'::jsonb)
  from (
    select 'manufacturer'::text as company_type, m.id as company_id, m.company, m.stage, m.industry, m.tags
    from public.manufacturers as m
    where m.id in (select (t->>'company_id')::bigint from jsonb_array_elements(p_targets) as t where t->>'company_type' = 'manufacturer')
    union all
    select 'vendor'::text, v.id, v.company, v.stage, v.industry, v.tags
    from public.vendors as v
    where v.id in (select (t->>'company_id')::bigint from jsonb_array_elements(p_targets) as t where t->>'company_type' = 'vendor')
    union all
    select 'lost'::text, l.id, l.company, null::text, l.industry, l.tags
    from public.lost_contacts as l
    where l.id in (select (t->>'company_id')::bigint from jsonb_array_elements(p_targets) as t where t->>'company_type' = 'lost')
  ) as x;
$function$;

create or replace function public.mcp_preview_crm_bulk_operation(
  p_operation jsonb,
  p_targets jsonb,
  p_import_batch_id text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_op jsonb := coalesce(p_operation, '{}'::jsonb);
  v_type text := v_op->>'type';
  v_key text;
  v_value text;
  v_tags text[];
  v_tags_lower text[];
  v_reason text;
  v_targets jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_normalized jsonb;
  r record;
  v_archived boolean;
  v_visible text[];
  v_current jsonb;
  v_proposed jsonb;
  v_change boolean;
  v_skip text;
  v_changing integer := 0;
  v_token uuid;
  v_expires timestamp with time zone := now() + interval '15 minutes';
begin
  if jsonb_typeof(v_op) <> 'object' then
    raise exception 'Operation must be an object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(v_op) loop
    if v_key not in ('type', 'value', 'tags', 'reason') then
      raise exception 'Unknown operation field %', v_key using errcode = '22023';
    end if;
  end loop;
  if v_type = 'set_stage' then
    v_value := private.crm_canonical_stage(v_op->>'value');
    if v_value is null then
      raise exception 'set_stage needs a valid CRM stage value' using errcode = '22023';
    end if;
    v_normalized := jsonb_build_object('type', v_type, 'value', v_value);
  elsif v_type = 'set_industry' then
    v_value := btrim(coalesce(v_op->>'value', ''));
    if length(v_value) > 200 then
      raise exception 'Industry must contain at most 200 characters' using errcode = '22023';
    end if;
    v_normalized := jsonb_build_object('type', v_type, 'value', v_value);
  elsif v_type in ('add_tags', 'remove_tags') then
    v_tags := private.crm_clean_visible_tags(v_op->'tags');
    if cardinality(v_tags) = 0 then
      raise exception '% needs at least one tag', v_type using errcode = '22023';
    end if;
    v_tags_lower := array(select lower(t) from unnest(v_tags) as t);
    v_normalized := jsonb_build_object('type', v_type, 'tags', to_jsonb(v_tags));
  elsif v_type = 'archive' then
    v_reason := btrim(coalesce(v_op->>'reason', ''));
    if length(v_reason) < 3 or length(v_reason) > 500 then
      raise exception 'archive needs a reason of 3 to 500 characters' using errcode = '22023';
    end if;
    v_normalized := jsonb_build_object('type', v_type, 'reason', v_reason);
  else
    raise exception 'Operation type must be set_stage, set_industry, add_tags, remove_tags, or archive' using errcode = '22023';
  end if;

  if p_import_batch_id is not null and p_targets is not null then
    raise exception 'Use either explicit targets or an import batch id, not both' using errcode = '22023';
  end if;
  if p_import_batch_id is not null then
    if p_import_batch_id !~ '^\d{8}-\d{6}$' then
      raise exception 'Import batch id must look like 20260510-181053' using errcode = '22023';
    end if;
    select jsonb_agg(jsonb_build_object('company_type', x.t, 'company_id', x.id) order by x.t, x.id)
    into v_targets
    from (
      select 'manufacturer'::text as t, m.id from public.manufacturers as m
      where ('__import_batch_new:' || p_import_batch_id) = any(coalesce(m.tags, '{}')) and not '__deleted' = any(coalesce(m.tags, '{}'))
      union all
      select 'vendor'::text, v.id from public.vendors as v
      where ('__import_batch_new:' || p_import_batch_id) = any(coalesce(v.tags, '{}')) and not '__deleted' = any(coalesce(v.tags, '{}'))
      union all
      select 'lost'::text, l.id from public.lost_contacts as l
      where ('__import_batch_new:' || p_import_batch_id) = any(coalesce(l.tags, '{}')) and not '__deleted' = any(coalesce(l.tags, '{}'))
    ) as x;
  else
    if p_targets is null or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) = 0 then
      raise exception 'Provide explicit targets (company_id + company_type) or an import batch id' using errcode = '22023';
    end if;
    if jsonb_array_length(p_targets) > 500 then
      raise exception 'A bulk operation is limited to 500 companies' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_targets) as t
      where jsonb_typeof(t) <> 'object' or coalesce(t->>'company_type', '') not in ('manufacturer', 'vendor', 'lost')
        or coalesce(t->>'company_id', '') !~ '^\d+$') then
      raise exception 'Every target needs an exact company_id and company_type' using errcode = '22023';
    end if;
    select jsonb_agg(jsonb_build_object('company_type', x.t, 'company_id', x.id) order by x.t, x.id)
    into v_targets
    from (select distinct t->>'company_type' as t, (t->>'company_id')::bigint as id from jsonb_array_elements(p_targets) as t) as x;
  end if;
  if v_targets is null or jsonb_array_length(v_targets) = 0 then
    return jsonb_build_object('ok', false, 'status', 'nothing_selected', 'reason', 'No companies matched the selection');
  end if;
  if jsonb_array_length(v_targets) > 500 then
    raise exception 'A bulk operation is limited to 500 companies' using errcode = '22023';
  end if;
  if v_type = 'set_industry' and exists (select 1 from jsonb_array_elements(v_targets) as t where t->>'company_type' = 'manufacturer')
    and private.crm_canonical_manufacturer_industry(v_value) is null then
    raise exception 'Manufacturer industry must be one of Food and Beverage, Concrete, Metal Refineries, Recycling, Aggregate / Asphalt, Packaging, Building Products, Others'
      using errcode = '22023';
  end if;

  for r in
    select t.company_type, t.company_id, c.company, c.stage, c.industry, c.tags
    from jsonb_to_recordset(v_targets) as t(company_type text, company_id bigint)
    left join lateral (
      select m.company, m.stage, m.industry, coalesce(m.tags, '{}'::text[]) as tags from public.manufacturers as m
      where t.company_type = 'manufacturer' and m.id = t.company_id
      union all
      select v.company, v.stage, v.industry, coalesce(v.tags, '{}'::text[]) from public.vendors as v
      where t.company_type = 'vendor' and v.id = t.company_id
      union all
      select l.company, null::text, l.industry, coalesce(l.tags, '{}'::text[]) from public.lost_contacts as l
      where t.company_type = 'lost' and l.id = t.company_id
    ) as c on true
    order by t.company_type, t.company_id
  loop
    if r.company is null then
      v_missing := v_missing || jsonb_build_object('company_type', r.company_type, 'company_id', r.company_id);
      continue;
    end if;
    v_archived := '__deleted' = any(r.tags);
    v_visible := array(select t from unnest(r.tags) as t where t not like '\_\_%');
    v_skip := null;
    v_change := false;
    if v_type = 'set_stage' then
      v_current := to_jsonb(r.stage);
      v_proposed := to_jsonb(v_value);
      if r.company_type = 'lost' then v_skip := 'Lost records have no stage';
      elsif v_archived then v_skip := 'Archived; restore it first';
      else v_change := r.stage is distinct from v_value; end if;
    elsif v_type = 'set_industry' then
      v_current := to_jsonb(r.industry);
      v_proposed := to_jsonb(case when r.company_type = 'manufacturer' then private.crm_canonical_manufacturer_industry(v_value) else v_value end);
      if v_archived then v_skip := 'Archived; restore it first';
      else v_change := coalesce(r.industry, '') is distinct from (v_proposed #>> '{}'); end if;
    elsif v_type = 'add_tags' then
      v_current := to_jsonb(v_visible);
      v_proposed := to_jsonb(v_visible || array(select t from unnest(v_tags) as t
        where not exists (select 1 from unnest(r.tags) as e where lower(e) = lower(t))));
      if v_archived then v_skip := 'Archived; restore it first';
      else v_change := v_current <> v_proposed; end if;
    elsif v_type = 'remove_tags' then
      v_current := to_jsonb(v_visible);
      v_proposed := to_jsonb(array(select t from unnest(v_visible) as t where not lower(t) = any(v_tags_lower)));
      if v_archived then v_skip := 'Archived; restore it first';
      else v_change := v_current <> v_proposed; end if;
    else
      v_current := jsonb_build_object('archived', v_archived, 'stage', r.stage);
      v_proposed := jsonb_build_object('archived', true,
        'stage', case when r.company_type = 'manufacturer' then 'Closed Lost' else r.stage end);
      if v_archived then v_skip := 'Already archived'; else v_change := true; end if;
    end if;
    if v_change then
      v_changing := v_changing + 1;
    end if;
    v_rows := v_rows || jsonb_build_object('company_id', r.company_id, 'company_type', r.company_type,
      'company_name', r.company, 'current', v_current, 'proposed', v_proposed, 'will_change', v_change,
      'skip_reason', v_skip);
  end loop;

  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object('ok', false, 'status', 'refused',
      'reason', 'Some selected companies do not exist; fix the selection and preview again',
      'missing', v_missing, 'rows', v_rows);
  end if;
  if v_changing = 0 then
    return jsonb_build_object('ok', true, 'status', 'nothing_to_change', 'operation', v_normalized,
      'total_targets', jsonb_array_length(v_targets), 'changing_count', 0, 'rows', v_rows);
  end if;

  insert into private.crm_bulk_previews (actor, operation, targets, fingerprint, expires_at)
  values (v_actor, v_normalized, v_targets, private.crm_bulk_fingerprint(v_targets), v_expires)
  returning token into v_token;

  return jsonb_build_object('ok', true, 'status', 'preview_ready', 'preview_token', v_token,
    'expires_at', v_expires, 'operation', v_normalized, 'import_batch_id', p_import_batch_id,
    'total_targets', jsonb_array_length(v_targets), 'changing_count', v_changing,
    'unchanged_count', jsonb_array_length(v_targets) - v_changing, 'rows', v_rows);
end;
$function$;

create or replace function public.mcp_apply_crm_bulk_operation(
  p_operation_id uuid,
  p_preview_token uuid,
  p_confirm boolean,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_fingerprint text;
  v_replay jsonb;
  v_preview private.crm_bulk_previews%rowtype;
  v_type text;
  v_value text;
  v_tags text[];
  v_tags_lower text[];
  v_mfr bigint[];
  v_vendor bigint[];
  v_lost bigint[];
  v_before jsonb;
  v_after jsonb;
  v_changed jsonb;
  r record;
  v_result jsonb;
begin
  if not coalesce(p_confirm, false) then
    raise exception 'Bulk operations require confirm=true after the user approved the preview' using errcode = '22023';
  end if;
  if p_preview_token is null then
    raise exception 'A preview token from preview_crm_bulk_operation is required' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('token', p_preview_token)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'bulk_operation', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  select preview.* into v_preview from private.crm_bulk_previews as preview
  where preview.token = p_preview_token and preview.actor = v_actor
  for update;
  if not found then
    raise exception 'Unknown bulk preview token' using errcode = '22023';
  end if;
  if v_preview.consumed_at is not null then
    raise exception 'This bulk preview token was already used by operation %', v_preview.consumed_operation_id
      using errcode = '22023';
  end if;
  if v_preview.expires_at < now() then
    return jsonb_build_object('ok', false, 'status', 'preview_expired', 'changed', false,
      'reason', 'The bulk preview expired; preview again and confirm with the user', 'replayed', false);
  end if;

  v_mfr := array(select (t->>'company_id')::bigint from jsonb_array_elements(v_preview.targets) as t where t->>'company_type' = 'manufacturer');
  v_vendor := array(select (t->>'company_id')::bigint from jsonb_array_elements(v_preview.targets) as t where t->>'company_type' = 'vendor');
  v_lost := array(select (t->>'company_id')::bigint from jsonb_array_elements(v_preview.targets) as t where t->>'company_type' = 'lost');
  perform 1 from public.manufacturers as m where m.id = any(v_mfr) order by m.id for update;
  perform 1 from public.vendors as v where v.id = any(v_vendor) order by v.id for update;
  perform 1 from public.lost_contacts as l where l.id = any(v_lost) order by l.id for update;

  if private.crm_bulk_fingerprint(v_preview.targets) <> v_preview.fingerprint then
    return jsonb_build_object('ok', false, 'status', 'preview_stale', 'changed', false,
      'reason', 'One or more selected companies changed after the preview; preview again and confirm with the user',
      'replayed', false);
  end if;

  v_before := private.crm_bulk_snapshot(v_preview.targets);
  v_type := v_preview.operation->>'type';
  v_value := v_preview.operation->>'value';
  if v_preview.operation ? 'tags' then
    v_tags := array(select jsonb_array_elements_text(v_preview.operation->'tags'));
    v_tags_lower := array(select lower(t) from unnest(v_tags) as t);
  end if;

  if v_type = 'set_stage' then
    update public.manufacturers as m
    set stage = v_value,
      tags = case when v_value in ('Not Interested', 'Unqualified', 'Closed Lost') and not '__finder_skip' = any(coalesce(m.tags, '{}'))
        then coalesce(m.tags, '{}') || text '__finder_skip' else m.tags end
    where m.id = any(v_mfr) and not '__deleted' = any(coalesce(m.tags, '{}')) and m.stage is distinct from v_value;
    update public.vendors as v set stage = v_value
    where v.id = any(v_vendor) and not '__deleted' = any(coalesce(v.tags, '{}')) and v.stage is distinct from v_value;
  elsif v_type = 'set_industry' then
    update public.manufacturers as m set industry = private.crm_canonical_manufacturer_industry(v_value)
    where m.id = any(v_mfr) and not '__deleted' = any(coalesce(m.tags, '{}'))
      and coalesce(m.industry, '') is distinct from private.crm_canonical_manufacturer_industry(v_value);
    update public.vendors as v set industry = v_value
    where v.id = any(v_vendor) and not '__deleted' = any(coalesce(v.tags, '{}')) and coalesce(v.industry, '') is distinct from v_value;
    update public.lost_contacts as l set industry = v_value
    where l.id = any(v_lost) and not '__deleted' = any(coalesce(l.tags, '{}')) and coalesce(l.industry, '') is distinct from v_value;
  elsif v_type = 'add_tags' then
    update public.manufacturers as m
    set tags = coalesce(m.tags, '{}') || array(select t from unnest(v_tags) as t where not exists (select 1 from unnest(coalesce(m.tags, '{}')) as e where lower(e) = lower(t)))
    where m.id = any(v_mfr) and not '__deleted' = any(coalesce(m.tags, '{}'))
      and exists (select 1 from unnest(v_tags) as t where not exists (select 1 from unnest(coalesce(m.tags, '{}')) as e where lower(e) = lower(t)));
    update public.vendors as v
    set tags = coalesce(v.tags, '{}') || array(select t from unnest(v_tags) as t where not exists (select 1 from unnest(coalesce(v.tags, '{}')) as e where lower(e) = lower(t)))
    where v.id = any(v_vendor) and not '__deleted' = any(coalesce(v.tags, '{}'))
      and exists (select 1 from unnest(v_tags) as t where not exists (select 1 from unnest(coalesce(v.tags, '{}')) as e where lower(e) = lower(t)));
    update public.lost_contacts as l
    set tags = coalesce(l.tags, '{}') || array(select t from unnest(v_tags) as t where not exists (select 1 from unnest(coalesce(l.tags, '{}')) as e where lower(e) = lower(t)))
    where l.id = any(v_lost) and not '__deleted' = any(coalesce(l.tags, '{}'))
      and exists (select 1 from unnest(v_tags) as t where not exists (select 1 from unnest(coalesce(l.tags, '{}')) as e where lower(e) = lower(t)));
  elsif v_type = 'remove_tags' then
    update public.manufacturers as m
    set tags = array(select e from unnest(coalesce(m.tags, '{}')) as e where e like '\_\_%' or not lower(e) = any(v_tags_lower))
    where m.id = any(v_mfr) and not '__deleted' = any(coalesce(m.tags, '{}'))
      and exists (select 1 from unnest(coalesce(m.tags, '{}')) as e where e not like '\_\_%' and lower(e) = any(v_tags_lower));
    update public.vendors as v
    set tags = array(select e from unnest(coalesce(v.tags, '{}')) as e where e like '\_\_%' or not lower(e) = any(v_tags_lower))
    where v.id = any(v_vendor) and not '__deleted' = any(coalesce(v.tags, '{}'))
      and exists (select 1 from unnest(coalesce(v.tags, '{}')) as e where e not like '\_\_%' and lower(e) = any(v_tags_lower));
    update public.lost_contacts as l
    set tags = array(select e from unnest(coalesce(l.tags, '{}')) as e where e like '\_\_%' or not lower(e) = any(v_tags_lower))
    where l.id = any(v_lost) and not '__deleted' = any(coalesce(l.tags, '{}'))
      and exists (select 1 from unnest(coalesce(l.tags, '{}')) as e where e not like '\_\_%' and lower(e) = any(v_tags_lower));
  elsif v_type = 'archive' then
    -- Same soft delete as archive_crm_company, with one ledger entry per company
    -- so restore_crm_company can bring back each company's previous stage.
    for r in select b.value as snap from jsonb_array_elements(v_before) as b
      where not coalesce((b.value->'tags') ? '__deleted', false)
    loop
      if r.snap->>'company_type' = 'manufacturer' then
        update public.manufacturers as m
        set tags = coalesce(m.tags, '{}') || text '__deleted'
          || case when '__finder_skip' = any(coalesce(m.tags, '{}')) then '{}'::text[] else array['__finder_skip'] end,
          stage = 'Closed Lost'
        where m.id = (r.snap->>'company_id')::bigint;
      elsif r.snap->>'company_type' = 'vendor' then
        update public.vendors as v set tags = coalesce(v.tags, '{}') || text '__deleted' where v.id = (r.snap->>'company_id')::bigint;
      else
        update public.lost_contacts as l set tags = coalesce(l.tags, '{}') || text '__deleted' where l.id = (r.snap->>'company_id')::bigint;
      end if;
      insert into private.mcp_crm_write_operations (actor, operation_id, action, request_fingerprint, target_type,
        target_id, before_values, after_values, result)
      values (v_actor, md5(p_operation_id::text || ':' || (r.snap->>'company_type') || ':' || (r.snap->>'company_id'))::uuid,
        'archive_company', 'bulk:' || p_operation_id::text, r.snap->>'company_type', (r.snap->>'company_id')::bigint,
        jsonb_build_object('stage', r.snap->>'stage', 'tags', r.snap->'tags'), null,
        jsonb_build_object('ok', true, 'status', 'archived', 'bulk_operation_id', p_operation_id,
          'reason', v_preview.operation->>'reason'));
    end loop;
  end if;

  v_after := private.crm_bulk_snapshot(v_preview.targets);
  select coalesce(jsonb_agg(jsonb_build_object('company_id', a.value->'company_id', 'company_type', a.value->'company_type',
    'company_name', a.value->'company_name', 'before', b.value - 'company_id' - 'company_type' - 'company_name',
    'after', a.value - 'company_id' - 'company_type' - 'company_name')), '[]'::jsonb)
  into v_changed
  from jsonb_array_elements(v_after) as a
  join jsonb_array_elements(v_before) as b
    on b.value->'company_id' = a.value->'company_id' and b.value->'company_type' = a.value->'company_type'
  where a.value <> b.value;

  update private.crm_bulk_previews as preview
  set consumed_at = now(), consumed_operation_id = p_operation_id
  where preview.token = p_preview_token;

  v_result := jsonb_build_object('ok', true, 'status', 'applied', 'changed', jsonb_array_length(v_changed) > 0,
    'operation', v_preview.operation, 'changed_count', jsonb_array_length(v_changed), 'companies', v_changed);
  return private.mcp_operation_record(v_actor, p_operation_id, 'bulk_operation', v_fingerprint,
    'bulk', null, v_before, v_after, v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- CSV export rows (the MCP server writes the CSV file). Columns follow the
-- CRM website's Export CSV per tab, plus company_id.
-- ---------------------------------------------------------------------------

create or replace function private.crm_notes_plain(p_notes text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select btrim(regexp_replace(
    replace(replace(replace(replace(replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      coalesce(p_notes, ''),
      '<img[^>]*>', '[image]', 'gi'),
      'data:image/[^\s"'')]+', '[image]', 'gi'),
      '<br\s*/?>|</(div|p|li)>', E'\n', 'gi'),
      '<[^>]+>', '', 'g'),
      '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&amp;', '&'),
    E'\n{3,}', E'\n\n', 'g'));
$function$;

create or replace function public.mcp_export_crm_companies(
  p_company_type text,
  p_filters jsonb,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_type text := lower(btrim(coalesce(p_company_type, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_total integer;
  v_rows jsonb;
begin
  if v_type not in ('manufacturer', 'vendor', 'lost') then
    raise exception 'Export company_type must be manufacturer, vendor, or lost' using errcode = '22023';
  end if;
  v_filters := v_filters || jsonb_build_object('company_types', jsonb_build_array(v_type));

  select count(*) into v_total from private.crm_filtered_company_keys(v_filters);

  with keys as (
    select k.company_id from private.crm_filtered_company_keys(v_filters) as k
  ),
  companies as (
    select m.id, m.company, m.stage, m.industry, m.signals as notes, m.tags, m.last_contact,
      null::text as name, null::text as title, null::text as email, null::text as phone, null::text as region,
      null::text as lost_reason, null::numeric as deal_value
    from public.manufacturers as m where v_type = 'manufacturer' and m.id in (select company_id from keys)
    union all
    select v.id, v.company, v.stage, v.industry, v.notes, v.tags, v.last_contact, v.name, v.title, v.email, v.phone,
      v.region, null::text, null::numeric
    from public.vendors as v where v_type = 'vendor' and v.id in (select company_id from keys)
    union all
    select l.id, l.company, null::text, l.industry, l.notes, l.tags, l.last_contact, l.name, l.title, l.email, l.phone,
      l.region, l.lost_reason, l.deal_value
    from public.lost_contacts as l where v_type = 'lost' and l.id in (select company_id from keys)
  ),
  limited as (
    select * from companies order by lower(company), id limit v_limit
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('company_id', c.id, 'company', btrim(c.company))
    || case when v_type = 'manufacturer' then jsonb_build_object('stage', c.stage, 'industry', coalesce(c.industry, ''))
       else jsonb_build_object('name', coalesce(c.name, ''), 'title', coalesce(c.title, ''), 'email', coalesce(c.email, ''),
         'phone', coalesce(c.phone, ''), 'industry', coalesce(c.industry, ''), 'region', coalesce(c.region, '')) end
    || case when v_type = 'vendor' then jsonb_build_object('stage', coalesce(c.stage, '')) else '{}'::jsonb end
    || case when v_type = 'lost' then jsonb_build_object('loss_reason', coalesce(c.lost_reason, ''), 'value', coalesce(c.deal_value, 0)) else '{}'::jsonb end
    || jsonb_build_object(
      'notes', private.crm_notes_plain(c.notes),
      'contacts', (select coalesce(string_agg(concat_ws(' | ', nullif(x.name, ''), nullif(x.title, ''), nullif(x.linkedin, '')), ' ;; ' order by x.id), '')
        from (
          select mc.id, mc.name, mc.title, mc.linkedin from public.manufacturer_contacts as mc where v_type = 'manufacturer' and mc.manufacturer_id = c.id
          union all
          select vc.id, vc.name, vc.title, vc.linkedin from public.vendor_contacts as vc where v_type = 'vendor' and vc.vendor_id = c.id
        ) as x),
      'activities', (select coalesce(string_agg(concat_ws(' | ', a.date::text, a.type, nullif(a.created_by, ''), private.crm_note_preview(a.note, 2000)), ' ;; ' order by a.date desc nulls last, a.id desc), '')
        from public.activities as a
        where a.contact_type = v_type and a.contact_id = c.id and private.crm_task_marker(a.created_by) is null),
      'follow_ups', (select coalesce(string_agg(concat_ws(' | ', coalesce(a.date::text, 'No due date'),
          case when private.crm_task_marker(a.created_by)->>'state' = 'done' then 'Done' else 'Open' end,
          private.crm_task_marker(a.created_by)->>'owner', a.note), ' ;; ' order by a.date asc nulls last, a.id), '')
        from public.activities as a
        where a.contact_type = v_type and a.contact_id = c.id and private.crm_task_marker(a.created_by) is not null),
      'tags', array_to_string(array(select t from unnest(coalesce(c.tags, '{}')) as t where t not like '\_\_%'), ', '),
      'aliases', (select coalesce(string_agg(al.alias, '; ' order by al.alias), '') from public.crm_company_aliases as al
        where al.company_type = v_type and al.company_id = c.id),
      'last_activity', coalesce(c.last_contact::text, '')
    ) order by lower(c.company), c.id), '[]'::jsonb)
  into v_rows
  from limited as c;

  return jsonb_build_object('ok', true, 'company_type', v_type, 'total_matching', v_total,
    'exported_count', jsonb_array_length(v_rows), 'truncated', v_total > jsonb_array_length(v_rows), 'rows', v_rows);
end;
$function$;

-- ---------------------------------------------------------------------------
-- CSV import: the MCP server parses the file into rows; preview computes a
-- deterministic plan and apply refuses to run if that plan would now differ.
-- ---------------------------------------------------------------------------

create or replace function private.crm_import_plan(
  p_company_type text,
  p_rows jsonb,
  p_decisions jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_row jsonb;
  v_plan jsonb := '[]'::jsonb;
  v_keys text[] := '{}';
  v_key_rows jsonb := '{}'::jsonb;
  v_file_linkedins text[] := '{}';
  v_decision jsonb;
  v_row_number integer;
  v_company text;
  v_key text;
  v_candidates jsonb;
  v_action text;
  v_target jsonb;
  v_errors text[];
  v_warnings text[];
  v_extra text[];
  v_stage text;
  v_industry text;
  v_last date;
  v_contact jsonb;
  v_add jsonb;
  v_skip jsonb;
  v_name text;
  v_title text;
  v_linkedin text;
  v_names text[];
  v_conflict jsonb;
begin
  for v_row in select value from jsonb_array_elements(p_rows) order by (value->>'row_number')::integer loop
    v_row_number := (v_row->>'row_number')::integer;
    v_errors := '{}';
    v_warnings := '{}';
    v_extra := '{}';
    v_target := null;
    v_candidates := '[]'::jsonb;
    v_add := '[]'::jsonb;
    v_skip := '[]'::jsonb;
    v_names := '{}';
    select d into v_decision from jsonb_array_elements(coalesce(p_decisions, '[]'::jsonb)) as d
    where (d->>'row_number')::integer = v_row_number limit 1;

    v_company := btrim(regexp_replace(coalesce(v_row->>'company', ''), '\s+', ' ', 'g'));
    v_key := replace(private.normalize_crm_company_words(v_company), ' ', '');
    if v_company = '' then
      v_errors := v_errors || text 'Company name is missing';
    elsif length(v_company) > 300 or length(v_key) < 2 then
      v_errors := v_errors || text 'Company name is not a usable company name';
    end if;

    v_stage := case when btrim(coalesce(v_row->>'stage', '')) = '' then 'Prospect' else private.crm_canonical_stage(v_row->>'stage') end;
    if v_stage is null then
      -- Same as the CRM website's importer: unknown stages import as Prospect.
      v_warnings := v_warnings || ('Unknown stage "' || (v_row->>'stage') || '" imported as Prospect');
      v_stage := 'Prospect';
    end if;
    v_industry := btrim(coalesce(v_row->>'industry', ''));
    if p_company_type = 'manufacturer' and v_industry <> '' then
      if lower(v_industry) = 'others' then
        v_industry := '';
      elsif private.crm_manufacturer_industry_bucket(v_industry) = 'Others' then
        v_extra := v_extra || ('Industry: ' || v_industry);
        v_warnings := v_warnings || ('Industry "' || v_industry || '" is not a CRM category; kept in notes');
        v_industry := '';
      else
        v_industry := private.crm_manufacturer_industry_bucket(v_industry);
      end if;
    elsif length(v_industry) > 200 then
      v_warnings := v_warnings || text 'Industry truncated to 200 characters';
      v_industry := left(v_industry, 200);
    end if;
    v_last := null;
    if btrim(coalesce(v_row->>'last_contact', '')) <> '' then
      if v_row->>'last_contact' ~ '^\d{4}-\d{2}-\d{2}$' then
        v_last := (v_row->>'last_contact')::date;
      else
        v_warnings := v_warnings || ('Unrecognized date "' || (v_row->>'last_contact') || '" ignored');
      end if;
    end if;

    if cardinality(v_errors) > 0 then
      v_action := 'invalid';
    elsif coalesce(v_decision->>'action', '') = 'skip' then
      v_action := 'skip';
    elsif v_key = any(v_keys) then
      v_action := 'duplicate_in_file';
      v_warnings := v_warnings || ('Same company as row ' || (v_key_rows->>v_key));
    else
      v_keys := v_keys || v_key;
      v_key_rows := v_key_rows || jsonb_build_object(v_key, v_row_number);
      v_candidates := private.crm_company_name_matches(v_company, null, null);
      if jsonb_path_exists(v_candidates, '$[*] ? (@.match == "exact")') then
        select jsonb_build_object('company_id', (c->>'company_id')::bigint, 'company_type', c->>'company_type',
          'company_name', c->>'company_name')
        into v_target
        from jsonb_array_elements(v_candidates) as c
        where v_decision->>'action' = 'add_to_existing'
          and c->>'match' = 'exact' and not (c->>'hidden')::boolean
          and c->>'company_type' = p_company_type
          and (c->>'company_id')::bigint = (v_decision->>'company_id')::bigint
          and c->>'company_type' = v_decision->>'company_type'
        limit 1;
        v_action := case when v_target is not null then 'add_to_existing' else 'blocked_existing' end;
      elsif jsonb_array_length(v_candidates) > 0 and coalesce(v_decision->>'action', '') <> 'create_anyway' then
        v_action := 'needs_decision';
      else
        v_action := 'create';
      end if;
    end if;

    if v_action in ('create', 'add_to_existing') then
      for v_contact in select value from jsonb_array_elements(coalesce(v_row->'contacts', '[]'::jsonb)) loop
        v_name := btrim(regexp_replace(coalesce(v_contact->>'name', ''), '\s+', ' ', 'g'));
        v_title := btrim(regexp_replace(coalesce(v_contact->>'title', ''), '\s+', ' ', 'g'));
        if length(v_name) < 2 or length(v_name) > 200 or length(v_title) > 200 or position(',' in v_name) > 0
          or position(',' in v_title) > 0 or length(replace(private.normalize_crm_person_name(v_name), ' ', '')) < 2 then
          v_skip := v_skip || jsonb_build_object('name', v_name, 'reason', 'Invalid name or title (2-200 characters, no commas)');
          continue;
        end if;
        v_linkedin := private.normalize_linkedin_profile_url(v_contact->>'linkedin');
        if v_linkedin is null then
          v_warnings := v_warnings || ('LinkedIn value for ' || v_name || ' is not a profile URL; left blank');
          v_linkedin := '';
        end if;
        if private.normalize_crm_person_name(v_name) = any(v_names) then
          v_skip := v_skip || jsonb_build_object('name', v_name, 'reason', 'Duplicate name in this row');
          continue;
        end if;
        if v_linkedin <> '' and v_linkedin = any(v_file_linkedins) then
          v_skip := v_skip || jsonb_build_object('name', v_name, 'reason', 'LinkedIn profile repeated earlier in the file');
          continue;
        end if;
        v_conflict := private.crm_contact_conflict(coalesce(v_target->>'company_type', p_company_type),
          coalesce((v_target->>'company_id')::bigint, -1), v_name, v_linkedin, null, null,
          v_action = 'add_to_existing', true);
        if v_conflict is not null then
          v_skip := v_skip || jsonb_build_object('name', v_name, 'reason', v_conflict->>'reason', 'conflict', v_conflict);
          continue;
        end if;
        v_add := v_add || jsonb_build_object('name', v_name, 'title', v_title, 'linkedin', v_linkedin);
        v_names := v_names || private.normalize_crm_person_name(v_name);
        if v_linkedin <> '' then
          v_file_linkedins := v_file_linkedins || v_linkedin;
        end if;
      end loop;
    end if;

    v_plan := v_plan || jsonb_build_object(
      'row_number', v_row_number,
      'company', v_company,
      'action', v_action,
      'target', v_target,
      'candidates', case when v_action in ('blocked_existing', 'needs_decision', 'add_to_existing') then v_candidates else '[]'::jsonb end,
      'stage', v_stage,
      'industry', v_industry,
      'last_contact', v_last,
      'extra_note_lines', to_jsonb(v_extra),
      'contacts_to_add', v_add,
      'contacts_skipped', v_skip,
      'warnings', to_jsonb(v_warnings),
      'errors', to_jsonb(v_errors));
  end loop;
  return v_plan;
end;
$function$;

create or replace function public.mcp_preview_crm_import(
  p_company_type text,
  p_rows jsonb,
  p_decisions jsonb,
  p_source_name text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_type text := lower(btrim(coalesce(p_company_type, '')));
  v_decisions jsonb := coalesce(p_decisions, '[]'::jsonb);
  v_plan jsonb;
  v_summary jsonb;
  v_token uuid;
  v_expires timestamp with time zone := now() + interval '30 minutes';
begin
  if v_type not in ('manufacturer', 'vendor') then
    raise exception 'Imports create manufacturers or vendors' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The import has no rows' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'An import is limited to 500 rows' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) as r
    where jsonb_typeof(r) <> 'object' or coalesce(r->>'row_number', '') !~ '^\d+$'
      or exists (select 1 from jsonb_object_keys(r) as k where k not in ('row_number', 'company', 'stage', 'industry',
        'notes', 'tags', 'last_contact', 'end_product', 'person_name', 'person_title', 'email', 'phone', 'region', 'contacts'))) then
    raise exception 'Import rows contain unsupported fields' using errcode = '22023';
  end if;
  if (select count(distinct r->>'row_number') from jsonb_array_elements(p_rows) as r) <> jsonb_array_length(p_rows) then
    raise exception 'Import row numbers must be unique' using errcode = '22023';
  end if;
  if jsonb_typeof(v_decisions) <> 'array' or exists (select 1 from jsonb_array_elements(v_decisions) as d
    where coalesce(d->>'row_number', '') !~ '^\d+$'
      or coalesce(d->>'action', '') not in ('skip', 'add_to_existing', 'create_anyway')
      or (d->>'action' = 'add_to_existing' and (coalesce(d->>'company_id', '') !~ '^\d+$' or coalesce(d->>'company_type', '') not in ('manufacturer', 'vendor')))) then
    raise exception 'Decisions must be {row_number, action: skip | add_to_existing (with company_id, company_type) | create_anyway}'
      using errcode = '22023';
  end if;

  v_plan := private.crm_import_plan(v_type, p_rows, v_decisions);
  select jsonb_build_object(
    'rows', jsonb_array_length(v_plan),
    'create', count(*) filter (where p->>'action' = 'create'),
    'add_to_existing', count(*) filter (where p->>'action' = 'add_to_existing'),
    'blocked_existing', count(*) filter (where p->>'action' = 'blocked_existing'),
    'needs_decision', count(*) filter (where p->>'action' = 'needs_decision'),
    'duplicate_in_file', count(*) filter (where p->>'action' = 'duplicate_in_file'),
    'invalid', count(*) filter (where p->>'action' = 'invalid'),
    'skip', count(*) filter (where p->>'action' = 'skip'),
    'contacts_to_add', coalesce(sum(jsonb_array_length(p->'contacts_to_add')), 0),
    'contacts_skipped', coalesce(sum(jsonb_array_length(p->'contacts_skipped')), 0))
  into v_summary
  from jsonb_array_elements(v_plan) as p;

  if (v_summary->>'create')::integer + (v_summary->>'add_to_existing')::integer = 0 then
    return jsonb_build_object('ok', true, 'status', 'nothing_to_import', 'company_type', v_type,
      'summary', v_summary, 'rows', v_plan);
  end if;

  insert into private.crm_import_previews (actor, company_type, source_name, rows, decisions, plan_hash, expires_at)
  values (v_actor, v_type, left(p_source_name, 200), p_rows, v_decisions, md5(v_plan::text), v_expires)
  returning token into v_token;

  return jsonb_build_object('ok', true, 'status', 'preview_ready', 'preview_token', v_token, 'expires_at', v_expires,
    'company_type', v_type, 'summary', v_summary, 'rows', v_plan);
end;
$function$;

create or replace function public.mcp_apply_crm_import(
  p_operation_id uuid,
  p_preview_token uuid,
  p_confirm boolean,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_fingerprint text;
  v_replay jsonb;
  v_preview private.crm_import_previews%rowtype;
  v_plan jsonb;
  v_item jsonb;
  v_src jsonb;
  v_batch text := to_char(now() at time zone 'America/Toronto', 'YYYYMMDD-HH24MISS');
  v_today date := private.crm_toronto_today();
  v_notes text;
  v_tags text[];
  v_company_id bigint;
  v_company_type text;
  v_contact jsonb;
  v_created jsonb := '[]'::jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_contacts_added integer := 0;
  v_row jsonb;
  v_result jsonb;
begin
  if not coalesce(p_confirm, false) then
    raise exception 'Imports require confirm=true after the user approved the preview' using errcode = '22023';
  end if;
  if p_preview_token is null then
    raise exception 'A preview token from preview_crm_import is required' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('token', p_preview_token)::text);
  perform pg_advisory_xact_lock(hashtext('edi_crm_mcp_create_company'));
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'apply_import', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  select preview.* into v_preview from private.crm_import_previews as preview
  where preview.token = p_preview_token and preview.actor = v_actor
  for update;
  if not found then
    raise exception 'Unknown import preview token' using errcode = '22023';
  end if;
  if v_preview.consumed_at is not null then
    raise exception 'This import preview token was already used by operation %', v_preview.consumed_operation_id
      using errcode = '22023';
  end if;
  if v_preview.expires_at < now() then
    return jsonb_build_object('ok', false, 'status', 'preview_expired', 'changed', false,
      'reason', 'The import preview expired; preview again and confirm with the user', 'replayed', false);
  end if;

  v_plan := private.crm_import_plan(v_preview.company_type, v_preview.rows, v_preview.decisions);
  if md5(v_plan::text) <> v_preview.plan_hash then
    return jsonb_build_object('ok', false, 'status', 'preview_stale', 'changed', false,
      'reason', 'The CRM changed since the preview (duplicates or contacts differ); preview again and confirm with the user',
      'replayed', false);
  end if;

  for v_item in select value from jsonb_array_elements(v_plan) where value->>'action' in ('create', 'add_to_existing') loop
    select r into v_src from jsonb_array_elements(v_preview.rows) as r
    where (r->>'row_number')::integer = (v_item->>'row_number')::integer limit 1;
    v_notes := private.crm_notes_append_plain(left(btrim(coalesce(v_src->>'notes', '')), 20000),
      array_to_string(array(select jsonb_array_elements_text(v_item->'extra_note_lines')), E'\n'));
    begin
      v_tags := private.crm_clean_visible_tags(v_src->'tags');
    exception when others then
      v_tags := '{}';
    end;

    if v_item->>'action' = 'create' then
      v_company_type := v_preview.company_type;
      if v_company_type = 'manufacturer' then
        insert into public.manufacturers (company, stage, industry, end_product, signals, tags, last_contact)
        values (v_item->>'company', v_item->>'stage', coalesce(v_item->>'industry', ''),
          nullif(left(btrim(coalesce(v_src->>'end_product', '')), 500), ''), coalesce(v_notes, ''),
          v_tags || ('__import_batch_new:' || v_batch), coalesce((v_item->>'last_contact')::date, v_today))
        returning id into v_company_id;
      else
        insert into public.vendors (company, name, title, email, phone, industry, region, stage, notes, tags, last_contact)
        values (v_item->>'company', left(btrim(coalesce(v_src->>'person_name', '')), 200),
          left(btrim(coalesce(v_src->>'person_title', '')), 200), left(btrim(coalesce(v_src->>'email', '')), 320),
          left(btrim(coalesce(v_src->>'phone', '')), 50), coalesce(v_item->>'industry', ''),
          left(btrim(coalesce(v_src->>'region', '')), 200), v_item->>'stage', coalesce(v_notes, ''),
          v_tags || ('__import_batch_new:' || v_batch), coalesce((v_item->>'last_contact')::date, v_today))
        returning id into v_company_id;
      end if;
      v_created := v_created || jsonb_build_object('row_number', (v_item->>'row_number')::integer,
        'company_id', v_company_id, 'company_type', v_company_type, 'company_name', v_item->>'company');
    else
      v_company_type := v_item->'target'->>'company_type';
      v_company_id := (v_item->'target'->>'company_id')::bigint;
      v_row := private.crm_company_row(v_company_type, v_company_id, true);
      -- Existing companies are never overwritten: notes are appended and only
      -- new tags and contacts are added.
      if v_company_type = 'manufacturer' then
        update public.manufacturers as m
        set signals = case when btrim(coalesce(v_notes, '')) = '' or position(v_notes in coalesce(m.signals, '')) > 0 then m.signals
            else private.crm_notes_append_plain(m.signals, 'Imported ' || v_today || E':\n' || v_notes) end,
          tags = coalesce(m.tags, '{}') || array(select t from unnest(v_tags) as t
            where not exists (select 1 from unnest(coalesce(m.tags, '{}')) as e where lower(e) = lower(t)))
        where m.id = v_company_id;
      else
        update public.vendors as v
        set notes = case when btrim(coalesce(v_notes, '')) = '' or position(v_notes in coalesce(v.notes, '')) > 0 then v.notes
            else private.crm_notes_append_plain(v.notes, 'Imported ' || v_today || E':\n' || v_notes) end,
          tags = coalesce(v.tags, '{}') || array(select t from unnest(v_tags) as t
            where not exists (select 1 from unnest(coalesce(v.tags, '{}')) as e where lower(e) = lower(t)))
        where v.id = v_company_id;
      end if;
      v_updated := v_updated || jsonb_build_object('row_number', (v_item->>'row_number')::integer,
        'company_id', v_company_id, 'company_type', v_company_type, 'company_name', v_row->>'company');
    end if;

    for v_contact in select value from jsonb_array_elements(v_item->'contacts_to_add') loop
      if v_company_type = 'manufacturer' then
        insert into public.manufacturer_contacts (manufacturer_id, name, title, linkedin)
        values (v_company_id, v_contact->>'name', coalesce(v_contact->>'title', ''), coalesce(v_contact->>'linkedin', ''));
      else
        insert into public.vendor_contacts (vendor_id, name, title, linkedin)
        values (v_company_id, v_contact->>'name', coalesce(v_contact->>'title', ''), coalesce(v_contact->>'linkedin', ''));
      end if;
      v_contacts_added := v_contacts_added + 1;
    end loop;
  end loop;

  update private.crm_import_previews as preview
  set consumed_at = now(), consumed_operation_id = p_operation_id
  where preview.token = p_preview_token;

  v_result := jsonb_build_object('ok', true, 'status', 'imported', 'changed', true,
    'company_type', v_preview.company_type, 'import_batch_id', case when jsonb_array_length(v_created) > 0 then v_batch end,
    'created_count', jsonb_array_length(v_created), 'updated_count', jsonb_array_length(v_updated),
    'contacts_added', v_contacts_added, 'created', v_created, 'updated_existing', v_updated);
  return private.mcp_operation_record(v_actor, p_operation_id, 'apply_import', v_fingerprint,
    'import', null, null, jsonb_build_object('created', v_created, 'updated', v_updated, 'batch', v_batch), v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Lead finder: status and the same cloud command queue the CRM website uses.
-- ---------------------------------------------------------------------------

create or replace function private.crm_finder_state_json(p_settings jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  -- The finder publishes its dashboard state here. Only scalar status fields,
  -- a fixed subset of run settings, and the review results are returned; keys
  -- that could hold credentials or local file paths are dropped.
  select case when p_settings is null then null else jsonb_build_object(
    'status', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      from jsonb_each(case when jsonb_typeof(p_settings->'status') = 'object' then p_settings->'status' else '{}'::jsonb end) as e
      where e.key !~* '(key|token|secret|password|auth|pid|path)'
        and jsonb_typeof(e.value) in ('string', 'number', 'boolean', 'null')),
    'run_settings', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      from jsonb_each(case when jsonb_typeof(p_settings->'settings') = 'object' then p_settings->'settings' else '{}'::jsonb end) as e
      where e.key in ('industries', 'citiesText', 'cityLimit', 'resultsPerQuery', 'websitePageLimit', 'minEmployees',
        'province', 'cloudAutoRun', 'autoRun', 'enabled')),
    'published_at', p_settings->'remotePublishedAt',
    'source', p_settings->'remoteSource',
    'results', case when jsonb_typeof(p_settings->'results') = 'object' then jsonb_build_object(
      'total', p_settings->'results'->'total',
      'stage_counts', p_settings->'results'->'stageCounts',
      'progress', p_settings->'results'->'progress',
      'headers', p_settings->'results'->'headers',
      'rows', (select coalesce(jsonb_agg(x.row_value order by x.ord), '[]'::jsonb)
        from (select rr.row_value, rr.ord
          from jsonb_array_elements(case when jsonb_typeof(p_settings->'results'->'rows') = 'array' then p_settings->'results'->'rows' else '[]'::jsonb end)
            with ordinality as rr(row_value, ord)
          order by rr.ord limit 100) as x)) end)
    || jsonb_build_object('recent_logs', (
      select coalesce(jsonb_agg(x.line order by x.ord), '[]'::jsonb)
      from (
        select l.line, l.ord
        from jsonb_array_elements_text(case when jsonb_typeof(p_settings->'logs') = 'array' then p_settings->'logs' else '[]'::jsonb end)
          with ordinality as l(line, ord)
        order by l.ord desc
        limit 25
      ) as x))
  end;
$function$;

create or replace function public.mcp_get_lead_finder_status()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_build_object(
    'ok', true,
    'cloud', (select private.crm_finder_state_json(fc.settings) || jsonb_build_object('state_row_status', fc.status)
      from public.finder_commands as fc where fc.id = '00000000-0000-4000-8000-000000000879'),
    'local_dashboard', (select private.crm_finder_state_json(fc.settings) || jsonb_build_object('state_row_status', fc.status)
      from public.finder_commands as fc where fc.id = '00000000-0000-4000-8000-000000000878'),
    'queued_commands', (select coalesce(jsonb_agg(jsonb_build_object('command_id', fc.id, 'command', fc.command,
        'status', fc.status, 'target', fc.settings->>'target', 'created_at', fc.created_at) order by fc.created_at desc), '[]'::jsonb)
      from public.finder_commands as fc
      where fc.command in ('start', 'stop') and fc.status in ('cloud_pending', 'pending')),
    'recent_commands', (select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
      select jsonb_build_object('command_id', fc.id, 'command', fc.command, 'status', fc.status,
        'target', fc.settings->>'target', 'industries', fc.settings->'industries', 'created_at', fc.created_at) as x
      from public.finder_commands as fc
      where fc.command in ('start', 'stop')
      order by fc.created_at desc limit 5) as recent)
  );
$function$;

create or replace function public.mcp_queue_lead_finder_command(
  p_operation_id uuid,
  p_command text,
  p_industries jsonb,
  p_cities jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_command text := lower(btrim(coalesce(p_command, '')));
  v_presets constant text[] := array['food_beverage', 'concrete', 'metal_refineries', 'recycling', 'aggregate_asphalt',
    'packaging', 'building_products', 'others'];
  v_city_chips constant text[] := array['Milton', 'Mississauga', 'Brampton', 'Oakville', 'Burlington', 'Hamilton', 'Ancaster',
    'Toronto', 'Etobicoke', 'North York', 'Scarborough', 'Vaughan', 'Woodbridge', 'Concord', 'Markham', 'Richmond Hill',
    'Whitchurch-Stouffville', 'Georgetown', 'Halton Hills', 'Acton', 'Guelph', 'Cambridge', 'Kitchener', 'Waterloo',
    'Brantford', 'Stoney Creek', 'Grimsby', 'Dundas', 'Caledon', 'Bolton', 'Paris', 'Ayr', 'Flamborough', 'Ajax',
    'Pickering', 'Oshawa'];
  v_industries text[];
  v_cities text[];
  v_fingerprint text;
  v_replay jsonb;
  v_settings jsonb;
  v_command_id uuid;
  v_result jsonb;
begin
  if v_command not in ('start', 'stop') then
    raise exception 'Lead finder command must be start or stop' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('command', v_command, 'industries', p_industries, 'cities', p_cities)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'lead_finder_' || v_command, v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_command = 'start' then
    v_industries := coalesce(private.crm_text_array_filter(jsonb_build_object('v', p_industries), 'v'), v_presets);
    if cardinality(v_industries) = 0 then v_industries := v_presets; end if;
    if exists (select 1 from unnest(v_industries) as i where not i = any(v_presets)) then
      raise exception 'Industries must be from: %', array_to_string(v_presets, ', ') using errcode = '22023';
    end if;
    v_cities := coalesce(private.crm_text_array_filter(jsonb_build_object('v', p_cities), 'v'), v_city_chips);
    if cardinality(v_cities) = 0 then v_cities := v_city_chips; end if;
    if exists (select 1 from unnest(v_cities) as c where not c = any(v_city_chips)) then
      raise exception 'Cities must be from the CRM city list: %', array_to_string(v_city_chips, ', ') using errcode = '22023';
    end if;
    if exists (select 1 from public.finder_commands as fc where fc.command = 'start' and fc.status = 'cloud_pending') then
      v_result := jsonb_build_object('ok', true, 'status', 'already_queued', 'changed', false,
        'message', 'A cloud lead finder start is already queued; GitHub cloud will pick it up shortly.');
      return private.mcp_operation_record(v_actor, p_operation_id, 'lead_finder_start', v_fingerprint,
        'finder_command', null, null, null, v_result);
    end if;
    v_settings := jsonb_build_object('target', 'cloud', 'industries', to_jsonb(v_industries),
      'citiesText', array_to_string(v_cities, E'\n'));
  else
    v_settings := jsonb_build_object('target', 'cloud');
  end if;

  insert into public.finder_commands (command, status, settings)
  values (v_command, 'cloud_pending', v_settings)
  returning id into v_command_id;

  v_result := jsonb_build_object('ok', true, 'status', 'queued', 'changed', true, 'command', v_command,
    'command_id', v_command_id, 'settings', v_settings,
    'message', case when v_command = 'start'
      then 'Start queued. The GitHub cloud listener checks about every 5 minutes; results are review CSVs and are not imported into the CRM automatically.'
      else 'Stop queued. The GitHub cloud run stops after it sees the command.' end);
  return private.mcp_operation_record(v_actor, p_operation_id, 'lead_finder_' || v_command, v_fingerprint,
    'finder_command', null, null, v_settings, v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- update_crm_company: v8 behaviour plus the lost record's inline person.
-- ---------------------------------------------------------------------------

create or replace function public.mcp_update_crm_company(
  p_operation_id uuid,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_patch jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_allowed constant text[] := array[
    'company_name', 'stage', 'industry', 'region', 'email', 'phone', 'lost_reason',
    'deal_value', 'notes_append', 'notes_replace', 'expected_notes_sha256', 'add_tags',
    'remove_tags', 'add_aliases', 'remove_aliases', 'allow_similar_names', 'person_name', 'person_title'
  ];
  v_field text;
  v_fingerprint text;
  v_replay jsonb;
  v_row jsonb;
  v_type text;
  v_name text;
  v_stage text;
  v_industry text;
  v_region text;
  v_email text;
  v_phone text;
  v_lost_reason text;
  v_person_name text;
  v_person_title text;
  v_deal numeric;
  v_notes text;
  v_tags text[];
  v_value text;
  v_changed text[] := '{}';
  v_candidates jsonb := '[]'::jsonb;
  v_after jsonb;
  v_result jsonb;
  v_alias text;
  v_alias_key text;
  v_aliases_added text[] := '{}';
  v_aliases_removed text[] := '{}';
  v_alias_conflict jsonb;
begin
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'Update fields must be an object' using errcode = '22023';
  end if;
  for v_field in select jsonb_object_keys(v_patch) loop
    if not v_field = any(v_allowed) then
      raise exception 'Field % cannot be updated through this tool', v_field using errcode = '22023';
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(v_patch) as k where k not in ('allow_similar_names', 'expected_notes_sha256')) = 0 then
    raise exception 'Provide at least one field to update' using errcode = '22023';
  end if;
  if v_patch ? 'notes_append' and v_patch ? 'notes_replace' then
    raise exception 'Use either notes_append or notes_replace, not both' using errcode = '22023';
  end if;

  v_fingerprint := md5(jsonb_build_object(
    'type', lower(btrim(coalesce(p_company_type, ''))), 'id', p_company_id,
    'expected', lower(btrim(coalesce(p_expected_company_name, ''))), 'patch', v_patch
  )::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'update_company', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_row := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);
  v_type := v_row->>'_type';
  if (v_row->>'_archived')::boolean then
    raise exception 'CRM % company % is archived; restore it before updating', v_type, p_company_id
      using errcode = '22023';
  end if;

  v_name := v_row->>'company';
  v_stage := v_row->>'stage';
  v_industry := coalesce(v_row->>'industry', '');
  v_region := v_row->>'region';
  v_email := v_row->>'email';
  v_phone := v_row->>'phone';
  v_lost_reason := v_row->>'lost_reason';
  v_person_name := v_row->>'name';
  v_person_title := v_row->>'title';
  v_deal := (v_row->>'deal_value')::numeric;
  v_notes := private.crm_company_notes(v_type, v_row);
  v_tags := coalesce(array(select jsonb_array_elements_text(
    case when jsonb_typeof(v_row->'tags') = 'array' then v_row->'tags' else '[]'::jsonb end)), '{}');

  if v_patch ? 'company_name' then
    v_value := btrim(regexp_replace(coalesce(v_patch->>'company_name', ''), '\s+', ' ', 'g'));
    if length(v_value) < 2 or length(v_value) > 300 then
      raise exception 'Company name must contain 2 to 300 characters' using errcode = '22023';
    end if;
    if length(replace(private.normalize_crm_company_words(v_value), ' ', '')) < 2 then
      raise exception 'Company name must contain a distinctive name, not only a legal suffix'
        using errcode = '22023';
    end if;
    if v_value <> v_name then
      if private.normalize_crm_company_words(v_value) <> private.normalize_crm_company_words(v_name) then
        v_candidates := private.crm_company_name_matches(v_value, v_type, p_company_id);
        if jsonb_path_exists(v_candidates, '$[*] ? (@.match == "exact")') then
          return jsonb_build_object('ok', false, 'status', 'duplicate_blocked', 'changed', false,
            'company', private.crm_company_summary(v_type, v_row), 'duplicate_candidates', v_candidates,
            'replayed', false);
        end if;
        if jsonb_array_length(v_candidates) > 0 and not coalesce((v_patch->>'allow_similar_names')::boolean, false) then
          return jsonb_build_object('ok', false, 'status', 'possible_duplicates', 'changed', false,
            'company', private.crm_company_summary(v_type, v_row), 'duplicate_candidates', v_candidates,
            'replayed', false);
        end if;
      end if;
      v_name := v_value;
      v_changed := v_changed || text 'company_name';
    end if;
  end if;

  if v_patch ? 'stage' then
    if v_type = 'lost' then
      raise exception 'Lost records do not have a stage' using errcode = '22023';
    end if;
    v_value := private.crm_canonical_stage(v_patch->>'stage');
    if v_value is null then
      raise exception 'Stage must be one of Unqualified, Prospect, Outreach, Not Interested, Qualified, Proposal, Negotiation, Closed Won, Closed Lost'
        using errcode = '22023';
    end if;
    if v_value is distinct from v_stage then
      v_stage := v_value;
      v_changed := v_changed || text 'stage';
      -- Same as the CRM website: rejected manufacturer stages stop the lead finder
      -- from re-importing the company.
      if v_type = 'manufacturer' and v_stage in ('Not Interested', 'Unqualified', 'Closed Lost')
        and not '__finder_skip' = any(v_tags) then
        v_tags := v_tags || text '__finder_skip';
      end if;
    end if;
  end if;

  if v_patch ? 'industry' then
    if v_type = 'manufacturer' then
      v_value := private.crm_canonical_manufacturer_industry(v_patch->>'industry');
      if v_value is null then
        raise exception 'Manufacturer industry must be one of Food and Beverage, Concrete, Metal Refineries, Recycling, Aggregate / Asphalt, Packaging, Building Products, Others'
          using errcode = '22023';
      end if;
    else
      v_value := btrim(coalesce(v_patch->>'industry', ''));
      if length(v_value) > 200 then
        raise exception 'Industry must contain at most 200 characters' using errcode = '22023';
      end if;
    end if;
    if v_value is distinct from v_industry then
      v_industry := v_value;
      v_changed := v_changed || text 'industry';
    end if;
  end if;

  if v_patch ? 'region' or v_patch ? 'email' or v_patch ? 'phone' then
    if v_type = 'manufacturer' then
      raise exception 'Manufacturers have no region, email, or phone fields; put that information in notes or on a contact'
        using errcode = '22023';
    end if;
    if v_patch ? 'region' then
      v_value := btrim(coalesce(v_patch->>'region', ''));
      if length(v_value) > 200 then
        raise exception 'Region must contain at most 200 characters' using errcode = '22023';
      end if;
      if v_value is distinct from coalesce(v_region, '') then
        v_region := v_value;
        v_changed := v_changed || text 'region';
      end if;
    end if;
    if v_patch ? 'email' then
      v_value := btrim(coalesce(v_patch->>'email', ''));
      if v_value <> '' and (length(v_value) > 320 or v_value !~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$') then
        raise exception 'Email must be a single valid email address' using errcode = '22023';
      end if;
      if v_value is distinct from coalesce(v_email, '') then
        v_email := v_value;
        v_changed := v_changed || text 'email';
      end if;
    end if;
    if v_patch ? 'phone' then
      v_value := btrim(coalesce(v_patch->>'phone', ''));
      if length(v_value) > 50 then
        raise exception 'Phone must contain at most 50 characters' using errcode = '22023';
      end if;
      if v_value is distinct from coalesce(v_phone, '') then
        v_phone := v_value;
        v_changed := v_changed || text 'phone';
      end if;
    end if;
  end if;

  if v_patch ? 'lost_reason' or v_patch ? 'deal_value' then
    if v_type <> 'lost' then
      raise exception 'Only lost records have lost_reason and deal_value' using errcode = '22023';
    end if;
    if v_patch ? 'lost_reason' then
      v_value := btrim(coalesce(v_patch->>'lost_reason', ''));
      if v_value <> '' and v_value not in ('Price', 'Competitor', 'No Budget', 'No Decision', 'Bad Fit', 'Timing', 'Other') then
        raise exception 'Lost reason must be one of Price, Competitor, No Budget, No Decision, Bad Fit, Timing, Other'
          using errcode = '22023';
      end if;
      if v_value is distinct from coalesce(v_lost_reason, '') then
        v_lost_reason := v_value;
        v_changed := v_changed || text 'lost_reason';
      end if;
    end if;
    if v_patch ? 'deal_value' then
      if jsonb_typeof(v_patch->'deal_value') <> 'number' or (v_patch->>'deal_value')::numeric < 0 then
        raise exception 'Deal value must be a non-negative number' using errcode = '22023';
      end if;
      if (v_patch->>'deal_value')::numeric is distinct from v_deal then
        v_deal := (v_patch->>'deal_value')::numeric;
        v_changed := v_changed || text 'deal_value';
      end if;
    end if;
  end if;

  -- Lost records keep one inline person, shown on the CRM website's lost record.
  if v_patch ? 'person_name' or v_patch ? 'person_title' then
    if v_type <> 'lost' then
      raise exception 'person_name and person_title apply to lost records; use the contact tools for manufacturers and vendors'
        using errcode = '22023';
    end if;
    if v_patch ? 'person_name' then
      v_value := btrim(regexp_replace(coalesce(v_patch->>'person_name', ''), '\s+', ' ', 'g'));
      if length(v_value) > 200 then
        raise exception 'Person name must contain at most 200 characters' using errcode = '22023';
      end if;
      if v_value is distinct from coalesce(v_person_name, '') then
        v_person_name := v_value;
        v_changed := v_changed || text 'person_name';
      end if;
    end if;
    if v_patch ? 'person_title' then
      v_value := btrim(regexp_replace(coalesce(v_patch->>'person_title', ''), '\s+', ' ', 'g'));
      if length(v_value) > 200 then
        raise exception 'Person title must contain at most 200 characters' using errcode = '22023';
      end if;
      if v_value is distinct from coalesce(v_person_title, '') then
        v_person_title := v_value;
        v_changed := v_changed || text 'person_title';
      end if;
    end if;
  end if;

  if v_patch ? 'notes_append' then
    v_value := btrim(coalesce(v_patch->>'notes_append', ''));
    if v_value = '' or length(v_value) > 20000 then
      raise exception 'notes_append must contain 1 to 20000 characters' using errcode = '22023';
    end if;
    v_notes := private.crm_notes_append_plain(v_notes, v_value);
    v_changed := v_changed || text 'notes';
  elsif v_patch ? 'notes_replace' then
    if coalesce(v_patch->>'expected_notes_sha256', '') <> private.crm_text_sha256(v_notes) then
      raise exception 'Company notes changed since they were read; read the company profile again before replacing notes'
        using errcode = 'PT409';
    end if;
    if private.crm_notes_has_images(v_notes) then
      raise exception 'These company notes contain pasted images that cannot be reproduced; use notes_append instead of notes_replace'
        using errcode = '22023';
    end if;
    v_value := coalesce(v_patch->>'notes_replace', '');
    if length(v_value) > 20000 then
      raise exception 'notes_replace must contain at most 20000 characters' using errcode = '22023';
    end if;
    if v_value is distinct from coalesce(v_notes, '') then
      v_notes := v_value;
      v_changed := v_changed || text 'notes';
    end if;
  end if;

  if v_patch ? 'add_tags' or v_patch ? 'remove_tags' then
    for v_value in
      select btrim(tag) from jsonb_array_elements_text(coalesce(v_patch->'add_tags', '[]'::jsonb)) as tag
      union all
      select btrim(tag) from jsonb_array_elements_text(coalesce(v_patch->'remove_tags', '[]'::jsonb)) as tag
    loop
      if v_value = '' or length(v_value) > 50 or v_value like '\_\_%' or position(',' in v_value) > 0 then
        raise exception 'Tag "%" is not allowed; tags must be 1 to 50 characters, contain no commas, and must not start with __', v_value
          using errcode = '22023';
      end if;
    end loop;
    for v_value in select btrim(tag) from jsonb_array_elements_text(coalesce(v_patch->'add_tags', '[]'::jsonb)) as tag loop
      if not exists (select 1 from unnest(v_tags) as t where lower(t) = lower(v_value)) then
        v_tags := v_tags || v_value;
        if not 'tags' = any(v_changed) then v_changed := v_changed || text 'tags'; end if;
      end if;
    end loop;
    for v_value in select btrim(tag) from jsonb_array_elements_text(coalesce(v_patch->'remove_tags', '[]'::jsonb)) as tag loop
      if exists (select 1 from unnest(v_tags) as t where lower(t) = lower(v_value)) then
        v_tags := array(select t from unnest(v_tags) as t where lower(t) <> lower(v_value));
        if not 'tags' = any(v_changed) then v_changed := v_changed || text 'tags'; end if;
      end if;
    end loop;
  end if;

  if cardinality(v_changed) > 0 then
    if v_type = 'manufacturer' then
      update public.manufacturers as m
      set company = v_name, stage = v_stage, industry = v_industry, signals = v_notes, tags = v_tags
      where m.id = p_company_id;
    elsif v_type = 'vendor' then
      update public.vendors as v
      set company = v_name, stage = v_stage, industry = v_industry, region = v_region,
        email = v_email, phone = v_phone, notes = v_notes, tags = v_tags
      where v.id = p_company_id;
    else
      update public.lost_contacts as l
      set company = v_name, industry = v_industry, region = v_region, email = v_email,
        phone = v_phone, lost_reason = v_lost_reason, deal_value = v_deal, notes = v_notes, tags = v_tags,
        name = v_person_name, title = v_person_title
      where l.id = p_company_id;
    end if;
  end if;

  if v_patch ? 'add_aliases' then
    for v_alias in select btrim(regexp_replace(a, '\s+', ' ', 'g')) from jsonb_array_elements_text(v_patch->'add_aliases') as a loop
      v_alias_key := replace(private.normalize_crm_company_words(v_alias), ' ', '');
      if length(v_alias) < 2 or length(v_alias) > 300 or length(v_alias_key) < 2 then
        raise exception 'Alias "%" must contain a distinctive 2 to 300 character name', v_alias using errcode = '22023';
      end if;
      if v_alias_key = replace(private.normalize_crm_company_words(v_name), ' ', '') then
        continue;
      end if;
      select candidate into v_alias_conflict
      from jsonb_array_elements(private.crm_company_name_matches(v_alias, v_type, p_company_id)) as candidate
      where candidate->>'match' = 'exact'
      limit 1;
      if v_alias_conflict is not null then
        raise exception 'Alias "%" already names CRM % company % (%)', v_alias,
          v_alias_conflict->>'company_type', v_alias_conflict->>'company_id', v_alias_conflict->>'company_name'
          using errcode = '23505';
      end if;
      insert into public.crm_company_aliases (company_type, company_id, alias, alias_key, created_by)
      values (v_type, p_company_id, v_alias, v_alias_key, v_actor)
      on conflict on constraint crm_company_aliases_unique do nothing;
      if found then
        v_aliases_added := v_aliases_added || v_alias;
      end if;
    end loop;
  end if;
  if v_patch ? 'remove_aliases' then
    for v_alias in select btrim(a) from jsonb_array_elements_text(v_patch->'remove_aliases') as a loop
      delete from public.crm_company_aliases as al
      where al.company_type = v_type
        and al.company_id = p_company_id
        and al.alias_key = replace(private.normalize_crm_company_words(v_alias), ' ', '');
      if found then
        v_aliases_removed := v_aliases_removed || v_alias;
      end if;
    end loop;
  end if;
  if cardinality(v_aliases_added) > 0 or cardinality(v_aliases_removed) > 0 then
    v_changed := v_changed || text 'aliases';
  end if;

  v_after := private.crm_company_row(v_type, p_company_id, false);
  v_result := jsonb_build_object(
    'ok', true,
    'status', case when cardinality(v_changed) = 0 then 'no_change' else 'updated' end,
    'changed', cardinality(v_changed) > 0,
    'changed_fields', to_jsonb(v_changed),
    'company', private.crm_company_summary(v_type, v_after)
      || case when v_type = 'lost' then jsonb_build_object('person_name', v_after->>'name', 'person_title', v_after->>'title') else '{}'::jsonb end,
    'previous', jsonb_build_object('company_name', v_row->>'company', 'stage', v_row->>'stage',
      'industry', v_row->>'industry', 'notes_sha256', private.crm_text_sha256(private.crm_company_notes(v_type, v_row))),
    'notes_sha256', private.crm_text_sha256(private.crm_company_notes(v_type, v_after)),
    'aliases_added', to_jsonb(v_aliases_added),
    'aliases_removed', to_jsonb(v_aliases_removed),
    'similar_names', v_candidates
  );
  return private.mcp_operation_record(v_actor, p_operation_id, 'update_company', v_fingerprint,
    v_type, p_company_id, private.crm_audit_row(v_row - '_type' - '_archived'),
    private.crm_audit_row(v_after), v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.mcp_query_crm_companies(jsonb,text,integer,integer)',
    'public.mcp_crm_pipeline_summary(jsonb,integer,integer,integer)',
    'public.mcp_crm_activity_report(jsonb,integer,integer)',
    'public.mcp_find_crm_tasks(jsonb,integer,integer)',
    'public.mcp_create_crm_lost_record(uuid,jsonb,boolean,text)',
    'public.mcp_update_crm_company(uuid,text,bigint,text,jsonb,text)',
    'public.mcp_preview_crm_bulk_operation(jsonb,jsonb,text,text)',
    'public.mcp_apply_crm_bulk_operation(uuid,uuid,boolean,text)',
    'public.mcp_export_crm_companies(text,jsonb,integer)',
    'public.mcp_preview_crm_import(text,jsonb,jsonb,text,text)',
    'public.mcp_apply_crm_import(uuid,uuid,boolean,text)',
    'public.mcp_get_lead_finder_status()',
    'public.mcp_queue_lead_finder_command(uuid,text,jsonb,jsonb,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$grants$;
