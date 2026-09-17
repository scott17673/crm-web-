-- EDI CRM MCP v8: purpose-built, typed, idempotent, audited CRM write tools.
-- Nothing here grants arbitrary table access to ChatGPT; every public mcp_*
-- function validates exact typed company references and is executable only by
-- service_role (the MCP server). save_crm_company_notes is the one exception:
-- it is a conflict-aware replacement for a table write the CRM website already
-- performs with its anon key.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Ledgers and archives
-- ---------------------------------------------------------------------------

create table if not exists private.mcp_crm_write_operations (
  actor text not null,
  operation_id uuid not null,
  action text not null,
  request_fingerprint text not null,
  target_type text,
  target_id bigint,
  status text not null default 'applied',
  before_values jsonb,
  after_values jsonb,
  result jsonb not null,
  created_at timestamp with time zone not null default now(),
  primary key (actor, operation_id)
);

create index if not exists mcp_crm_write_operations_target_idx
  on private.mcp_crm_write_operations (action, target_type, target_id, created_at desc);

create table if not exists private.mcp_crm_write_failures (
  id bigint generated always as identity primary key,
  actor text,
  operation_id uuid,
  tool text not null,
  error_code text,
  error_message text not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists private.crm_archived_contacts (
  archive_id bigint generated always as identity primary key,
  contact_table text not null,
  contact_id bigint not null,
  company_type text not null,
  company_id bigint not null,
  company_name text,
  row_data jsonb not null,
  reason text not null,
  archived_by text not null,
  archive_operation_id uuid,
  archived_at timestamp with time zone not null default now(),
  restored_at timestamp with time zone,
  restored_by text,
  restore_operation_id uuid,
  constraint crm_archived_contacts_table_check
    check (contact_table in ('manufacturer_contacts', 'vendor_contacts'))
);

create index if not exists crm_archived_contacts_contact_idx
  on private.crm_archived_contacts (contact_table, contact_id, archived_at desc);
create index if not exists crm_archived_contacts_company_idx
  on private.crm_archived_contacts (company_type, company_id);

create table if not exists private.crm_archived_activities (
  archive_id bigint generated always as identity primary key,
  activity_id bigint not null,
  is_task boolean not null,
  company_type text not null,
  company_id bigint not null,
  row_data jsonb not null,
  reason text not null,
  archived_by text not null,
  archive_operation_id uuid,
  archived_at timestamp with time zone not null default now(),
  restored_at timestamp with time zone,
  restored_by text,
  restore_operation_id uuid
);

create index if not exists crm_archived_activities_activity_idx
  on private.crm_archived_activities (activity_id, archived_at desc);
create index if not exists crm_archived_activities_company_idx
  on private.crm_archived_activities (company_type, company_id);

create table if not exists private.crm_activity_revisions (
  revision_id bigint generated always as identity primary key,
  activity_id bigint not null,
  operation_id uuid,
  changed_by text not null,
  before_values jsonb not null,
  after_values jsonb not null,
  changed_at timestamp with time zone not null default now()
);

create index if not exists crm_activity_revisions_activity_idx
  on private.crm_activity_revisions (activity_id, changed_at desc);

create table if not exists private.crm_merge_previews (
  merge_token uuid primary key default gen_random_uuid(),
  actor text not null,
  source_type text not null,
  source_id bigint not null,
  source_name text not null,
  destination_type text not null,
  destination_id bigint,
  destination_name text,
  allow_cross_type boolean not null,
  fingerprint text not null,
  plan jsonb not null,
  created_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  consumed_at timestamp with time zone,
  consumed_operation_id uuid
);

create table if not exists public.crm_company_aliases (
  id bigint generated always as identity primary key,
  company_type text not null,
  company_id bigint not null,
  alias text not null,
  alias_key text not null,
  created_by text not null,
  created_at timestamp with time zone not null default now(),
  constraint crm_company_aliases_company_type_check
    check (company_type in ('manufacturer', 'vendor', 'lost')),
  constraint crm_company_aliases_unique unique (company_type, company_id, alias_key)
);

create index if not exists crm_company_aliases_key_idx
  on public.crm_company_aliases (alias_key);

alter table private.mcp_crm_write_operations enable row level security;
alter table private.mcp_crm_write_failures enable row level security;
alter table private.crm_archived_contacts enable row level security;
alter table private.crm_archived_activities enable row level security;
alter table private.crm_activity_revisions enable row level security;
alter table private.crm_merge_previews enable row level security;
alter table public.crm_company_aliases enable row level security;

revoke all on table private.mcp_crm_write_operations from public, anon, authenticated;
revoke all on table private.mcp_crm_write_failures from public, anon, authenticated;
revoke all on table private.crm_archived_contacts from public, anon, authenticated;
revoke all on table private.crm_archived_activities from public, anon, authenticated;
revoke all on table private.crm_activity_revisions from public, anon, authenticated;
revoke all on table private.crm_merge_previews from public, anon, authenticated;
revoke all on table public.crm_company_aliases from public, anon, authenticated;

grant usage on schema private to service_role;
grant select, insert, update on table private.mcp_crm_write_operations to service_role;
grant select, insert on table private.mcp_crm_write_failures to service_role;
grant select, insert, update on table private.crm_archived_contacts to service_role;
grant select, insert, update on table private.crm_archived_activities to service_role;
grant select, insert on table private.crm_activity_revisions to service_role;
grant select, insert, update on table private.crm_merge_previews to service_role;
grant select, insert, update, delete on table public.crm_company_aliases to service_role;

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

create or replace function private.mcp_require_actor(p_actor text)
returns text
language plpgsql
stable
set search_path = ''
as $function$
begin
  if btrim(coalesce(p_actor, '')) <> 'github|264040869' then
    raise exception 'OAuth principal is not authorized for CRM writes'
      using errcode = '42501';
  end if;
  return btrim(p_actor);
end;
$function$;

-- Returns the stored result when this exact operation already ran, or null when
-- the caller should perform it. The advisory lock serializes concurrent retries.
create or replace function private.mcp_operation_replay(
  p_actor text,
  p_operation_id uuid,
  p_action text,
  p_fingerprint text
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_operation private.mcp_crm_write_operations%rowtype;
begin
  if p_operation_id is null then
    raise exception 'Operation id is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('edi_crm_mcp_operation:' || p_operation_id::text));
  select operation.*
  into v_operation
  from private.mcp_crm_write_operations as operation
  where operation.actor = p_actor
    and operation.operation_id = p_operation_id;
  if not found then
    return null;
  end if;
  if v_operation.action <> p_action or v_operation.request_fingerprint <> p_fingerprint then
    raise exception 'Operation id was already used for a different CRM request'
      using errcode = '22023';
  end if;
  return v_operation.result || jsonb_build_object('replayed', true);
end;
$function$;

create or replace function private.mcp_operation_record(
  p_actor text,
  p_operation_id uuid,
  p_action text,
  p_fingerprint text,
  p_target_type text,
  p_target_id bigint,
  p_before jsonb,
  p_after jsonb,
  p_result jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
begin
  insert into private.mcp_crm_write_operations (
    actor, operation_id, action, request_fingerprint, target_type, target_id,
    before_values, after_values, result
  ) values (
    p_actor, p_operation_id, p_action, p_fingerprint, p_target_type, p_target_id,
    p_before, p_after, p_result
  );
  return p_result || jsonb_build_object('replayed', false);
end;
$function$;

create or replace function private.crm_toronto_today()
returns date
language sql
stable
set search_path = ''
as $function$
  select (now() at time zone 'America/Toronto')::date;
$function$;

create or replace function private.crm_text_sha256(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select encode(sha256(convert_to(coalesce(p_value, ''), 'UTF8')), 'hex');
$function$;

-- Large notes (pasted images are stored inline) are summarized in audit rows.
create or replace function private.crm_audit_text(p_value text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_value is null then 'null'::jsonb
    when length(p_value) <= 20000 then to_jsonb(p_value)
    else jsonb_build_object('sha256', private.crm_text_sha256(p_value), 'length', length(p_value))
  end;
$function$;

create or replace function private.crm_audit_row(p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case when p_row is null then null else
    p_row
    || case when p_row ? 'signals' then jsonb_build_object('signals', private.crm_audit_text(p_row->>'signals')) else '{}'::jsonb end
    || case when p_row ? 'notes' then jsonb_build_object('notes', private.crm_audit_text(p_row->>'notes')) else '{}'::jsonb end
    || case when p_row ? 'note' then jsonb_build_object('note', private.crm_audit_text(p_row->>'note')) else '{}'::jsonb end
  end;
$function$;

create or replace function private.crm_notes_is_html(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(p_value, '') ~* '<[a-z].*>';
$function$;

create or replace function private.crm_notes_has_images(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(p_value, '') ~* '(<img|data:image/)';
$function$;

create or replace function private.crm_notes_to_html(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when private.crm_notes_is_html(p_value) then coalesce(p_value, '')
    else replace(
      replace(replace(replace(replace(coalesce(p_value, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\r\n', E'\n'),
      E'\n', '<br>'
    )
  end;
$function$;

-- Appends plain text in the same format the CRM website renders: HTML notes get
-- escaped text with <br> line breaks, plain notes get a blank-line separator.
create or replace function private.crm_notes_append_plain(p_existing text, p_addition text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when btrim(coalesce(p_addition, '')) = '' then coalesce(p_existing, '')
    when btrim(coalesce(p_existing, '')) = '' then btrim(p_addition)
    when private.crm_notes_is_html(p_existing) then
      p_existing || '<br><br>' || replace(
        replace(replace(replace(replace(btrim(p_addition), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\r\n', E'\n'),
        E'\n', '<br>'
      )
    else p_existing || E'\n\n' || btrim(p_addition)
  end;
$function$;

-- Appends notes that may themselves be HTML (used by merges).
create or replace function private.crm_notes_append_notes(p_existing text, p_addition text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when btrim(coalesce(p_addition, '')) = '' then coalesce(p_existing, '')
    when btrim(coalesce(p_existing, '')) = '' then p_addition
    when private.crm_notes_is_html(p_existing) or private.crm_notes_is_html(p_addition) then
      private.crm_notes_to_html(p_existing) || '<br><br>' || private.crm_notes_to_html(p_addition)
    else p_existing || E'\n\n' || p_addition
  end;
$function$;

create or replace function private.crm_canonical_stage(p_stage text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case lower(btrim(coalesce(p_stage, '')))
    when 'unqualified' then 'Unqualified'
    when 'prospect' then 'Prospect'
    when 'outreach' then 'Outreach'
    when 'not interested' then 'Not Interested'
    when 'qualified' then 'Qualified'
    when 'proposal' then 'Proposal'
    when 'negotiation' then 'Negotiation'
    when 'closed won' then 'Closed Won'
    when 'closed lost' then 'Closed Lost'
    else null
  end;
$function$;

create or replace function private.crm_canonical_manufacturer_industry(p_industry text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case lower(btrim(coalesce(p_industry, '')))
    when '' then ''
    when 'others' then ''
    when 'food and beverage' then 'Food and Beverage'
    when 'concrete' then 'Concrete'
    when 'metal refineries' then 'Metal Refineries'
    when 'recycling' then 'Recycling'
    when 'aggregate / asphalt' then 'Aggregate / Asphalt'
    when 'packaging' then 'Packaging'
    when 'building products' then 'Building Products'
    else null
  end;
$function$;

create or replace function private.crm_task_marker(p_created_by text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when btrim(coalesce(p_created_by, '')) = '__task_open__' then '{"state":"open","owner":"Scott"}'::jsonb
    when btrim(coalesce(p_created_by, '')) = '__task_done__' then '{"state":"done","owner":"Scott"}'::jsonb
    when btrim(coalesce(p_created_by, '')) like '\_\_task\_\_|%' then jsonb_build_object(
      'state', case when split_part(btrim(p_created_by), '|', 2) = 'done' then 'done' else 'open' end,
      'owner', case when split_part(btrim(p_created_by), '|', 3) = 'Jeff' then 'Jeff' else 'Scott' end
    )
    else null
  end;
$function$;

create or replace function private.crm_company_row(p_company_type text, p_company_id bigint, p_lock boolean)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_row jsonb;
begin
  if p_company_type = 'manufacturer' then
    if p_lock then
      select to_jsonb(m) into v_row from public.manufacturers as m where m.id = p_company_id for update;
    else
      select to_jsonb(m) into v_row from public.manufacturers as m where m.id = p_company_id;
    end if;
  elsif p_company_type = 'vendor' then
    if p_lock then
      select to_jsonb(v) into v_row from public.vendors as v where v.id = p_company_id for update;
    else
      select to_jsonb(v) into v_row from public.vendors as v where v.id = p_company_id;
    end if;
  elsif p_company_type = 'lost' then
    if p_lock then
      select to_jsonb(l) into v_row from public.lost_contacts as l where l.id = p_company_id for update;
    else
      select to_jsonb(l) into v_row from public.lost_contacts as l where l.id = p_company_id;
    end if;
  end if;
  return v_row;
end;
$function$;

create or replace function private.crm_row_archived(p_row jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(jsonb_typeof(p_row->'tags') = 'array' and (p_row->'tags') ? '__deleted', false);
$function$;

create or replace function private.crm_company_notes(p_company_type text, p_row jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case when p_company_type = 'manufacturer' then p_row->>'signals' else p_row->>'notes' end;
$function$;

-- Locks and verifies one exact typed company. A manufacturer id is only ever
-- resolved against manufacturers, a vendor id against vendors, and so on.
create or replace function private.crm_lock_company(
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_type text := lower(btrim(coalesce(p_company_type, '')));
  v_row jsonb;
begin
  if p_company_id is null or p_company_id <= 0 then
    raise exception 'Company id must be a positive integer' using errcode = '22023';
  end if;
  if v_type not in ('manufacturer', 'vendor', 'lost') then
    raise exception 'Company type must be manufacturer, vendor, or lost' using errcode = '22023';
  end if;
  if btrim(coalesce(p_expected_company_name, '')) = '' then
    raise exception 'Expected company name is required' using errcode = '22023';
  end if;
  v_row := private.crm_company_row(v_type, p_company_id, true);
  if v_row is null then
    raise exception 'CRM % company % does not exist', v_type, p_company_id using errcode = '23503';
  end if;
  if lower(btrim(v_row->>'company')) <> lower(btrim(p_expected_company_name)) then
    raise exception 'Company name mismatch for CRM % company %', v_type, p_company_id
      using errcode = '22023';
  end if;
  return v_row || jsonb_build_object('_type', v_type, '_archived', private.crm_row_archived(v_row));
end;
$function$;

create or replace function private.crm_company_summary(p_company_type text, p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case when p_row is null then null else jsonb_build_object(
    'company_id', (p_row->>'id')::bigint,
    'company_type', p_company_type,
    'company_name', p_row->>'company',
    'stage', p_row->>'stage',
    'industry', nullif(p_row->>'industry', ''),
    'region', p_row->>'region',
    'email', p_row->>'email',
    'phone', p_row->>'phone',
    'lost_reason', p_row->>'lost_reason',
    'deal_value', p_row->'deal_value',
    'tags', (
      select coalesce(jsonb_agg(tag), '[]'::jsonb)
      from jsonb_array_elements_text(
        case when jsonb_typeof(p_row->'tags') = 'array' then p_row->'tags' else '[]'::jsonb end
      ) as tag
      where tag not like '\_\_%'
    ),
    'archived', private.crm_row_archived(p_row),
    'last_contact', p_row->>'last_contact'
  ) end;
$function$;

create or replace function private.crm_validate_contact_fields(p_name text, p_title text)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if length(coalesce(p_name, '')) < 2 or length(p_name) > 200 then
    raise exception 'Contact name must contain 2 to 200 characters' using errcode = '22023';
  end if;
  if length(coalesce(p_title, '')) > 200 then
    raise exception 'Contact title must contain at most 200 characters' using errcode = '22023';
  end if;
  -- The CRM website edits contacts as "Name, Title, LinkedIn" lines.
  if position(',' in p_name) > 0 or position(',' in coalesce(p_title, '')) > 0 then
    raise exception 'Contact name and title must not contain commas; use " - " instead'
      using errcode = '22023';
  end if;
  if length(replace(private.normalize_crm_person_name(p_name), ' ', '')) < 2 then
    raise exception 'Contact name must contain letters or digits' using errcode = '22023';
  end if;
end;
$function$;

-- Returns the first conflicting contact, or null.
create or replace function private.crm_contact_conflict(
  p_company_type text,
  p_company_id bigint,
  p_name text,
  p_linkedin text,
  p_exclude_table text,
  p_exclude_id bigint,
  p_check_name boolean,
  p_check_linkedin boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_conflict jsonb;
  v_key text := private.normalize_crm_person_name(p_name);
begin
  if p_check_linkedin and coalesce(p_linkedin, '') <> '' then
    select jsonb_build_object(
      'reason', 'linkedin_url_already_in_crm',
      'contact_id', found_contact.id,
      'contact_name', found_contact.name,
      'company_id', found_contact.company_id,
      'company_type', found_contact.company_type,
      'company_name', found_contact.company
    )
    into v_conflict
    from (
      select mc.id, mc.name, mc.manufacturer_id as company_id, 'manufacturer'::text as company_type,
        m.company, mc.linkedin, 'manufacturer_contacts'::text as contact_table
      from public.manufacturer_contacts as mc
      left join public.manufacturers as m on m.id = mc.manufacturer_id
      where coalesce(mc.linkedin, '') ilike '%linkedin.com/in/%'
      union all
      select vc.id, vc.name, vc.vendor_id, 'vendor'::text, v.company, vc.linkedin, 'vendor_contacts'::text
      from public.vendor_contacts as vc
      left join public.vendors as v on v.id = vc.vendor_id
      where coalesce(vc.linkedin, '') ilike '%linkedin.com/in/%'
    ) as found_contact
    where private.normalize_linkedin_profile_url(found_contact.linkedin) = p_linkedin
      and not (found_contact.contact_table = coalesce(p_exclude_table, '') and found_contact.id = coalesce(p_exclude_id, -1))
    order by found_contact.id
    limit 1;
    if v_conflict is not null then
      return v_conflict;
    end if;
  end if;

  if p_check_name then
    if p_company_type = 'manufacturer' then
      select jsonb_build_object('reason', 'same_name_at_company', 'contact_id', mc.id,
        'contact_name', mc.name, 'contact_title', mc.title)
      into v_conflict
      from public.manufacturer_contacts as mc
      where mc.manufacturer_id = p_company_id
        and private.normalize_crm_person_name(mc.name) = v_key
        and not ('manufacturer_contacts' = coalesce(p_exclude_table, '') and mc.id = coalesce(p_exclude_id, -1))
      order by mc.id
      limit 1;
    elsif p_company_type = 'vendor' then
      select jsonb_build_object('reason', 'same_name_at_company', 'contact_id', vc.id,
        'contact_name', vc.name, 'contact_title', vc.title)
      into v_conflict
      from public.vendor_contacts as vc
      where vc.vendor_id = p_company_id
        and private.normalize_crm_person_name(vc.name) = v_key
        and not ('vendor_contacts' = coalesce(p_exclude_table, '') and vc.id = coalesce(p_exclude_id, -1))
      order by vc.id
      limit 1;
    end if;
  end if;
  return v_conflict;
end;
$function$;

-- Exact and similar company-name matches across manufacturers, vendors, lost
-- records, and aliases, excluding one company (for renames).
create or replace function private.crm_company_name_matches(
  p_name text,
  p_exclude_type text,
  p_exclude_id bigint
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_words text := private.normalize_crm_company_words(p_name);
  v_key text := replace(v_words, ' ', '');
  v_first_two text := substring(v_words from '^([a-z0-9]+ [a-z0-9]+)');
  v_result jsonb;
begin
  if length(v_key) < 2 then
    return '[]'::jsonb;
  end if;
  with names as (
    select m.id, 'manufacturer'::text as type, m.company, coalesce('__deleted' = any(m.tags), false) as hidden,
      m.company as matched_text, null::text as via_alias
    from public.manufacturers as m
    union all
    select v.id, 'vendor'::text, v.company, coalesce('__deleted' = any(v.tags), false), v.company, null::text
    from public.vendors as v
    union all
    select l.id, 'lost'::text, l.company, coalesce('__deleted' = any(l.tags), false), l.company, null::text
    from public.lost_contacts as l
    union all
    select a.company_id, a.company_type, company_row.company, company_row.hidden, a.alias, a.alias
    from public.crm_company_aliases as a
    join lateral (
      select m.company, coalesce('__deleted' = any(m.tags), false) as hidden
      from public.manufacturers as m where a.company_type = 'manufacturer' and m.id = a.company_id
      union all
      select v.company, coalesce('__deleted' = any(v.tags), false)
      from public.vendors as v where a.company_type = 'vendor' and v.id = a.company_id
      union all
      select l.company, coalesce('__deleted' = any(l.tags), false)
      from public.lost_contacts as l where a.company_type = 'lost' and l.id = a.company_id
    ) as company_row on true
  ),
  normalized as (
    select n.*, private.normalize_crm_company_words(n.matched_text) as words
    from names as n
    where not (n.type = coalesce(p_exclude_type, '') and n.id = coalesce(p_exclude_id, -1))
  ),
  matches as (
    select
      n.id, n.type, n.company, n.hidden, n.via_alias,
      case when replace(n.words, ' ', '') = v_key then 'exact' else 'similar' end as match
    from normalized as n
    where replace(n.words, ' ', '') = v_key
      or (
        least(length(replace(n.words, ' ', '')), length(v_key)) >= 4
        and replace(n.words, ' ', '') <> ''
        and (
          position(replace(n.words, ' ', '') in v_key) > 0
          or position(v_key in replace(n.words, ' ', '')) > 0
        )
      )
      or (
        v_first_two is not null
        and substring(n.words from '^([a-z0-9]+ [a-z0-9]+)') = v_first_two
      )
  ),
  best as (
    select distinct on (m.type, m.id) m.*
    from matches as m
    order by m.type, m.id, m.match, m.via_alias nulls first
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'company_id', ranked.id,
    'company_type', ranked.type,
    'company_name', ranked.company,
    'match', ranked.match,
    'hidden', ranked.hidden,
    'via_alias', ranked.via_alias
  ) order by ranked.match, ranked.company), '[]'::jsonb)
  into v_result
  from (select * from best order by match, company limit 25) as ranked;
  return v_result;
end;
$function$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

-- ---------------------------------------------------------------------------
-- create_crm_company (v7 signature) now also treats aliases as names.
-- ---------------------------------------------------------------------------

create or replace function public.create_crm_company(
  p_operation_id uuid,
  p_company_type text,
  p_company_name text,
  p_industry text,
  p_region text,
  p_website text,
  p_notes text,
  p_stage text,
  p_allow_similar_names boolean,
  p_actor text
)
returns table (
  status text,
  created boolean,
  company_id bigint,
  company_type text,
  company_name text,
  candidates jsonb
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_company_type text := lower(btrim(coalesce(p_company_type, '')));
  v_company_name text := btrim(regexp_replace(coalesce(p_company_name, ''), '\s+', ' ', 'g'));
  v_key text;
  v_industry text := btrim(coalesce(p_industry, ''));
  v_region text := btrim(coalesce(p_region, ''));
  v_website text := btrim(coalesce(p_website, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
  v_stage text;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_fingerprint text;
  v_existing private.mcp_crm_company_operations%rowtype;
  v_candidates jsonb;
  v_company_id bigint;
  v_company_notes text;
  v_today date := private.crm_toronto_today();
begin
  if p_operation_id is null then
    raise exception 'Operation id is required' using errcode = '22023';
  end if;
  if v_actor <> 'github|264040869' then
    raise exception 'OAuth principal is not authorized to create CRM companies'
      using errcode = '42501';
  end if;
  if v_company_type not in ('manufacturer', 'vendor') then
    raise exception 'Company type must be manufacturer or vendor' using errcode = '22023';
  end if;
  if length(v_company_name) < 2 or length(v_company_name) > 300 then
    raise exception 'Company name must contain 2 to 300 characters' using errcode = '22023';
  end if;
  v_key := replace(private.normalize_crm_company_words(v_company_name), ' ', '');
  if length(v_key) < 2 then
    raise exception 'Company name must contain a distinctive name, not only a legal suffix'
      using errcode = '22023';
  end if;

  v_stage := case when btrim(coalesce(p_stage, '')) = '' then 'Prospect' else private.crm_canonical_stage(p_stage) end;
  if v_stage is null then
    raise exception 'Stage must be one of Unqualified, Prospect, Outreach, Not Interested, Qualified, Proposal, Negotiation, Closed Won, Closed Lost'
      using errcode = '22023';
  end if;
  if v_company_type = 'manufacturer' then
    v_industry := private.crm_canonical_manufacturer_industry(v_industry);
    if v_industry is null then
      raise exception 'Manufacturer industry must be one of Food and Beverage, Concrete, Metal Refineries, Recycling, Aggregate / Asphalt, Packaging, Building Products, Others'
        using errcode = '22023';
    end if;
  elsif length(v_industry) > 200 then
    raise exception 'Industry must contain at most 200 characters' using errcode = '22023';
  end if;
  if length(v_region) > 200 then
    raise exception 'Region must contain at most 200 characters' using errcode = '22023';
  end if;
  if length(v_website) > 500 or v_website ~ '\s' then
    raise exception 'Website must be a single URL of at most 500 characters' using errcode = '22023';
  end if;
  if length(v_notes) > 20000 then
    raise exception 'Notes must contain at most 20000 characters' using errcode = '22023';
  end if;

  v_fingerprint := md5(jsonb_build_object(
    'company_type', v_company_type,
    'company_name', v_company_name,
    'industry', v_industry,
    'region', v_region,
    'website', v_website,
    'notes', v_notes,
    'stage', v_stage
  )::text);

  perform pg_advisory_xact_lock(hashtext('edi_crm_mcp_create_company'));

  select operation.*
  into v_existing
  from private.mcp_crm_company_operations as operation
  where operation.actor = v_actor
    and operation.operation_id = p_operation_id;

  if found then
    if v_existing.request_fingerprint <> v_fingerprint then
      raise exception 'Operation id was already used for a different CRM company request'
        using errcode = '22023';
    end if;
    if v_existing.company_id is null then
      raise exception 'Operation is still being recorded; retry the same operation id'
        using errcode = 'PT409';
    end if;
    return query
    select 'already_created'::text, false, v_existing.company_id, v_existing.company_type,
      v_existing.company_name, '[]'::jsonb;
    return;
  end if;

  v_candidates := private.crm_company_name_matches(v_company_name, null, null);

  if jsonb_path_exists(v_candidates, '$[*] ? (@.match == "exact")') then
    return query
    select 'duplicate_blocked'::text, false, null::bigint, v_company_type, v_company_name, v_candidates;
    return;
  end if;
  if jsonb_array_length(v_candidates) > 0 and not coalesce(p_allow_similar_names, false) then
    return query
    select 'possible_duplicates'::text, false, null::bigint, v_company_type, v_company_name, v_candidates;
    return;
  end if;

  insert into private.mcp_crm_company_operations (
    actor, operation_id, company_type, company_name, request_fingerprint
  ) values (
    v_actor, p_operation_id, v_company_type, v_company_name, v_fingerprint
  );

  if v_company_type = 'manufacturer' then
    v_company_notes := concat_ws(
      E'\n\n',
      nullif(v_notes, ''),
      nullif(concat_ws(E'\n', 'Website: ' || nullif(v_website, ''), 'Region: ' || nullif(v_region, '')), '')
    );
    insert into public.manufacturers (company, stage, industry, signals, tags, last_contact)
    values (v_company_name, v_stage, v_industry, coalesce(v_company_notes, ''), '{}'::text[], v_today)
    returning id into v_company_id;
  else
    v_company_notes := concat_ws(E'\n\n', nullif(v_notes, ''), 'Website: ' || nullif(v_website, ''));
    insert into public.vendors (company, industry, region, stage, tags, notes, last_contact)
    values (v_company_name, v_industry, v_region, v_stage, '{}'::text[], coalesce(v_company_notes, ''), v_today)
    returning id into v_company_id;
  end if;

  update private.mcp_crm_company_operations as operation
  set company_id = v_company_id
  where operation.actor = v_actor
    and operation.operation_id = p_operation_id;

  return query
  select 'created'::text, true, v_company_id, v_company_type, v_company_name, v_candidates;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Companies
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
    'remove_tags', 'add_aliases', 'remove_aliases', 'allow_similar_names'
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
        phone = v_phone, lost_reason = v_lost_reason, deal_value = v_deal, notes = v_notes, tags = v_tags
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
    'company', private.crm_company_summary(v_type, v_after),
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

create or replace function public.mcp_set_crm_company_archived(
  p_operation_id uuid,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_archived boolean,
  p_reason text,
  p_restore_stage text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_action text := case when p_archived then 'archive_company' else 'restore_company' end;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fingerprint text;
  v_replay jsonb;
  v_row jsonb;
  v_type text;
  v_tags text[];
  v_stage text;
  v_previous jsonb;
  v_status text;
  v_after jsonb;
  v_result jsonb;
  v_open_tasks integer;
  v_restore_stage text;
begin
  if p_archived is null then
    raise exception 'Archive flag is required' using errcode = '22023';
  end if;
  if p_archived and (length(v_reason) < 3 or length(v_reason) > 500) then
    raise exception 'An archive reason of 3 to 500 characters is required' using errcode = '22023';
  end if;
  if btrim(coalesce(p_restore_stage, '')) <> '' then
    v_restore_stage := private.crm_canonical_stage(p_restore_stage);
    if v_restore_stage is null then
      raise exception 'Restore stage must be a valid CRM stage' using errcode = '22023';
    end if;
  end if;

  v_fingerprint := md5(jsonb_build_object(
    'type', lower(btrim(coalesce(p_company_type, ''))), 'id', p_company_id,
    'expected', lower(btrim(coalesce(p_expected_company_name, ''))), 'archived', p_archived,
    'reason', v_reason, 'restore_stage', v_restore_stage
  )::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, v_action, v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_row := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);
  v_type := v_row->>'_type';
  v_tags := coalesce(array(select jsonb_array_elements_text(
    case when jsonb_typeof(v_row->'tags') = 'array' then v_row->'tags' else '[]'::jsonb end)), '{}');
  v_stage := v_row->>'stage';

  select count(*) into v_open_tasks
  from public.activities as a
  where a.contact_type = v_type and a.contact_id = p_company_id
    and private.crm_task_marker(a.created_by)->>'state' = 'open';

  if p_archived then
    if (v_row->>'_archived')::boolean then
      v_status := 'already_archived';
    else
      v_status := 'archived';
      v_tags := v_tags || text '__deleted';
      if v_type = 'manufacturer' then
        -- Same soft-delete the CRM website's Delete button applies to manufacturers.
        if not '__finder_skip' = any(v_tags) then
          v_tags := v_tags || text '__finder_skip';
        end if;
        update public.manufacturers as m set tags = v_tags, stage = 'Closed Lost' where m.id = p_company_id;
      elsif v_type = 'vendor' then
        update public.vendors as v set tags = v_tags where v.id = p_company_id;
      else
        update public.lost_contacts as l set tags = v_tags where l.id = p_company_id;
      end if;
    end if;
  else
    if not (v_row->>'_archived')::boolean then
      v_status := 'not_archived';
    else
      v_status := 'restored';
      select operation.before_values
      into v_previous
      from private.mcp_crm_write_operations as operation
      where operation.action = 'archive_company'
        and operation.target_type = v_type
        and operation.target_id = p_company_id
      order by operation.created_at desc
      limit 1;

      v_tags := array(select t from unnest(v_tags) as t where t <> '__deleted');
      if v_previous is not null and not coalesce((v_previous->'tags') ? '__finder_skip', false) then
        v_tags := array(select t from unnest(v_tags) as t where t <> '__finder_skip');
      end if;
      if v_restore_stage is not null then
        v_stage := v_restore_stage;
      elsif v_previous is not null and v_stage = 'Closed Lost' and v_previous ? 'stage' then
        v_stage := v_previous->>'stage';
      end if;

      if v_type = 'manufacturer' then
        update public.manufacturers as m set tags = v_tags, stage = v_stage where m.id = p_company_id;
      elsif v_type = 'vendor' then
        update public.vendors as v set tags = v_tags, stage = v_stage where v.id = p_company_id;
      else
        update public.lost_contacts as l set tags = v_tags where l.id = p_company_id;
      end if;
    end if;
  end if;

  v_after := private.crm_company_row(v_type, p_company_id, false);
  v_result := jsonb_build_object(
    'ok', true,
    'status', v_status,
    'changed', v_status in ('archived', 'restored'),
    'company', private.crm_company_summary(v_type, v_after),
    'previous', jsonb_build_object('stage', v_row->>'stage', 'archived', (v_row->>'_archived')::boolean),
    'open_task_count', v_open_tasks,
    'duplicate_warnings', case when v_status = 'restored' then (
      select coalesce(jsonb_agg(c), '[]'::jsonb)
      from jsonb_array_elements(private.crm_company_name_matches(v_after->>'company', v_type, p_company_id)) as c
      where c->>'match' = 'exact' and not (c->>'hidden')::boolean
    ) else '[]'::jsonb end,
    'reason', nullif(v_reason, '')
  );
  return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
    v_type, p_company_id,
    jsonb_build_object('stage', v_row->>'stage', 'tags', v_row->'tags'),
    jsonb_build_object('stage', v_after->>'stage', 'tags', v_after->'tags'),
    v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------

create or replace function private.crm_contact_summary(p_contact jsonb, p_contact_table text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select jsonb_build_object(
    'contact_id', (p_contact->>'id')::bigint,
    'name', p_contact->>'name',
    'title', nullif(p_contact->>'title', ''),
    'linkedin_url', nullif(p_contact->>'linkedin', ''),
    'contact_table', p_contact_table
  );
$function$;

create or replace function private.crm_lock_contact(
  p_company_type text,
  p_company_id bigint,
  p_contact_id bigint,
  p_expected_contact_name text
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_contact jsonb;
begin
  if p_contact_id is null or p_contact_id <= 0 then
    raise exception 'Contact id must be a positive integer' using errcode = '22023';
  end if;
  if p_company_type = 'manufacturer' then
    select to_jsonb(c) into v_contact from public.manufacturer_contacts as c
    where c.id = p_contact_id and c.manufacturer_id = p_company_id for update;
  elsif p_company_type = 'vendor' then
    select to_jsonb(c) into v_contact from public.vendor_contacts as c
    where c.id = p_contact_id and c.vendor_id = p_company_id for update;
  else
    raise exception 'Lost records keep a single inline person and have no contact rows' using errcode = '22023';
  end if;
  if v_contact is null then
    raise exception 'Contact % is not attached to CRM % company %', p_contact_id, p_company_type, p_company_id
      using errcode = '23503';
  end if;
  if lower(btrim(coalesce(v_contact->>'name', ''))) <> lower(btrim(coalesce(p_expected_contact_name, ''))) then
    raise exception 'Contact name mismatch for contact %', p_contact_id using errcode = '22023';
  end if;
  return v_contact;
end;
$function$;

create or replace function public.mcp_update_crm_contact(
  p_operation_id uuid,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_contact_id bigint,
  p_expected_contact_name text,
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
  v_field text;
  v_fingerprint text;
  v_replay jsonb;
  v_company jsonb;
  v_type text;
  v_table text;
  v_contact jsonb;
  v_name text;
  v_title text;
  v_linkedin text;
  v_changed text[] := '{}';
  v_conflict jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'Update fields must be an object' using errcode = '22023';
  end if;
  for v_field in select jsonb_object_keys(v_patch) loop
    if v_field not in ('name', 'title', 'linkedin_url') then
      raise exception 'Field % cannot be updated through this tool', v_field using errcode = '22023';
    end if;
  end loop;
  if v_patch = '{}'::jsonb then
    raise exception 'Provide at least one field to update' using errcode = '22023';
  end if;

  v_fingerprint := md5(jsonb_build_object('type', lower(btrim(coalesce(p_company_type, ''))),
    'id', p_company_id, 'expected', lower(btrim(coalesce(p_expected_company_name, ''))),
    'contact_id', p_contact_id, 'expected_contact', lower(btrim(coalesce(p_expected_contact_name, ''))),
    'patch', v_patch)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'update_contact', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_company := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);
  v_type := v_company->>'_type';
  v_contact := private.crm_lock_contact(v_type, p_company_id, p_contact_id, p_expected_contact_name);
  v_table := case when v_type = 'manufacturer' then 'manufacturer_contacts' else 'vendor_contacts' end;

  v_name := v_contact->>'name';
  v_title := coalesce(v_contact->>'title', '');
  v_linkedin := coalesce(v_contact->>'linkedin', '');

  if v_patch ? 'name' then
    v_field := btrim(regexp_replace(coalesce(v_patch->>'name', ''), '\s+', ' ', 'g'));
    if v_field is distinct from v_name then
      v_name := v_field;
      v_changed := v_changed || text 'name';
    end if;
  end if;
  if v_patch ? 'title' then
    v_field := btrim(regexp_replace(coalesce(v_patch->>'title', ''), '\s+', ' ', 'g'));
    if v_field is distinct from v_title then
      v_title := v_field;
      v_changed := v_changed || text 'title';
    end if;
  end if;
  if v_patch ? 'linkedin_url' then
    v_field := private.normalize_linkedin_profile_url(v_patch->>'linkedin_url');
    if v_field is null then
      raise exception 'LinkedIn URL must be a profile URL such as https://www.linkedin.com/in/example'
        using errcode = '22023';
    end if;
    if v_field is distinct from coalesce(private.normalize_linkedin_profile_url(v_linkedin), v_linkedin) then
      v_linkedin := v_field;
      v_changed := v_changed || text 'linkedin_url';
    end if;
  end if;
  perform private.crm_validate_contact_fields(v_name, v_title);

  if cardinality(v_changed) > 0 then
    v_conflict := private.crm_contact_conflict(v_type, p_company_id, v_name, v_linkedin, v_table,
      p_contact_id,
      'name' = any(v_changed) and private.normalize_crm_person_name(v_name) <> private.normalize_crm_person_name(v_contact->>'name'),
      'linkedin_url' = any(v_changed));
    if v_conflict is not null then
      return jsonb_build_object('ok', false,
        'status', case when v_conflict->>'reason' = 'same_name_at_company' then 'duplicate_name' else 'duplicate_linkedin' end,
        'changed', false, 'conflict', v_conflict,
        'contact', private.crm_contact_summary(v_contact, v_table),
        'company', private.crm_company_summary(v_type, v_company), 'replayed', false);
    end if;
    if v_type = 'manufacturer' then
      update public.manufacturer_contacts as c set name = v_name, title = v_title, linkedin = v_linkedin
      where c.id = p_contact_id;
      select to_jsonb(c) into v_after from public.manufacturer_contacts as c where c.id = p_contact_id;
    else
      update public.vendor_contacts as c set name = v_name, title = v_title, linkedin = v_linkedin
      where c.id = p_contact_id;
      select to_jsonb(c) into v_after from public.vendor_contacts as c where c.id = p_contact_id;
    end if;
  else
    v_after := v_contact;
  end if;

  v_result := jsonb_build_object(
    'ok', true,
    'status', case when cardinality(v_changed) = 0 then 'no_change' else 'updated' end,
    'changed', cardinality(v_changed) > 0,
    'changed_fields', to_jsonb(v_changed),
    'contact', private.crm_contact_summary(v_after, v_table),
    'previous', private.crm_contact_summary(v_contact, v_table),
    'company', private.crm_company_summary(v_type, v_company)
  );
  return private.mcp_operation_record(v_actor, p_operation_id, 'update_contact', v_fingerprint,
    v_table, p_contact_id, v_contact, v_after, v_result);
end;
$function$;

create or replace function public.mcp_set_crm_contact_archived(
  p_operation_id uuid,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_contact_id bigint,
  p_expected_contact_name text,
  p_archived boolean,
  p_reason text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_action text := case when p_archived then 'archive_contact' else 'restore_contact' end;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fingerprint text;
  v_replay jsonb;
  v_company jsonb;
  v_type text;
  v_table text;
  v_contact jsonb;
  v_archive private.crm_archived_contacts%rowtype;
  v_archive_id bigint;
  v_conflict jsonb;
  v_result jsonb;
begin
  if p_archived is null then
    raise exception 'Archive flag is required' using errcode = '22023';
  end if;
  if p_archived and (length(v_reason) < 3 or length(v_reason) > 500) then
    raise exception 'An archive reason of 3 to 500 characters is required' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('type', lower(btrim(coalesce(p_company_type, ''))),
    'id', p_company_id, 'expected', lower(btrim(coalesce(p_expected_company_name, ''))),
    'contact_id', p_contact_id, 'expected_contact', lower(btrim(coalesce(p_expected_contact_name, ''))),
    'archived', p_archived, 'reason', v_reason)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, v_action, v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_company := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);
  v_type := v_company->>'_type';
  if v_type = 'lost' then
    raise exception 'Lost records keep a single inline person and have no contact rows' using errcode = '22023';
  end if;
  v_table := case when v_type = 'manufacturer' then 'manufacturer_contacts' else 'vendor_contacts' end;

  if p_archived then
    v_contact := private.crm_lock_contact(v_type, p_company_id, p_contact_id, p_expected_contact_name);
    insert into private.crm_archived_contacts (
      contact_table, contact_id, company_type, company_id, company_name, row_data, reason,
      archived_by, archive_operation_id
    ) values (
      v_table, p_contact_id, v_type, p_company_id, v_company->>'company', v_contact, v_reason,
      v_actor, p_operation_id
    )
    returning archive_id into v_archive_id;
    if v_type = 'manufacturer' then
      delete from public.manufacturer_contacts as c where c.id = p_contact_id;
    else
      delete from public.vendor_contacts as c where c.id = p_contact_id;
    end if;
    v_result := jsonb_build_object('ok', true, 'status', 'archived', 'changed', true,
      'archive_id', v_archive_id, 'contact', private.crm_contact_summary(v_contact, v_table),
      'company', private.crm_company_summary(v_type, v_company), 'reason', v_reason);
    return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
      v_table, p_contact_id, v_contact, null, v_result);
  end if;

  if (v_company->>'_archived')::boolean then
    raise exception 'CRM % company % is archived; restore the company first', v_type, p_company_id
      using errcode = '22023';
  end if;
  if (v_type = 'manufacturer' and exists (select 1 from public.manufacturer_contacts as c where c.id = p_contact_id))
    or (v_type = 'vendor' and exists (select 1 from public.vendor_contacts as c where c.id = p_contact_id)) then
    v_result := jsonb_build_object('ok', true, 'status', 'not_archived', 'changed', false,
      'company', private.crm_company_summary(v_type, v_company));
    return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
      v_table, p_contact_id, null, null, v_result);
  end if;

  select archive.*
  into v_archive
  from private.crm_archived_contacts as archive
  where archive.contact_table = v_table
    and archive.contact_id = p_contact_id
    and archive.restored_at is null
  order by archive.archived_at desc
  limit 1
  for update;
  if not found then
    raise exception 'No archived % contact % exists', v_type, p_contact_id using errcode = '23503';
  end if;
  if v_archive.company_type <> v_type or v_archive.company_id <> p_company_id then
    raise exception 'Archived contact % belonged to CRM % company %, not the company supplied',
      p_contact_id, v_archive.company_type, v_archive.company_id using errcode = '22023';
  end if;
  if lower(btrim(coalesce(v_archive.row_data->>'name', ''))) <> lower(btrim(coalesce(p_expected_contact_name, ''))) then
    raise exception 'Contact name mismatch for archived contact %', p_contact_id using errcode = '22023';
  end if;

  v_conflict := private.crm_contact_conflict(v_type, p_company_id, v_archive.row_data->>'name',
    coalesce(private.normalize_linkedin_profile_url(v_archive.row_data->>'linkedin'), ''), null, null, true, true);
  if v_conflict is not null then
    return jsonb_build_object('ok', false,
      'status', case when v_conflict->>'reason' = 'same_name_at_company' then 'duplicate_name' else 'duplicate_linkedin' end,
      'changed', false, 'conflict', v_conflict, 'replayed', false);
  end if;

  if v_type = 'manufacturer' then
    insert into public.manufacturer_contacts
    select (jsonb_populate_record(null::public.manufacturer_contacts, v_archive.row_data)).*;
  else
    insert into public.vendor_contacts
    select (jsonb_populate_record(null::public.vendor_contacts, v_archive.row_data)).*;
  end if;
  update private.crm_archived_contacts as archive
  set restored_at = now(), restored_by = v_actor, restore_operation_id = p_operation_id
  where archive.archive_id = v_archive.archive_id;

  v_result := jsonb_build_object('ok', true, 'status', 'restored', 'changed', true,
    'archive_id', v_archive.archive_id,
    'contact', private.crm_contact_summary(v_archive.row_data, v_table),
    'company', private.crm_company_summary(v_type, v_company));
  return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
    v_table, p_contact_id, null, v_archive.row_data, v_result);
end;
$function$;

create or replace function public.mcp_move_crm_contact(
  p_operation_id uuid,
  p_source_company_type text,
  p_source_company_id bigint,
  p_expected_source_company_name text,
  p_contact_id bigint,
  p_expected_contact_name text,
  p_destination_company_type text,
  p_destination_company_id bigint,
  p_expected_destination_company_name text,
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
  v_source_type text := lower(btrim(coalesce(p_source_company_type, '')));
  v_destination_type text := lower(btrim(coalesce(p_destination_company_type, '')));
  v_source jsonb;
  v_destination jsonb;
  v_contact jsonb;
  v_source_table text;
  v_destination_table text;
  v_conflict jsonb;
  v_new_id bigint;
  v_after jsonb;
  v_result jsonb;
begin
  if v_source_type not in ('manufacturer', 'vendor') or v_destination_type not in ('manufacturer', 'vendor') then
    raise exception 'Contacts can only move between manufacturers and vendors' using errcode = '22023';
  end if;
  if v_source_type = v_destination_type and p_source_company_id = p_destination_company_id then
    raise exception 'Source and destination company are the same' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('source_type', v_source_type, 'source_id', p_source_company_id,
    'source_name', lower(btrim(coalesce(p_expected_source_company_name, ''))), 'contact_id', p_contact_id,
    'contact_name', lower(btrim(coalesce(p_expected_contact_name, ''))), 'destination_type', v_destination_type,
    'destination_id', p_destination_company_id,
    'destination_name', lower(btrim(coalesce(p_expected_destination_company_name, ''))))::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'move_contact', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  -- Lock both companies in a stable order so concurrent moves cannot deadlock.
  if (v_source_type, p_source_company_id) < (v_destination_type, p_destination_company_id) then
    v_source := private.crm_lock_company(v_source_type, p_source_company_id, p_expected_source_company_name);
    v_destination := private.crm_lock_company(v_destination_type, p_destination_company_id, p_expected_destination_company_name);
  else
    v_destination := private.crm_lock_company(v_destination_type, p_destination_company_id, p_expected_destination_company_name);
    v_source := private.crm_lock_company(v_source_type, p_source_company_id, p_expected_source_company_name);
  end if;
  if (v_destination->>'_archived')::boolean then
    raise exception 'Destination CRM % company % is archived', v_destination_type, p_destination_company_id
      using errcode = '22023';
  end if;

  v_contact := private.crm_lock_contact(v_source_type, p_source_company_id, p_contact_id, p_expected_contact_name);
  v_source_table := case when v_source_type = 'manufacturer' then 'manufacturer_contacts' else 'vendor_contacts' end;
  v_destination_table := case when v_destination_type = 'manufacturer' then 'manufacturer_contacts' else 'vendor_contacts' end;

  v_conflict := private.crm_contact_conflict(v_destination_type, p_destination_company_id,
    v_contact->>'name', coalesce(private.normalize_linkedin_profile_url(v_contact->>'linkedin'), ''),
    v_source_table, p_contact_id, true, true);
  if v_conflict is not null then
    return jsonb_build_object('ok', false,
      'status', case when v_conflict->>'reason' = 'same_name_at_company' then 'duplicate_name' else 'duplicate_linkedin' end,
      'changed', false, 'conflict', v_conflict, 'replayed', false);
  end if;

  if v_source_table = v_destination_table then
    if v_source_table = 'manufacturer_contacts' then
      update public.manufacturer_contacts as c set manufacturer_id = p_destination_company_id where c.id = p_contact_id;
      select to_jsonb(c) into v_after from public.manufacturer_contacts as c where c.id = p_contact_id;
    else
      update public.vendor_contacts as c set vendor_id = p_destination_company_id where c.id = p_contact_id;
      select to_jsonb(c) into v_after from public.vendor_contacts as c where c.id = p_contact_id;
    end if;
  else
    -- Manufacturer and vendor contacts live in different tables. The person is
    -- recreated at the destination and the original row is kept in the contact
    -- archive, so nothing is lost and no clone remains at the source.
    if v_destination_table = 'manufacturer_contacts' then
      insert into public.manufacturer_contacts (manufacturer_id, name, title, linkedin)
      values (p_destination_company_id, v_contact->>'name', coalesce(v_contact->>'title', ''), coalesce(v_contact->>'linkedin', ''))
      returning id into v_new_id;
      select to_jsonb(c) into v_after from public.manufacturer_contacts as c where c.id = v_new_id;
      delete from public.vendor_contacts as c where c.id = p_contact_id;
    else
      insert into public.vendor_contacts (vendor_id, name, title, linkedin)
      values (p_destination_company_id, v_contact->>'name', coalesce(v_contact->>'title', ''), coalesce(v_contact->>'linkedin', ''))
      returning id into v_new_id;
      select to_jsonb(c) into v_after from public.vendor_contacts as c where c.id = v_new_id;
      delete from public.manufacturer_contacts as c where c.id = p_contact_id;
    end if;
    insert into private.crm_archived_contacts (
      contact_table, contact_id, company_type, company_id, company_name, row_data, reason,
      archived_by, archive_operation_id, restored_at, restored_by, restore_operation_id
    ) values (
      v_source_table, p_contact_id, v_source_type, p_source_company_id, v_source->>'company', v_contact,
      format('Moved to %s %s as %s contact %s', v_destination_type, p_destination_company_id, v_destination_type, v_new_id),
      v_actor, p_operation_id, now(), v_actor, p_operation_id
    );
  end if;

  v_result := jsonb_build_object('ok', true, 'status', 'moved', 'changed', true,
    'contact', private.crm_contact_summary(v_after, v_destination_table),
    'previous_contact_id', p_contact_id,
    'contact_id_changed', (v_after->>'id')::bigint <> p_contact_id,
    'source_company', private.crm_company_summary(v_source_type, v_source),
    'destination_company', private.crm_company_summary(v_destination_type, v_destination));
  return private.mcp_operation_record(v_actor, p_operation_id, 'move_contact', v_fingerprint,
    v_source_table, p_contact_id, v_contact, v_after, v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Tasks (stored as activities rows carrying a __task__|state|owner marker)
-- ---------------------------------------------------------------------------

create or replace function private.crm_task_summary(p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select jsonb_build_object(
    'task_id', (p_row->>'id')::bigint,
    'title', p_row->>'note',
    'due_date', p_row->>'date',
    'state', private.crm_task_marker(p_row->>'created_by')->>'state',
    'owner', private.crm_task_marker(p_row->>'created_by')->>'owner',
    'company_id', (p_row->>'contact_id')::bigint,
    'company_type', p_row->>'contact_type',
    'created_at', p_row->>'created_at'
  );
$function$;

create or replace function private.crm_lock_task(
  p_task_id bigint,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_expected_task_title text
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_company jsonb;
  v_task jsonb;
begin
  if p_task_id is null or p_task_id <= 0 then
    raise exception 'Task id must be a positive integer' using errcode = '22023';
  end if;
  v_company := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);
  select to_jsonb(a) into v_task from public.activities as a where a.id = p_task_id for update;
  if v_task is null or private.crm_task_marker(v_task->>'created_by') is null then
    raise exception 'CRM task % does not exist', p_task_id using errcode = '23503';
  end if;
  if v_task->>'contact_type' <> v_company->>'_type' or (v_task->>'contact_id')::bigint <> p_company_id then
    raise exception 'CRM task % belongs to % company %, not the company supplied', p_task_id,
      v_task->>'contact_type', v_task->>'contact_id' using errcode = '22023';
  end if;
  if lower(btrim(coalesce(v_task->>'note', ''))) <> lower(btrim(coalesce(p_expected_task_title, ''))) then
    raise exception 'Task title mismatch for CRM task %; read the task again', p_task_id using errcode = '22023';
  end if;
  return jsonb_build_object('company', v_company, 'task', v_task);
end;
$function$;

create or replace function public.mcp_create_crm_task(
  p_operation_id uuid,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_title text,
  p_due_date date,
  p_owner text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_title text := btrim(coalesce(p_title, ''));
  v_owner text := case lower(btrim(coalesce(p_owner, ''))) when '' then 'Scott' when 'scott' then 'Scott' when 'jeff' then 'Jeff' else null end;
  v_fingerprint text;
  v_replay jsonb;
  v_company jsonb;
  v_task jsonb;
  v_result jsonb;
begin
  if v_title = '' or length(v_title) > 2000 then
    raise exception 'Task title must contain 1 to 2000 characters' using errcode = '22023';
  end if;
  if v_owner is null then
    raise exception 'Task owner must be Scott or Jeff' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('type', lower(btrim(coalesce(p_company_type, ''))),
    'id', p_company_id, 'expected', lower(btrim(coalesce(p_expected_company_name, ''))),
    'title', v_title, 'due_date', p_due_date, 'owner', v_owner)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'create_task', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_company := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);
  if (v_company->>'_archived')::boolean then
    raise exception 'CRM % company % is archived; restore it before adding tasks', v_company->>'_type', p_company_id
      using errcode = '22023';
  end if;

  insert into public.activities (contact_id, contact_type, type, note, date, created_by)
  values (p_company_id, v_company->>'_type', 'Note', v_title, p_due_date, '__task__|open|' || v_owner)
  returning to_jsonb(activities.*) into v_task;

  v_result := jsonb_build_object('ok', true, 'status', 'created', 'changed', true,
    'task', private.crm_task_summary(v_task),
    'company', private.crm_company_summary(v_company->>'_type', v_company));
  return private.mcp_operation_record(v_actor, p_operation_id, 'create_task', v_fingerprint,
    'task', (v_task->>'id')::bigint, null, v_task, v_result);
end;
$function$;

create or replace function public.mcp_update_crm_task(
  p_operation_id uuid,
  p_task_id bigint,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_expected_task_title text,
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
  v_field text;
  v_fingerprint text;
  v_replay jsonb;
  v_locked jsonb;
  v_task jsonb;
  v_marker jsonb;
  v_title text;
  v_due date;
  v_owner text;
  v_changed text[] := '{}';
  v_after jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(v_patch) <> 'object' or v_patch = '{}'::jsonb then
    raise exception 'Provide at least one task field to update' using errcode = '22023';
  end if;
  for v_field in select jsonb_object_keys(v_patch) loop
    if v_field not in ('title', 'due_date', 'owner') then
      raise exception 'Field % cannot be updated through this tool', v_field using errcode = '22023';
    end if;
  end loop;
  v_fingerprint := md5(jsonb_build_object('task_id', p_task_id, 'type', lower(btrim(coalesce(p_company_type, ''))),
    'id', p_company_id, 'expected', lower(btrim(coalesce(p_expected_company_name, ''))),
    'expected_title', lower(btrim(coalesce(p_expected_task_title, ''))), 'patch', v_patch)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'update_task', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_locked := private.crm_lock_task(p_task_id, p_company_type, p_company_id, p_expected_company_name, p_expected_task_title);
  v_task := v_locked->'task';
  v_marker := private.crm_task_marker(v_task->>'created_by');
  v_title := v_task->>'note';
  v_due := (v_task->>'date')::date;
  v_owner := v_marker->>'owner';

  if v_patch ? 'title' then
    v_field := btrim(coalesce(v_patch->>'title', ''));
    if v_field = '' or length(v_field) > 2000 then
      raise exception 'Task title must contain 1 to 2000 characters' using errcode = '22023';
    end if;
    if v_field is distinct from v_title then
      v_title := v_field;
      v_changed := v_changed || text 'title';
    end if;
  end if;
  if v_patch ? 'due_date' then
    if jsonb_typeof(v_patch->'due_date') = 'null' then
      if v_due is not null then
        v_due := null;
        v_changed := v_changed || text 'due_date';
      end if;
    else
      if coalesce(v_patch->>'due_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Due date must be YYYY-MM-DD or null' using errcode = '22023';
      end if;
      if (v_patch->>'due_date')::date is distinct from v_due then
        v_due := (v_patch->>'due_date')::date;
        v_changed := v_changed || text 'due_date';
      end if;
    end if;
  end if;
  if v_patch ? 'owner' then
    v_field := case lower(btrim(coalesce(v_patch->>'owner', ''))) when 'scott' then 'Scott' when 'jeff' then 'Jeff' else null end;
    if v_field is null then
      raise exception 'Task owner must be Scott or Jeff' using errcode = '22023';
    end if;
    if v_field <> v_owner then
      v_owner := v_field;
      v_changed := v_changed || text 'owner';
    end if;
  end if;

  if cardinality(v_changed) > 0 then
    update public.activities as a
    set note = v_title,
      date = v_due,
      created_by = '__task__|' || (v_marker->>'state') || '|' || v_owner
    where a.id = p_task_id;
  end if;
  select to_jsonb(a) into v_after from public.activities as a where a.id = p_task_id;

  v_result := jsonb_build_object('ok', true,
    'status', case when cardinality(v_changed) = 0 then 'no_change' else 'updated' end,
    'changed', cardinality(v_changed) > 0, 'changed_fields', to_jsonb(v_changed),
    'task', private.crm_task_summary(v_after), 'previous', private.crm_task_summary(v_task),
    'company', private.crm_company_summary(v_locked->'company'->>'_type', v_locked->'company'));
  return private.mcp_operation_record(v_actor, p_operation_id, 'update_task', v_fingerprint,
    'task', p_task_id, v_task, v_after, v_result);
end;
$function$;

create or replace function public.mcp_set_crm_task_state(
  p_operation_id uuid,
  p_task_id bigint,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_expected_task_title text,
  p_state text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_state text := lower(btrim(coalesce(p_state, '')));
  v_action text;
  v_fingerprint text;
  v_replay jsonb;
  v_locked jsonb;
  v_task jsonb;
  v_marker jsonb;
  v_after jsonb;
  v_status text;
  v_result jsonb;
begin
  if v_state not in ('open', 'done') then
    raise exception 'Task state must be open or done' using errcode = '22023';
  end if;
  v_action := case when v_state = 'open' then 'reopen_task' else 'set_task_done' end;
  v_fingerprint := md5(jsonb_build_object('task_id', p_task_id, 'type', lower(btrim(coalesce(p_company_type, ''))),
    'id', p_company_id, 'expected', lower(btrim(coalesce(p_expected_company_name, ''))),
    'expected_title', lower(btrim(coalesce(p_expected_task_title, ''))), 'state', v_state)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, v_action, v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_locked := private.crm_lock_task(p_task_id, p_company_type, p_company_id, p_expected_company_name, p_expected_task_title);
  v_task := v_locked->'task';
  v_marker := private.crm_task_marker(v_task->>'created_by');

  if v_marker->>'state' = v_state then
    v_status := case when v_state = 'open' then 'already_open' else 'already_done' end;
  else
    v_status := case when v_state = 'open' then 'reopened' else 'completed' end;
    update public.activities as a
    set created_by = '__task__|' || v_state || '|' || (v_marker->>'owner')
    where a.id = p_task_id;
    if v_state = 'done' then
      perform private.crm_touch_last_contact(v_task->>'contact_type', p_company_id, private.crm_toronto_today());
    end if;
  end if;
  select to_jsonb(a) into v_after from public.activities as a where a.id = p_task_id;

  v_result := jsonb_build_object('ok', true, 'status', v_status,
    'changed', v_status in ('reopened', 'completed'),
    'task', private.crm_task_summary(v_after),
    'company', private.crm_company_summary(v_locked->'company'->>'_type', v_locked->'company'));
  return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
    'task', p_task_id, v_task, v_after, v_result);
end;
$function$;

create or replace function private.crm_touch_last_contact(p_company_type text, p_company_id bigint, p_date date)
returns void
language plpgsql
set search_path = ''
as $function$
begin
  if p_date is null then
    return;
  end if;
  if p_company_type = 'manufacturer' then
    update public.manufacturers as m set last_contact = greatest(coalesce(m.last_contact, p_date), p_date)
    where m.id = p_company_id;
  elsif p_company_type = 'vendor' then
    update public.vendors as v set last_contact = greatest(coalesce(v.last_contact, p_date), p_date)
    where v.id = p_company_id;
  elsif p_company_type = 'lost' then
    update public.lost_contacts as l set last_contact = greatest(coalesce(l.last_contact, p_date), p_date)
    where l.id = p_company_id;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Activities: corrections keep a revision; voids and task archives keep the
-- full original row in private.crm_archived_activities and can be restored.
-- ---------------------------------------------------------------------------

create or replace function private.crm_activity_summary(p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select jsonb_build_object(
    'activity_id', (p_row->>'id')::bigint,
    'activity_type', p_row->>'type',
    'activity_date', p_row->>'date',
    'performed_by', p_row->>'created_by',
    'company_id', (p_row->>'contact_id')::bigint,
    'company_type', p_row->>'contact_type',
    'note_sha256', private.crm_text_sha256(p_row->>'note'),
    'note_has_images', private.crm_notes_has_images(p_row->>'note'),
    'created_at', p_row->>'created_at'
  );
$function$;

create or replace function public.mcp_update_crm_activity(
  p_operation_id uuid,
  p_activity_id bigint,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_expected_activity_type text,
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
  v_field text;
  v_fingerprint text;
  v_replay jsonb;
  v_company jsonb;
  v_activity jsonb;
  v_note text;
  v_date date;
  v_type text;
  v_created_by text;
  v_changed text[] := '{}';
  v_after jsonb;
  v_revision_id bigint;
  v_result jsonb;
begin
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'Update fields must be an object' using errcode = '22023';
  end if;
  for v_field in select jsonb_object_keys(v_patch) loop
    if v_field not in ('note_replace', 'expected_note_sha256', 'note_append', 'activity_date', 'activity_type', 'owner') then
      raise exception 'Field % cannot be updated through this tool', v_field using errcode = '22023';
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(v_patch) as k where k <> 'expected_note_sha256') = 0 then
    raise exception 'Provide at least one activity field to update' using errcode = '22023';
  end if;
  if v_patch ? 'note_replace' and v_patch ? 'note_append' then
    raise exception 'Use either note_append or note_replace, not both' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('activity_id', p_activity_id, 'type', lower(btrim(coalesce(p_company_type, ''))),
    'id', p_company_id, 'expected', lower(btrim(coalesce(p_expected_company_name, ''))),
    'expected_activity_type', lower(btrim(coalesce(p_expected_activity_type, ''))), 'patch', v_patch)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'update_activity', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_company := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);
  select to_jsonb(a) into v_activity from public.activities as a where a.id = p_activity_id for update;
  if v_activity is null then
    raise exception 'CRM activity % does not exist', p_activity_id using errcode = '23503';
  end if;
  if private.crm_task_marker(v_activity->>'created_by') is not null then
    raise exception 'CRM activity % is a task; use the task tools', p_activity_id using errcode = '22023';
  end if;
  if v_activity->>'contact_type' <> v_company->>'_type' or (v_activity->>'contact_id')::bigint <> p_company_id then
    raise exception 'CRM activity % belongs to % company %, not the company supplied', p_activity_id,
      v_activity->>'contact_type', v_activity->>'contact_id' using errcode = '22023';
  end if;
  if lower(v_activity->>'type') <> lower(btrim(coalesce(p_expected_activity_type, ''))) then
    raise exception 'Activity type mismatch for CRM activity %; read the activity again', p_activity_id
      using errcode = '22023';
  end if;

  v_note := v_activity->>'note';
  v_date := (v_activity->>'date')::date;
  v_type := v_activity->>'type';
  v_created_by := v_activity->>'created_by';

  if v_patch ? 'note_append' then
    v_field := btrim(coalesce(v_patch->>'note_append', ''));
    if v_field = '' or length(v_field) > 20000 then
      raise exception 'note_append must contain 1 to 20000 characters' using errcode = '22023';
    end if;
    v_note := private.crm_notes_append_plain(v_note, v_field);
    v_changed := v_changed || text 'note';
  elsif v_patch ? 'note_replace' then
    if coalesce(v_patch->>'expected_note_sha256', '') <> private.crm_text_sha256(v_note) then
      raise exception 'Activity note changed since it was read; read the company profile again before replacing it'
        using errcode = 'PT409';
    end if;
    if private.crm_notes_has_images(v_note) then
      raise exception 'This activity note contains pasted images that cannot be reproduced; use note_append instead'
        using errcode = '22023';
    end if;
    v_field := btrim(coalesce(v_patch->>'note_replace', ''));
    if v_field = '' or length(v_field) > 20000 then
      raise exception 'note_replace must contain 1 to 20000 characters; void the activity instead of blanking it'
        using errcode = '22023';
    end if;
    if v_field is distinct from v_note then
      v_note := v_field;
      v_changed := v_changed || text 'note';
    end if;
  end if;
  if v_patch ? 'activity_date' then
    if coalesce(v_patch->>'activity_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Activity date must be YYYY-MM-DD' using errcode = '22023';
    end if;
    if (v_patch->>'activity_date')::date > private.crm_toronto_today() then
      raise exception 'Activity date cannot be in the future' using errcode = '22023';
    end if;
    if (v_patch->>'activity_date')::date is distinct from v_date then
      v_date := (v_patch->>'activity_date')::date;
      v_changed := v_changed || text 'activity_date';
    end if;
  end if;
  if v_patch ? 'activity_type' then
    v_field := case lower(btrim(coalesce(v_patch->>'activity_type', '')))
      when 'call' then 'Call' when 'email' then 'Email' when 'meeting' then 'Meeting' when 'note' then 'Note' else null end;
    if v_field is null then
      raise exception 'Activity type must be Call, Email, Meeting, or Note' using errcode = '22023';
    end if;
    if v_field <> v_type then
      v_type := v_field;
      v_changed := v_changed || text 'activity_type';
    end if;
  end if;
  if v_patch ? 'owner' then
    v_field := case lower(btrim(coalesce(v_patch->>'owner', ''))) when 'scott' then 'Scott' when 'jeff' then 'Jeff' else null end;
    if v_field is null then
      raise exception 'Activity owner must be Scott or Jeff' using errcode = '22023';
    end if;
    if v_field is distinct from v_created_by then
      v_created_by := v_field;
      v_changed := v_changed || text 'owner';
    end if;
  end if;

  if cardinality(v_changed) > 0 then
    update public.activities as a
    set note = v_note, date = v_date, type = v_type, created_by = v_created_by
    where a.id = p_activity_id;
    select to_jsonb(a) into v_after from public.activities as a where a.id = p_activity_id;
    insert into private.crm_activity_revisions (activity_id, operation_id, changed_by, before_values, after_values)
    values (p_activity_id, p_operation_id, v_actor, private.crm_audit_row(v_activity), private.crm_audit_row(v_after))
    returning revision_id into v_revision_id;
    if 'activity_date' = any(v_changed) then
      perform private.crm_touch_last_contact(v_company->>'_type', p_company_id, v_date);
    end if;
  else
    v_after := v_activity;
  end if;

  v_result := jsonb_build_object('ok', true,
    'status', case when cardinality(v_changed) = 0 then 'no_change' else 'updated' end,
    'changed', cardinality(v_changed) > 0, 'changed_fields', to_jsonb(v_changed),
    'revision_id', v_revision_id,
    'activity', private.crm_activity_summary(v_after),
    'previous', private.crm_activity_summary(v_activity),
    'company', private.crm_company_summary(v_company->>'_type', v_company));
  return private.mcp_operation_record(v_actor, p_operation_id, 'update_activity', v_fingerprint,
    'activity', p_activity_id, private.crm_audit_row(v_activity), private.crm_audit_row(v_after), v_result);
end;
$function$;

create or replace function public.mcp_set_crm_activity_archived(
  p_operation_id uuid,
  p_activity_id bigint,
  p_kind text,
  p_company_type text,
  p_company_id bigint,
  p_expected_company_name text,
  p_expected_label text,
  p_archived boolean,
  p_reason text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_action text;
  v_fingerprint text;
  v_replay jsonb;
  v_company jsonb;
  v_row jsonb;
  v_archive private.crm_archived_activities%rowtype;
  v_archive_id bigint;
  v_is_task boolean;
  v_label text;
  v_result jsonb;
begin
  if v_kind not in ('activity', 'task') then
    raise exception 'Kind must be activity or task' using errcode = '22023';
  end if;
  if p_archived is null then
    raise exception 'Archive flag is required' using errcode = '22023';
  end if;
  if p_archived and (length(v_reason) < 3 or length(v_reason) > 500) then
    raise exception 'A reason of 3 to 500 characters is required' using errcode = '22023';
  end if;
  v_action := case
    when p_archived and v_kind = 'activity' then 'void_activity'
    when p_archived then 'archive_task'
    when v_kind = 'activity' then 'restore_activity'
    else 'restore_task' end;
  v_fingerprint := md5(jsonb_build_object('activity_id', p_activity_id, 'kind', v_kind,
    'type', lower(btrim(coalesce(p_company_type, ''))), 'id', p_company_id,
    'expected', lower(btrim(coalesce(p_expected_company_name, ''))),
    'label', lower(btrim(coalesce(p_expected_label, ''))), 'archived', p_archived, 'reason', v_reason)::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, v_action, v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  v_company := private.crm_lock_company(p_company_type, p_company_id, p_expected_company_name);

  if p_archived then
    select to_jsonb(a) into v_row from public.activities as a where a.id = p_activity_id for update;
    if v_row is null then
      raise exception 'CRM % % does not exist', v_kind, p_activity_id using errcode = '23503';
    end if;
    v_is_task := private.crm_task_marker(v_row->>'created_by') is not null;
    if v_is_task <> (v_kind = 'task') then
      raise exception 'CRM row % is a %, not a %', p_activity_id,
        case when v_is_task then 'task' else 'activity' end, v_kind using errcode = '22023';
    end if;
    if v_row->>'contact_type' <> v_company->>'_type' or (v_row->>'contact_id')::bigint <> p_company_id then
      raise exception 'CRM % % belongs to % company %, not the company supplied', v_kind, p_activity_id,
        v_row->>'contact_type', v_row->>'contact_id' using errcode = '22023';
    end if;
    v_label := case when v_is_task then v_row->>'note' else v_row->>'type' end;
    if lower(btrim(coalesce(v_label, ''))) <> lower(btrim(coalesce(p_expected_label, ''))) then
      raise exception 'Expected % does not match CRM % %; read it again',
        case when v_is_task then 'task title' else 'activity type' end, v_kind, p_activity_id
        using errcode = '22023';
    end if;
    insert into private.crm_archived_activities (
      activity_id, is_task, company_type, company_id, row_data, reason, archived_by, archive_operation_id
    ) values (
      p_activity_id, v_is_task, v_row->>'contact_type', p_company_id, v_row, v_reason, v_actor, p_operation_id
    )
    returning archive_id into v_archive_id;
    delete from public.activities as a where a.id = p_activity_id;

    v_result := jsonb_build_object('ok', true,
      'status', case when v_is_task then 'archived' else 'voided' end, 'changed', true,
      'archive_id', v_archive_id, 'kind', v_kind,
      'item', case when v_is_task then private.crm_task_summary(v_row) else private.crm_activity_summary(v_row) end,
      'company', private.crm_company_summary(v_company->>'_type', v_company), 'reason', v_reason);
    return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
      v_kind, p_activity_id, private.crm_audit_row(v_row), null, v_result);
  end if;

  if exists (select 1 from public.activities as a where a.id = p_activity_id) then
    v_result := jsonb_build_object('ok', true, 'status', 'not_archived', 'changed', false, 'kind', v_kind,
      'company', private.crm_company_summary(v_company->>'_type', v_company));
    return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
      v_kind, p_activity_id, null, null, v_result);
  end if;

  select archive.* into v_archive
  from private.crm_archived_activities as archive
  where archive.activity_id = p_activity_id and archive.restored_at is null
  order by archive.archived_at desc
  limit 1
  for update;
  if not found then
    raise exception 'No archived CRM % % exists', v_kind, p_activity_id using errcode = '23503';
  end if;
  if v_archive.is_task <> (v_kind = 'task') then
    raise exception 'Archived CRM row % is a %, not a %', p_activity_id,
      case when v_archive.is_task then 'task' else 'activity' end, v_kind using errcode = '22023';
  end if;
  if v_archive.company_type <> v_company->>'_type' or v_archive.company_id <> p_company_id then
    raise exception 'Archived CRM % % belonged to % company %, not the company supplied', v_kind, p_activity_id,
      v_archive.company_type, v_archive.company_id using errcode = '22023';
  end if;
  v_label := case when v_archive.is_task then v_archive.row_data->>'note' else v_archive.row_data->>'type' end;
  if lower(btrim(coalesce(v_label, ''))) <> lower(btrim(coalesce(p_expected_label, ''))) then
    raise exception 'Expected % does not match archived CRM % %',
      case when v_archive.is_task then 'task title' else 'activity type' end, v_kind, p_activity_id
      using errcode = '22023';
  end if;

  insert into public.activities
  select (jsonb_populate_record(null::public.activities, v_archive.row_data)).*;
  update private.crm_archived_activities as archive
  set restored_at = now(), restored_by = v_actor, restore_operation_id = p_operation_id
  where archive.archive_id = v_archive.archive_id;
  if not v_archive.is_task then
    perform private.crm_touch_last_contact(v_archive.company_type, p_company_id, (v_archive.row_data->>'date')::date);
  end if;

  v_result := jsonb_build_object('ok', true, 'status', 'restored', 'changed', true,
    'archive_id', v_archive.archive_id, 'kind', v_kind,
    'item', case when v_archive.is_task then private.crm_task_summary(v_archive.row_data) else private.crm_activity_summary(v_archive.row_data) end,
    'company', private.crm_company_summary(v_company->>'_type', v_company));
  return private.mcp_operation_record(v_actor, p_operation_id, v_action, v_fingerprint,
    v_kind, p_activity_id, null, private.crm_audit_row(v_archive.row_data), v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Merge: preview returns a short-lived token bound to a fingerprint of both
-- companies, their contacts, activities, and aliases. The merge refuses to run
-- if anything changed after the preview.
-- ---------------------------------------------------------------------------

create or replace function private.crm_company_contacts_json(p_company_type text, p_company_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select coalesce(jsonb_agg(contact order by (contact->>'contact_id')::bigint), '[]'::jsonb)
  from (
    select jsonb_build_object('contact_table', 'manufacturer_contacts', 'contact_id', c.id, 'name', c.name,
      'title', c.title, 'linkedin', c.linkedin) as contact
    from public.manufacturer_contacts as c
    where p_company_type = 'manufacturer' and c.manufacturer_id = p_company_id
    union all
    select jsonb_build_object('contact_table', 'vendor_contacts', 'contact_id', c.id, 'name', c.name,
      'title', c.title, 'linkedin', c.linkedin)
    from public.vendor_contacts as c
    where p_company_type = 'vendor' and c.vendor_id = p_company_id
  ) as contacts;
$function$;

create or replace function private.crm_merge_fingerprint(
  p_source_type text,
  p_source_id bigint,
  p_destination_type text,
  p_destination_id bigint
)
returns text
language plpgsql
set search_path = ''
as $function$
begin
  return md5(concat_ws('|',
    coalesce(private.crm_company_row(p_source_type, p_source_id, false)::text, '-'),
    case when p_destination_id is null then '-' else coalesce(private.crm_company_row(p_destination_type, p_destination_id, false)::text, '-') end,
    private.crm_company_contacts_json(p_source_type, p_source_id)::text,
    case when p_destination_id is null then '-' else private.crm_company_contacts_json(p_destination_type, p_destination_id)::text end,
    (select count(*)::text || ':' || coalesce(md5(string_agg(a.id::text || ':' || a.type || ':' || coalesce(a.created_by, '') || ':' || coalesce(a.date::text, ''), ',' order by a.id)), '')
     from public.activities as a where a.contact_type = p_source_type and a.contact_id = p_source_id),
    (select count(*)::text || ':' || coalesce(md5(string_agg(a.id::text || ':' || a.type || ':' || coalesce(a.created_by, '') || ':' || coalesce(a.date::text, ''), ',' order by a.id)), '')
     from public.activities as a where p_destination_id is not null and a.contact_type = p_destination_type and a.contact_id = p_destination_id),
    (select coalesce(string_agg(al.company_type || ':' || al.company_id || ':' || al.alias_key, ',' order by al.id), '')
     from public.crm_company_aliases as al
     where (al.company_type = p_source_type and al.company_id = p_source_id)
        or (p_destination_id is not null and al.company_type = p_destination_type and al.company_id = p_destination_id))
  ));
end;
$function$;

-- Computes exactly what a merge would do. Used by both preview and execution.
create or replace function private.crm_merge_plan(
  p_source_type text,
  p_source_id bigint,
  p_destination_type text,
  p_destination_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_source jsonb := private.crm_company_row(p_source_type, p_source_id, false);
  v_destination jsonb;
  v_convert boolean := p_destination_id is null;
  v_name_keys text[] := '{}';
  v_linkedin_keys text[] := '{}';
  v_contact jsonb;
  v_existing jsonb;
  v_contacts jsonb := '[]'::jsonb;
  v_key text;
  v_linkedin text;
  v_action text;
  v_inline jsonb;
  v_extra_lines text[] := '{}';
  v_fills jsonb := '{}'::jsonb;
  v_warnings text[] := '{}';
  v_source_notes text := private.crm_company_notes(p_source_type, v_source);
  v_destination_notes text;
  v_industry text;
  v_related jsonb;
  v_tags_added text[];
  v_destination_tags text[];
begin
  if not v_convert then
    v_destination := private.crm_company_row(p_destination_type, p_destination_id, false);
    v_destination_notes := private.crm_company_notes(p_destination_type, v_destination);
    for v_existing in select value from jsonb_array_elements(private.crm_company_contacts_json(p_destination_type, p_destination_id)) loop
      v_name_keys := v_name_keys || private.normalize_crm_person_name(v_existing->>'name');
      v_linkedin := coalesce(private.normalize_linkedin_profile_url(v_existing->>'linkedin'), '');
      if v_linkedin <> '' then
        v_linkedin_keys := v_linkedin_keys || v_linkedin;
      end if;
    end loop;
    if p_destination_type = 'vendor' and btrim(coalesce(v_destination->>'name', '')) <> '' then
      v_name_keys := v_name_keys || private.normalize_crm_person_name(v_destination->>'name');
    end if;
  end if;

  for v_contact in select value from jsonb_array_elements(private.crm_company_contacts_json(p_source_type, p_source_id)) loop
    v_key := private.normalize_crm_person_name(v_contact->>'name');
    v_linkedin := coalesce(private.normalize_linkedin_profile_url(v_contact->>'linkedin'), '');
    v_existing := null;
    if not v_convert then
      select c into v_existing
      from jsonb_array_elements(private.crm_company_contacts_json(p_destination_type, p_destination_id)) as c
      where private.normalize_crm_person_name(c->>'name') = v_key
         or (v_linkedin <> '' and coalesce(private.normalize_linkedin_profile_url(c->>'linkedin'), '') = v_linkedin)
      order by (c->>'contact_id')::bigint
      limit 1;
    end if;
    if v_existing is not null then
      v_action := 'merge_into_existing_contact';
    elsif v_key = any(v_name_keys) or (v_linkedin <> '' and v_linkedin = any(v_linkedin_keys)) then
      v_action := 'archive_duplicate_within_source';
    elsif (case when p_source_type = 'manufacturer' then 'manufacturer_contacts' else 'vendor_contacts' end)
      = (case when p_destination_type = 'manufacturer' then 'manufacturer_contacts' else 'vendor_contacts' end) then
      v_action := 'move';
    else
      v_action := 'recreate_at_destination_and_archive_original';
    end if;
    v_contacts := v_contacts || jsonb_build_object('contact', v_contact, 'action', v_action,
      'existing_destination_contact', v_existing);
    v_name_keys := v_name_keys || v_key;
    if v_linkedin <> '' then
      v_linkedin_keys := v_linkedin_keys || v_linkedin;
    end if;
  end loop;

  if p_source_type in ('vendor', 'lost') and btrim(coalesce(v_source->>'name', '')) <> '' then
    v_key := private.normalize_crm_person_name(v_source->>'name');
    v_inline := jsonb_build_object('name', btrim(v_source->>'name'), 'title', coalesce(btrim(v_source->>'title'), ''),
      'action', case when v_key = any(v_name_keys) then 'already_present' else 'create_contact_at_destination' end);
  end if;

  -- Fields with no column at the destination are preserved as note lines.
  if p_destination_type = 'manufacturer' and p_source_type in ('vendor', 'lost') then
    v_extra_lines := array_remove(array[
      case when btrim(coalesce(v_source->>'email', '')) <> '' then 'Email: ' || btrim(v_source->>'email') end,
      case when btrim(coalesce(v_source->>'phone', '')) <> '' then 'Phone: ' || btrim(v_source->>'phone') end,
      case when btrim(coalesce(v_source->>'region', '')) <> '' then 'Region: ' || btrim(v_source->>'region') end
    ], null);
  elsif p_destination_type = 'vendor' and p_source_type = 'manufacturer' then
    v_extra_lines := array_remove(array[
      case when btrim(coalesce(v_source->>'end_product', '')) <> '' then 'End product: ' || btrim(v_source->>'end_product') end,
      case when btrim(coalesce(v_source->>'machines', '')) <> '' then 'Machines: ' || btrim(v_source->>'machines') end,
      case when btrim(coalesce(v_source->>'maintenance_needed', '')) <> '' then 'Maintenance needed: ' || btrim(v_source->>'maintenance_needed') end
    ], null);
  end if;
  if p_source_type = 'lost' then
    v_extra_lines := v_extra_lines || array_remove(array[
      case when btrim(coalesce(v_source->>'lost_reason', '')) <> '' then 'Loss reason: ' || btrim(v_source->>'lost_reason') end,
      case when coalesce((v_source->>'deal_value')::numeric, 0) <> 0 then 'Deal value: ' || (v_source->>'deal_value') end
    ], null);
  end if;

  v_industry := btrim(coalesce(v_source->>'industry', ''));
  if p_destination_type = 'manufacturer' and v_industry <> '' then
    if private.crm_canonical_manufacturer_industry(v_industry) is null then
      v_extra_lines := v_extra_lines || ('Industry: ' || v_industry);
      v_industry := '';
    else
      v_industry := private.crm_canonical_manufacturer_industry(v_industry);
    end if;
  end if;
  if v_convert or btrim(coalesce(v_destination->>'industry', '')) = '' then
    if v_industry <> '' then
      v_fills := v_fills || jsonb_build_object('industry', v_industry);
    end if;
  end if;
  if p_destination_type = 'vendor' then
    if btrim(coalesce(v_source->>'region', '')) <> '' and (v_convert or btrim(coalesce(v_destination->>'region', '')) = '') then
      v_fills := v_fills || jsonb_build_object('region', btrim(v_source->>'region'));
    end if;
    if btrim(coalesce(v_source->>'email', '')) <> '' and (v_convert or btrim(coalesce(v_destination->>'email', '')) = '') then
      v_fills := v_fills || jsonb_build_object('email', btrim(v_source->>'email'));
    end if;
    if btrim(coalesce(v_source->>'phone', '')) <> '' and (v_convert or btrim(coalesce(v_destination->>'phone', '')) = '') then
      v_fills := v_fills || jsonb_build_object('phone', btrim(v_source->>'phone'));
    end if;
  elsif p_destination_type = 'manufacturer' and p_source_type = 'manufacturer' then
    if btrim(coalesce(v_source->>'end_product', '')) <> '' and (v_convert or btrim(coalesce(v_destination->>'end_product', '')) = '') then
      v_fills := v_fills || jsonb_build_object('end_product', btrim(v_source->>'end_product'));
    end if;
  end if;

  v_destination_tags := case when v_convert then '{}'::text[] else coalesce(array(select jsonb_array_elements_text(
    case when jsonb_typeof(v_destination->'tags') = 'array' then v_destination->'tags' else '[]'::jsonb end)), '{}') end;
  v_tags_added := array(
    select distinct t
    from jsonb_array_elements_text(case when jsonb_typeof(v_source->'tags') = 'array' then v_source->'tags' else '[]'::jsonb end) as t
    where t <> '__deleted' and t not like '\_\_import\_batch%' and not t = any(v_destination_tags)
      and (p_destination_type = 'manufacturer' or t <> '__finder_skip')
  );

  select jsonb_build_object(
    'manufacturing_sites', (select count(*) from public.manufacturing_sites as s where p_source_type = 'manufacturer' and s.manufacturer_id = p_source_id),
    'linkedin_outreach_contacts', (select count(*) from public.linkedin_outreach_contacts as o where p_source_type = 'manufacturer' and o.manufacturer_id = p_source_id),
    'email_campaigns', (select count(*) from public.email_campaigns as e where p_source_type = 'manufacturer' and e.manufacturer_id = p_source_id)
  ) into v_related;
  v_related := v_related || jsonb_build_object('action',
    case when p_source_type = 'manufacturer' and p_destination_type = 'manufacturer' and not v_convert then 'repoint_to_destination'
         when p_source_type = 'manufacturer' then 'stay_linked_to_archived_source'
         else 'none' end);
  if p_source_type = 'manufacturer' and p_destination_type <> 'manufacturer'
    and ((v_related->>'manufacturing_sites')::int + (v_related->>'linkedin_outreach_contacts')::int + (v_related->>'email_campaigns')::int) > 0 then
    v_warnings := v_warnings || text 'Manufacturer-only linked rows (sites, LinkedIn outreach, email campaigns) stay linked to the archived source manufacturer';
  end if;
  if private.crm_notes_has_images(v_source_notes) then
    v_warnings := v_warnings || text 'Source notes contain pasted images; they are carried over as-is';
  end if;

  return jsonb_build_object(
    'mode', case when v_convert then 'convert' else 'merge' end,
    'cross_type', v_convert or p_source_type <> p_destination_type,
    'source', private.crm_company_summary(p_source_type, v_source),
    'destination', case when v_convert
      then jsonb_build_object('company_type', p_destination_type, 'company_name', v_source->>'company', 'will_be_created', true)
      else private.crm_company_summary(p_destination_type, v_destination) end,
    'contacts', v_contacts,
    'inline_person', v_inline,
    'activity_count', (select count(*) from public.activities as a
      where a.contact_type = p_source_type and a.contact_id = p_source_id and private.crm_task_marker(a.created_by) is null),
    'open_task_count', (select count(*) from public.activities as a
      where a.contact_type = p_source_type and a.contact_id = p_source_id and private.crm_task_marker(a.created_by)->>'state' = 'open'),
    'done_task_count', (select count(*) from public.activities as a
      where a.contact_type = p_source_type and a.contact_id = p_source_id and private.crm_task_marker(a.created_by)->>'state' = 'done'),
    'notes', jsonb_build_object(
      'source_has_notes', btrim(coalesce(v_source_notes, '')) <> '',
      'action', case when v_convert then 'copied' when btrim(coalesce(v_source_notes, '')) <> '' or cardinality(v_extra_lines) > 0 then 'appended_with_merge_header' else 'none' end,
      'extra_lines', to_jsonb(v_extra_lines)),
    'stage', jsonb_build_object('source', v_source->>'stage',
      'result', case when v_convert then coalesce(private.crm_canonical_stage(v_source->>'stage'), 'Prospect') else v_destination->>'stage' end),
    'last_contact', greatest((v_source->>'last_contact')::date, (v_destination->>'last_contact')::date),
    'field_fills', v_fills,
    'tags_added', to_jsonb(v_tags_added),
    'aliases_moved', (select coalesce(jsonb_agg(al.alias order by al.id), '[]'::jsonb) from public.crm_company_aliases as al
      where al.company_type = p_source_type and al.company_id = p_source_id),
    'source_name_added_as_alias', not v_convert
      and private.normalize_crm_company_words(v_source->>'company') <> private.normalize_crm_company_words(v_destination->>'company'),
    'related_rows', v_related,
    'source_after_merge', 'archived',
    'warnings', to_jsonb(v_warnings)
  );
end;
$function$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

create or replace function public.mcp_preview_crm_company_merge(
  p_source_company_type text,
  p_source_company_id bigint,
  p_expected_source_company_name text,
  p_destination_company_type text,
  p_destination_company_id bigint,
  p_expected_destination_company_name text,
  p_allow_cross_type boolean,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_actor text := private.mcp_require_actor(p_actor);
  v_source jsonb;
  v_destination jsonb;
  v_source_type text;
  v_destination_type text := lower(btrim(coalesce(p_destination_company_type, '')));
  v_cross boolean;
  v_plan jsonb;
  v_token uuid;
  v_expires timestamp with time zone := now() + interval '30 minutes';
begin
  v_source := private.crm_lock_company(p_source_company_type, p_source_company_id, p_expected_source_company_name);
  v_source_type := v_source->>'_type';
  if (v_source->>'_archived')::boolean then
    raise exception 'Source CRM % company % is already archived', v_source_type, p_source_company_id using errcode = '22023';
  end if;
  if v_destination_type not in ('manufacturer', 'vendor') then
    raise exception 'Merge destination must be a manufacturer or vendor' using errcode = '22023';
  end if;
  if p_destination_company_id is not null then
    if v_destination_type = v_source_type and p_destination_company_id = p_source_company_id then
      raise exception 'Source and destination company are the same' using errcode = '22023';
    end if;
    v_destination := private.crm_lock_company(v_destination_type, p_destination_company_id, p_expected_destination_company_name);
    if (v_destination->>'_archived')::boolean then
      raise exception 'Destination CRM % company % is archived', v_destination_type, p_destination_company_id using errcode = '22023';
    end if;
  elsif v_destination_type = v_source_type then
    raise exception 'A destination company id is required unless converting to the other company type' using errcode = '22023';
  end if;

  v_cross := p_destination_company_id is null or v_source_type <> v_destination_type;
  v_plan := private.crm_merge_plan(v_source_type, p_source_company_id, v_destination_type, p_destination_company_id);
  if v_cross and not coalesce(p_allow_cross_type, false) then
    return jsonb_build_object('ok', false, 'status', 'refused',
      'reason', 'This merge changes the company type. Review the plan with the user and preview again with allow_cross_type=true only if they confirm.',
      'plan', v_plan);
  end if;

  insert into private.crm_merge_previews (
    actor, source_type, source_id, source_name, destination_type, destination_id, destination_name,
    allow_cross_type, fingerprint, plan, expires_at
  ) values (
    v_actor, v_source_type, p_source_company_id, v_source->>'company', v_destination_type, p_destination_company_id,
    v_destination->>'company', coalesce(p_allow_cross_type, false),
    private.crm_merge_fingerprint(v_source_type, p_source_company_id, v_destination_type, p_destination_company_id),
    v_plan, v_expires
  )
  returning merge_token into v_token;

  return jsonb_build_object('ok', true, 'status', 'preview_ready', 'merge_token', v_token,
    'expires_at', v_expires, 'plan', v_plan);
end;
$function$;

create or replace function public.mcp_merge_crm_companies(
  p_operation_id uuid,
  p_merge_token uuid,
  p_source_company_type text,
  p_source_company_id bigint,
  p_expected_source_company_name text,
  p_destination_company_type text,
  p_destination_company_id bigint,
  p_expected_destination_company_name text,
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
  v_preview private.crm_merge_previews%rowtype;
  v_source jsonb;
  v_destination jsonb;
  v_source_type text;
  v_destination_type text;
  v_destination_id bigint;
  v_plan jsonb;
  v_item jsonb;
  v_contact jsonb;
  v_existing jsonb;
  v_new_id bigint;
  v_moved_contacts jsonb := '[]'::jsonb;
  v_activity_ids bigint[];
  v_notes text;
  v_addition text;
  v_tags text[];
  v_source_tags text[];
  v_alias_key text;
  v_aliases_added jsonb := '[]'::jsonb;
  v_source_contacts_before jsonb;
  v_destination_before jsonb;
  v_result jsonb;
  v_contact_table text;
begin
  if not coalesce(p_confirm, false) then
    raise exception 'Merges require confirm_merge=true after the user approved the preview' using errcode = '22023';
  end if;
  if p_merge_token is null then
    raise exception 'A merge token from preview_crm_company_merge is required' using errcode = '22023';
  end if;
  v_fingerprint := md5(jsonb_build_object('token', p_merge_token,
    'source_type', lower(btrim(coalesce(p_source_company_type, ''))), 'source_id', p_source_company_id,
    'source_name', lower(btrim(coalesce(p_expected_source_company_name, ''))),
    'destination_type', lower(btrim(coalesce(p_destination_company_type, ''))), 'destination_id', p_destination_company_id,
    'destination_name', lower(btrim(coalesce(p_expected_destination_company_name, ''))))::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'merge_companies', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;

  select preview.* into v_preview
  from private.crm_merge_previews as preview
  where preview.merge_token = p_merge_token and preview.actor = v_actor
  for update;
  if not found then
    raise exception 'Unknown merge token' using errcode = '22023';
  end if;
  if v_preview.consumed_at is not null then
    raise exception 'This merge token was already used by operation %', v_preview.consumed_operation_id
      using errcode = '22023';
  end if;
  if v_preview.source_type <> lower(btrim(coalesce(p_source_company_type, '')))
    or v_preview.source_id <> p_source_company_id
    or v_preview.destination_type <> lower(btrim(coalesce(p_destination_company_type, '')))
    or v_preview.destination_id is distinct from p_destination_company_id then
    raise exception 'Merge arguments do not match the previewed merge' using errcode = '22023';
  end if;
  if v_preview.expires_at < now() then
    return jsonb_build_object('ok', false, 'status', 'preview_expired', 'changed', false,
      'reason', 'The merge preview expired; preview again and confirm with the user', 'replayed', false);
  end if;

  v_source_type := v_preview.source_type;
  v_destination_type := v_preview.destination_type;
  if p_destination_company_id is null or (v_source_type, p_source_company_id) < (v_destination_type, p_destination_company_id) then
    v_source := private.crm_lock_company(v_source_type, p_source_company_id, p_expected_source_company_name);
    if p_destination_company_id is not null then
      v_destination := private.crm_lock_company(v_destination_type, p_destination_company_id, p_expected_destination_company_name);
    end if;
  else
    v_destination := private.crm_lock_company(v_destination_type, p_destination_company_id, p_expected_destination_company_name);
    v_source := private.crm_lock_company(v_source_type, p_source_company_id, p_expected_source_company_name);
  end if;
  if (v_source->>'_archived')::boolean or coalesce((v_destination->>'_archived')::boolean, false) then
    raise exception 'A company in this merge is archived' using errcode = '22023';
  end if;

  if private.crm_merge_fingerprint(v_source_type, p_source_company_id, v_destination_type, p_destination_company_id)
    <> v_preview.fingerprint then
    return jsonb_build_object('ok', false, 'status', 'preview_stale', 'changed', false,
      'reason', 'One of the companies changed after the preview; preview again and confirm with the user', 'replayed', false);
  end if;

  v_plan := private.crm_merge_plan(v_source_type, p_source_company_id, v_destination_type, p_destination_company_id);
  v_source_contacts_before := private.crm_company_contacts_json(v_source_type, p_source_company_id);
  v_destination_before := case when p_destination_company_id is null then null
    else private.crm_audit_row(v_destination - '_type' - '_archived') end;
  v_source_tags := coalesce(array(select jsonb_array_elements_text(
    case when jsonb_typeof(v_source->'tags') = 'array' then v_source->'tags' else '[]'::jsonb end)), '{}');

  -- Destination record: existing, or created for a type conversion.
  if p_destination_company_id is null then
    v_notes := private.crm_notes_append_plain(private.crm_company_notes(v_source_type, v_source),
      array_to_string(array(select jsonb_array_elements_text(v_plan->'notes'->'extra_lines')), E'\n'));
    if v_destination_type = 'manufacturer' then
      insert into public.manufacturers (company, stage, industry, end_product, signals, tags, last_contact)
      values (v_source->>'company', v_plan->'stage'->>'result', coalesce(v_plan->'field_fills'->>'industry', ''),
        v_plan->'field_fills'->>'end_product', coalesce(v_notes, ''),
        array(select jsonb_array_elements_text(v_plan->'tags_added')), (v_source->>'last_contact')::date)
      returning id into v_destination_id;
    else
      insert into public.vendors (company, stage, industry, region, email, phone, notes, tags, last_contact)
      values (v_source->>'company', v_plan->'stage'->>'result', v_plan->'field_fills'->>'industry',
        v_plan->'field_fills'->>'region', v_plan->'field_fills'->>'email', v_plan->'field_fills'->>'phone',
        coalesce(v_notes, ''), array(select jsonb_array_elements_text(v_plan->'tags_added')), (v_source->>'last_contact')::date)
      returning id into v_destination_id;
    end if;
  else
    v_destination_id := p_destination_company_id;
    v_notes := private.crm_company_notes(v_destination_type, v_destination);
    if (v_plan->'notes'->>'action') = 'appended_with_merge_header' then
      v_addition := private.crm_notes_append_notes(
        format('Merged from %s (%s %s) on %s:', v_source->>'company', v_source_type, p_source_company_id, private.crm_toronto_today()),
        private.crm_company_notes(v_source_type, v_source));
      v_addition := private.crm_notes_append_plain(v_addition,
        array_to_string(array(select jsonb_array_elements_text(v_plan->'notes'->'extra_lines')), E'\n'));
      v_notes := private.crm_notes_append_notes(v_notes, v_addition);
    end if;
    v_tags := coalesce(array(select jsonb_array_elements_text(
      case when jsonb_typeof(v_destination->'tags') = 'array' then v_destination->'tags' else '[]'::jsonb end)), '{}')
      || array(select jsonb_array_elements_text(v_plan->'tags_added'));
    if v_destination_type = 'manufacturer' then
      update public.manufacturers as m
      set signals = v_notes,
        tags = v_tags,
        industry = coalesce(v_plan->'field_fills'->>'industry', m.industry),
        end_product = coalesce(v_plan->'field_fills'->>'end_product', m.end_product),
        last_contact = greatest(m.last_contact, (v_source->>'last_contact')::date)
      where m.id = v_destination_id;
    else
      update public.vendors as v
      set notes = v_notes,
        tags = v_tags,
        industry = coalesce(v_plan->'field_fills'->>'industry', v.industry),
        region = coalesce(v_plan->'field_fills'->>'region', v.region),
        email = coalesce(v_plan->'field_fills'->>'email', v.email),
        phone = coalesce(v_plan->'field_fills'->>'phone', v.phone),
        last_contact = greatest(v.last_contact, (v_source->>'last_contact')::date)
      where v.id = v_destination_id;
    end if;
  end if;

  -- Contacts.
  for v_item in select value from jsonb_array_elements(v_plan->'contacts') loop
    v_contact := v_item->'contact';
    v_contact_table := v_contact->>'contact_table';
    if v_item->>'action' = 'move' then
      if v_contact_table = 'manufacturer_contacts' then
        update public.manufacturer_contacts as c set manufacturer_id = v_destination_id where c.id = (v_contact->>'contact_id')::bigint;
      else
        update public.vendor_contacts as c set vendor_id = v_destination_id where c.id = (v_contact->>'contact_id')::bigint;
      end if;
      v_new_id := (v_contact->>'contact_id')::bigint;
    else
      v_new_id := null;
      if v_item->>'action' = 'recreate_at_destination_and_archive_original' then
        if v_destination_type = 'manufacturer' then
          insert into public.manufacturer_contacts (manufacturer_id, name, title, linkedin)
          values (v_destination_id, v_contact->>'name', coalesce(v_contact->>'title', ''), coalesce(v_contact->>'linkedin', ''))
          returning id into v_new_id;
        else
          insert into public.vendor_contacts (vendor_id, name, title, linkedin)
          values (v_destination_id, v_contact->>'name', coalesce(v_contact->>'title', ''), coalesce(v_contact->>'linkedin', ''))
          returning id into v_new_id;
        end if;
      elsif v_item->>'action' = 'merge_into_existing_contact' then
        v_existing := v_item->'existing_destination_contact';
        v_new_id := (v_existing->>'contact_id')::bigint;
        -- Fill blank title/LinkedIn on the surviving contact; never overwrite.
        if v_existing->>'contact_table' = 'manufacturer_contacts' then
          update public.manufacturer_contacts as c
          set title = case when btrim(coalesce(c.title, '')) = '' then coalesce(v_contact->>'title', '') else c.title end,
            linkedin = case when btrim(coalesce(c.linkedin, '')) = '' then coalesce(v_contact->>'linkedin', '') else c.linkedin end
          where c.id = v_new_id;
        else
          update public.vendor_contacts as c
          set title = case when btrim(coalesce(c.title, '')) = '' then coalesce(v_contact->>'title', '') else c.title end,
            linkedin = case when btrim(coalesce(c.linkedin, '')) = '' then coalesce(v_contact->>'linkedin', '') else c.linkedin end
          where c.id = v_new_id;
        end if;
      end if;
      insert into private.crm_archived_contacts (
        contact_table, contact_id, company_type, company_id, company_name, row_data, reason, archived_by,
        archive_operation_id, restored_at, restored_by, restore_operation_id
      )
      select v_contact_table, (v_contact->>'contact_id')::bigint, v_source_type, p_source_company_id,
        v_source->>'company', original.c, format('Merge into %s %s: %s', v_destination_type, v_destination_id, v_item->>'action'),
        v_actor, p_operation_id,
        case when v_new_id is not null then now() end, case when v_new_id is not null then v_actor end,
        case when v_new_id is not null then p_operation_id end
      from (
        select to_jsonb(mc) as c from public.manufacturer_contacts as mc
        where v_contact_table = 'manufacturer_contacts' and mc.id = (v_contact->>'contact_id')::bigint
        union all
        select to_jsonb(vc) from public.vendor_contacts as vc
        where v_contact_table = 'vendor_contacts' and vc.id = (v_contact->>'contact_id')::bigint
      ) as original(c);
      if v_contact_table = 'manufacturer_contacts' then
        delete from public.manufacturer_contacts as c where c.id = (v_contact->>'contact_id')::bigint;
      else
        delete from public.vendor_contacts as c where c.id = (v_contact->>'contact_id')::bigint;
      end if;
    end if;
    v_moved_contacts := v_moved_contacts || jsonb_build_object('from_contact_id', (v_contact->>'contact_id')::bigint,
      'name', v_contact->>'name', 'action', v_item->>'action', 'destination_contact_id', v_new_id);
  end loop;

  if (v_plan->'inline_person'->>'action') = 'create_contact_at_destination' then
    if v_destination_type = 'manufacturer' then
      insert into public.manufacturer_contacts (manufacturer_id, name, title, linkedin)
      values (v_destination_id, v_plan->'inline_person'->>'name', v_plan->'inline_person'->>'title', '')
      returning id into v_new_id;
    else
      insert into public.vendor_contacts (vendor_id, name, title, linkedin)
      values (v_destination_id, v_plan->'inline_person'->>'name', v_plan->'inline_person'->>'title', '')
      returning id into v_new_id;
    end if;
    v_moved_contacts := v_moved_contacts || jsonb_build_object('from_contact_id', null,
      'name', v_plan->'inline_person'->>'name', 'action', 'created_from_inline_person', 'destination_contact_id', v_new_id);
  end if;

  -- Activities and tasks keep their ids and all history.
  select coalesce(array_agg(a.id order by a.id), '{}') into v_activity_ids
  from public.activities as a
  where a.contact_type = v_source_type and a.contact_id = p_source_company_id;
  update public.activities as a
  set contact_type = v_destination_type, contact_id = v_destination_id
  where a.contact_type = v_source_type and a.contact_id = p_source_company_id;

  -- Aliases: move the source's aliases and remember the source name.
  delete from public.crm_company_aliases as al
  where al.company_type = v_source_type and al.company_id = p_source_company_id
    and exists (select 1 from public.crm_company_aliases as d
      where d.company_type = v_destination_type and d.company_id = v_destination_id and d.alias_key = al.alias_key);
  update public.crm_company_aliases as al
  set company_type = v_destination_type, company_id = v_destination_id
  where al.company_type = v_source_type and al.company_id = p_source_company_id;
  if (v_plan->>'source_name_added_as_alias')::boolean then
    v_alias_key := replace(private.normalize_crm_company_words(v_source->>'company'), ' ', '');
    insert into public.crm_company_aliases (company_type, company_id, alias, alias_key, created_by)
    values (v_destination_type, v_destination_id, v_source->>'company', v_alias_key, v_actor)
    on conflict on constraint crm_company_aliases_unique do nothing;
    if found then
      v_aliases_added := v_aliases_added || to_jsonb(v_source->>'company');
    end if;
  end if;

  if (v_plan->'related_rows'->>'action') = 'repoint_to_destination' then
    update public.manufacturing_sites as s set manufacturer_id = v_destination_id where s.manufacturer_id = p_source_company_id;
    update public.linkedin_outreach_contacts as o set manufacturer_id = v_destination_id where o.manufacturer_id = p_source_company_id;
    update public.email_campaigns as e set manufacturer_id = v_destination_id where e.manufacturer_id = p_source_company_id;
  end if;

  -- Archive the source with the same soft delete the CRM website uses.
  v_source_tags := v_source_tags || text '__deleted';
  if v_source_type = 'manufacturer' then
    if not '__finder_skip' = any(v_source_tags) then
      v_source_tags := v_source_tags || text '__finder_skip';
    end if;
    update public.manufacturers as m set tags = v_source_tags, stage = 'Closed Lost' where m.id = p_source_company_id;
  elsif v_source_type = 'vendor' then
    update public.vendors as v set tags = v_source_tags where v.id = p_source_company_id;
  else
    update public.lost_contacts as l set tags = v_source_tags where l.id = p_source_company_id;
  end if;

  update private.crm_merge_previews as preview
  set consumed_at = now(), consumed_operation_id = p_operation_id
  where preview.merge_token = p_merge_token;

  v_result := jsonb_build_object('ok', true, 'status', 'merged', 'changed', true,
    'mode', v_plan->>'mode',
    'destination_company', private.crm_company_summary(v_destination_type, private.crm_company_row(v_destination_type, v_destination_id, false)),
    'source_company', private.crm_company_summary(v_source_type, private.crm_company_row(v_source_type, p_source_company_id, false)),
    'contacts', v_moved_contacts,
    'activities_and_tasks_moved', cardinality(v_activity_ids),
    'aliases_added', v_aliases_added,
    'related_rows', v_plan->'related_rows',
    'warnings', v_plan->'warnings');
  return private.mcp_operation_record(v_actor, p_operation_id, 'merge_companies', v_fingerprint,
    v_source_type, p_source_company_id,
    jsonb_build_object('source', private.crm_audit_row(v_source - '_type' - '_archived'),
      'destination', v_destination_before, 'source_contacts', v_source_contacts_before,
      'moved_activity_ids', to_jsonb(v_activity_ids), 'plan', v_plan),
    jsonb_build_object('destination_type', v_destination_type, 'destination_id', v_destination_id),
    v_result);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Search and reads
-- ---------------------------------------------------------------------------

create or replace function private.crm_company_query_score(
  p_name text,
  p_query_key text,
  p_query_tokens text[],
  p_raw_query text
)
returns integer
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_words text;
  v_key text;
  v_token text;
begin
  if coalesce(p_query_key, '') = '' or coalesce(p_name, '') = '' then
    return 0;
  end if;
  v_words := private.normalize_crm_company_words(p_name);
  v_key := replace(v_words, ' ', '');
  if v_key = p_query_key then
    return 100;
  end if;
  if left(v_key, length(p_query_key)) = p_query_key then
    return 80;
  end if;
  if position(p_query_key in v_key) > 0 then
    return 60;
  end if;
  if coalesce(cardinality(p_query_tokens), 0) > 0 then
    foreach v_token in array p_query_tokens loop
      if position(' ' || v_token in ' ' || v_words) = 0 then
        v_token := null;
        exit;
      end if;
    end loop;
    if v_token is not null then
      return 40;
    end if;
  end if;
  if length(coalesce(p_raw_query, '')) >= 2 and position(lower(p_raw_query) in lower(p_name)) > 0 then
    return 20;
  end if;
  return 0;
end;
$function$;

create or replace function private.crm_person_query_matches(
  p_name text,
  p_title text,
  p_linkedin text,
  p_query_norm text,
  p_query_tokens text[],
  p_query_linkedin text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_name text;
  v_token text;
begin
  if coalesce(p_query_linkedin, '') <> '' then
    return coalesce(private.normalize_linkedin_profile_url(p_linkedin), '') = p_query_linkedin;
  end if;
  if coalesce(p_query_norm, '') = '' then
    return false;
  end if;
  v_name := ' ' || private.normalize_crm_person_name(p_name);
  if coalesce(cardinality(p_query_tokens), 0) > 0 and btrim(v_name) <> '' then
    foreach v_token in array p_query_tokens loop
      if position(' ' || v_token in v_name) = 0 then
        v_name := null;
        exit;
      end if;
    end loop;
    if v_name is not null then
      return true;
    end if;
  end if;
  return length(p_query_norm) >= 3 and position(p_query_norm in private.normalize_crm_person_name(p_title)) > 0;
end;
$function$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

create or replace function public.mcp_search_crm_companies(
  p_company_query text,
  p_person_query text,
  p_company_id bigint,
  p_company_type text,
  p_include_archived boolean,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_type text := nullif(lower(btrim(coalesce(p_company_type, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_company_query text := nullif(btrim(coalesce(p_company_query, '')), '');
  v_person_query text := nullif(btrim(coalesce(p_person_query, '')), '');
  v_company_key text;
  v_company_tokens text[];
  v_person_norm text;
  v_person_tokens text[];
  v_person_linkedin text;
  v_result jsonb;
begin
  if v_type is not null and v_type not in ('manufacturer', 'vendor', 'lost') then
    raise exception 'Company type must be manufacturer, vendor, or lost' using errcode = '22023';
  end if;
  if p_company_id is not null and v_type is null then
    raise exception 'company_type is required with company_id' using errcode = '22023';
  end if;
  if v_company_query is null and v_person_query is null and p_company_id is null then
    raise exception 'Provide a company name, person name, or exact company id' using errcode = '22023';
  end if;
  if v_company_query is not null then
    v_company_key := replace(private.normalize_crm_company_words(v_company_query), ' ', '');
    v_company_tokens := array(
      select t from unnest(string_to_array(private.normalize_crm_company_words(v_company_query), ' ')) as t
      where length(t) >= 2 and t not in ('and', 'the', 'of')
    );
    if v_company_key = '' then
      v_company_key := lower(v_company_query);
    end if;
  end if;
  if v_person_query is not null then
    if v_person_query ilike '%linkedin.com/in/%' then
      v_person_linkedin := private.normalize_linkedin_profile_url(v_person_query);
    end if;
    v_person_norm := private.normalize_crm_person_name(v_person_query);
    -- Single letters are treated as middle initials and ignored, so
    -- "Simon Abrams" finds "Simon C. Abrams".
    v_person_tokens := array(select t from unnest(string_to_array(v_person_norm, ' ')) as t where length(t) >= 2);
    if cardinality(v_person_tokens) = 0 then
      v_person_tokens := array(select t from unnest(string_to_array(v_person_norm, ' ')) as t where t <> '');
    end if;
  end if;

  with companies as (
    select m.id, 'manufacturer'::text as type, m.company, m.last_contact, m.stage,
      coalesce('__deleted' = any(m.tags), false) as archived
    from public.manufacturers as m
    where (v_type is null or v_type = 'manufacturer') and (p_company_id is null or m.id = p_company_id)
    union all
    select v.id, 'vendor'::text, v.company, v.last_contact, v.stage, coalesce('__deleted' = any(v.tags), false)
    from public.vendors as v
    where (v_type is null or v_type = 'vendor') and (p_company_id is null or v.id = p_company_id)
    union all
    select l.id, 'lost'::text, l.company, l.last_contact, null::text, coalesce('__deleted' = any(l.tags), false)
    from public.lost_contacts as l
    where (v_type is null or v_type = 'lost') and (p_company_id is null or l.id = p_company_id)
  ),
  scoped as (
    select c.* from companies as c
    where coalesce(p_include_archived, false) or not c.archived
  ),
  name_scores as (
    select s.*,
      case when v_company_query is null then 0
        else private.crm_company_query_score(s.company, v_company_key, v_company_tokens, v_company_query) end as name_score
    from scoped as s
  ),
  alias_scores as (
    select al.company_type as type, al.company_id as id, al.alias,
      private.crm_company_query_score(al.alias, v_company_key, v_company_tokens, v_company_query) as alias_score
    from public.crm_company_aliases as al
    where v_company_query is not null
  ),
  best_alias as (
    select distinct on (a.type, a.id) a.type, a.id, a.alias, a.alias_score
    from alias_scores as a
    where a.alias_score > 0
    order by a.type, a.id, a.alias_score desc
  ),
  company_hits as (
    select n.*, greatest(n.name_score, coalesce(b.alias_score, 0)) as score,
      case when coalesce(b.alias_score, 0) > n.name_score then b.alias end as matched_alias
    from name_scores as n
    left join best_alias as b on b.type = n.type and b.id = n.id
  ),
  people as (
    select 'manufacturer'::text as type, mc.manufacturer_id as id, mc.name, mc.title
    from public.manufacturer_contacts as mc
    where v_person_query is not null
      and (v_type is null or v_type = 'manufacturer')
      and private.crm_person_query_matches(mc.name, mc.title, mc.linkedin, v_person_norm, v_person_tokens, v_person_linkedin)
    union all
    select 'vendor'::text, vc.vendor_id, vc.name, vc.title
    from public.vendor_contacts as vc
    where v_person_query is not null
      and (v_type is null or v_type = 'vendor')
      and private.crm_person_query_matches(vc.name, vc.title, vc.linkedin, v_person_norm, v_person_tokens, v_person_linkedin)
    union all
    select 'vendor'::text, v.id, v.name, v.title
    from public.vendors as v
    where v_person_query is not null and coalesce(v_person_linkedin, '') = ''
      and (v_type is null or v_type = 'vendor') and btrim(coalesce(v.name, '') || coalesce(v.title, '')) <> ''
      and private.crm_person_query_matches(v.name, v.title, null, v_person_norm, v_person_tokens, null)
    union all
    select 'lost'::text, l.id, l.name, l.title
    from public.lost_contacts as l
    where v_person_query is not null and coalesce(v_person_linkedin, '') = ''
      and (v_type is null or v_type = 'lost') and btrim(coalesce(l.name, '') || coalesce(l.title, '')) <> ''
      and private.crm_person_query_matches(l.name, l.title, null, v_person_norm, v_person_tokens, null)
  ),
  people_by_company as (
    select p.type, p.id,
      jsonb_agg(distinct jsonb_build_object('name', btrim(coalesce(p.name, '')), 'title', nullif(btrim(coalesce(p.title, '')), ''))) as people
    from people as p
    group by p.type, p.id
  ),
  candidates as (
    select h.id, h.type, h.company, h.last_contact, h.stage, h.archived, h.score, h.matched_alias,
      coalesce(p.people, '[]'::jsonb) as people
    from company_hits as h
    left join people_by_company as p on p.type = h.type and p.id = h.id
    where (v_company_query is null or h.score > 0)
      and (v_person_query is null or p.people is not null)
      and btrim(coalesce(h.company, '')) <> ''
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'company_id', c.id,
    'company_type', c.type,
    'company_name', btrim(c.company),
    'last_contact', c.last_contact,
    'stage', c.stage,
    'archived', c.archived,
    'matched_alias', c.matched_alias,
    'matched_people', c.people
  ) order by c.score desc, c.archived, c.last_contact desc nulls last, c.company), '[]'::jsonb)
  into v_result
  from (
    select * from candidates
    order by score desc, archived, last_contact desc nulls last, company
    limit v_limit
  ) as c;
  return v_result;
end;
$function$;

create or replace function public.mcp_get_crm_company_extras(
  p_company_type text,
  p_company_id bigint,
  p_include_archived boolean
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_type text := lower(btrim(coalesce(p_company_type, '')));
  v_row jsonb;
begin
  if v_type not in ('manufacturer', 'vendor', 'lost') then
    raise exception 'Company type must be manufacturer, vendor, or lost' using errcode = '22023';
  end if;
  v_row := private.crm_company_row(v_type, p_company_id, false);
  if v_row is null then
    raise exception 'No CRM % company exists with id %', v_type, p_company_id using errcode = '23503';
  end if;
  return jsonb_build_object(
    'company', private.crm_company_summary(v_type, v_row),
    'created_at', v_row->>'created_at',
    'notes_sha256', private.crm_text_sha256(private.crm_company_notes(v_type, v_row)),
    'notes_has_images', private.crm_notes_has_images(private.crm_company_notes(v_type, v_row)),
    'inline_person', case when v_type in ('vendor', 'lost') then jsonb_build_object('name', v_row->>'name', 'title', v_row->>'title') end,
    'manufacturer_details', case when v_type = 'manufacturer' then jsonb_build_object(
      'end_product', v_row->>'end_product', 'machines', v_row->>'machines',
      'maintenance_needed', v_row->>'maintenance_needed') end,
    'aliases', (select coalesce(jsonb_agg(al.alias order by al.alias), '[]'::jsonb)
      from public.crm_company_aliases as al where al.company_type = v_type and al.company_id = p_company_id),
    'possible_duplicates', private.crm_company_name_matches(v_row->>'company', v_type, p_company_id),
    'archived_contacts', case when coalesce(p_include_archived, false) then (
      select coalesce(jsonb_agg(jsonb_build_object('contact_id', ac.contact_id, 'name', ac.row_data->>'name',
        'title', nullif(ac.row_data->>'title', ''), 'linkedin_url', nullif(ac.row_data->>'linkedin', ''),
        'reason', ac.reason, 'archived_at', ac.archived_at) order by ac.archived_at desc), '[]'::jsonb)
      from private.crm_archived_contacts as ac
      where ac.company_type = v_type and ac.company_id = p_company_id and ac.restored_at is null) end,
    'voided_activities', case when coalesce(p_include_archived, false) then (
      select coalesce(jsonb_agg(jsonb_build_object('activity_id', aa.activity_id, 'activity_type', aa.row_data->>'type',
        'activity_date', aa.row_data->>'date', 'activity_note', aa.row_data->>'note',
        'performed_by', aa.row_data->>'created_by', 'reason', aa.reason, 'voided_at', aa.archived_at)
        order by aa.archived_at desc), '[]'::jsonb)
      from private.crm_archived_activities as aa
      where aa.company_type = v_type and aa.company_id = p_company_id and aa.restored_at is null and not aa.is_task) end,
    'archived_tasks', case when coalesce(p_include_archived, false) then (
      select coalesce(jsonb_agg(private.crm_task_summary(aa.row_data) || jsonb_build_object('reason', aa.reason,
        'archived_at', aa.archived_at) order by aa.archived_at desc), '[]'::jsonb)
      from private.crm_archived_activities as aa
      where aa.company_type = v_type and aa.company_id = p_company_id and aa.restored_at is null and aa.is_task) end
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- LinkedIn "Contacts to Connect With" list
-- ---------------------------------------------------------------------------

create or replace function public.mcp_mark_crm_connect_contact_connected(
  p_operation_id uuid,
  p_connect_contact_id bigint,
  p_expected_contact_name text,
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
  v_row public.linkedin_outreach_contacts%rowtype;
  v_status text;
  v_result jsonb;
begin
  v_fingerprint := md5(jsonb_build_object('id', p_connect_contact_id,
    'name', lower(btrim(coalesce(p_expected_contact_name, ''))))::text);
  v_replay := private.mcp_operation_replay(v_actor, p_operation_id, 'mark_connect_contact_connected', v_fingerprint);
  if v_replay is not null then
    return v_replay;
  end if;
  select o.* into v_row from public.linkedin_outreach_contacts as o where o.id = p_connect_contact_id for update;
  if not found then
    raise exception 'Connect-list contact % does not exist', p_connect_contact_id using errcode = '23503';
  end if;
  if lower(btrim(coalesce(v_row.contact_name, ''))) <> lower(btrim(coalesce(p_expected_contact_name, ''))) then
    raise exception 'Contact name mismatch for connect-list contact %', p_connect_contact_id using errcode = '22023';
  end if;
  if v_row.status = 'new' then
    update public.linkedin_outreach_contacts as o
    set status = 'connected', last_action_at = now(), updated_at = now()
    where o.id = p_connect_contact_id;
    v_status := 'connected';
  else
    v_status := 'not_new';
  end if;
  v_result := jsonb_build_object('ok', true, 'status', v_status, 'changed', v_status = 'connected',
    'connect_contact', jsonb_build_object('connect_contact_id', v_row.id, 'contact_name', v_row.contact_name,
      'company', v_row.company, 'previous_status', v_row.status,
      'status', case when v_status = 'connected' then 'connected' else v_row.status end));
  return private.mcp_operation_record(v_actor, p_operation_id, 'mark_connect_contact_connected', v_fingerprint,
    'linkedin_outreach_contact', p_connect_contact_id,
    jsonb_build_object('status', v_row.status), jsonb_build_object('status', case when v_status = 'connected' then 'connected' else v_row.status end),
    v_result);
end;
$function$;

create or replace function public.mcp_record_crm_write_failure(
  p_actor text,
  p_operation_id uuid,
  p_tool text,
  p_error_code text,
  p_error_message text
)
returns void
language sql
security invoker
set search_path = ''
as $function$
  insert into private.mcp_crm_write_failures (actor, operation_id, tool, error_code, error_message)
  values (left(p_actor, 200), p_operation_id, left(coalesce(p_tool, 'unknown'), 100),
    left(p_error_code, 50), left(coalesce(p_error_message, ''), 2000));
$function$;

-- ---------------------------------------------------------------------------
-- CRM website: conflict-aware notes save (replaces a direct anon table write).
-- ---------------------------------------------------------------------------

create or replace function public.save_crm_company_notes(
  p_company_type text,
  p_company_id bigint,
  p_base_sha256 text,
  p_notes text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_current text;
begin
  if p_company_type = 'manufacturer' then
    select m.signals into v_current from public.manufacturers as m where m.id = p_company_id for update;
  elsif p_company_type = 'vendor' then
    select v.notes into v_current from public.vendors as v where v.id = p_company_id for update;
  else
    raise exception 'Notes can only be saved for manufacturers and vendors' using errcode = '22023';
  end if;
  if not found then
    raise exception 'CRM % company % does not exist', p_company_type, p_company_id using errcode = '23503';
  end if;
  if encode(sha256(convert_to(coalesce(v_current, ''), 'UTF8')), 'hex') <> coalesce(p_base_sha256, '') then
    return jsonb_build_object('saved', false, 'current_notes', coalesce(v_current, ''),
      'current_sha256', encode(sha256(convert_to(coalesce(v_current, ''), 'UTF8')), 'hex'));
  end if;
  -- A trigger may reformat notes on save (Find-a-Million briefs), so return the
  -- value actually stored; the website uses it as its next conflict baseline.
  if p_company_type = 'manufacturer' then
    update public.manufacturers as m set signals = p_notes where m.id = p_company_id
    returning m.signals into v_current;
  else
    update public.vendors as v set notes = p_notes where v.id = p_company_id
    returning v.notes into v_current;
  end if;
  return jsonb_build_object('saved', true,
    'current_sha256', encode(sha256(convert_to(coalesce(v_current, ''), 'UTF8')), 'hex'),
    'stored_notes', case when coalesce(v_current, '') is distinct from coalesce(p_notes, '') then coalesce(v_current, '') end);
end;
$function$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.mcp_update_crm_company(uuid,text,bigint,text,jsonb,text)',
    'public.mcp_set_crm_company_archived(uuid,text,bigint,text,boolean,text,text,text)',
    'public.mcp_update_crm_contact(uuid,text,bigint,text,bigint,text,jsonb,text)',
    'public.mcp_set_crm_contact_archived(uuid,text,bigint,text,bigint,text,boolean,text,text)',
    'public.mcp_move_crm_contact(uuid,text,bigint,text,bigint,text,text,bigint,text,text)',
    'public.mcp_create_crm_task(uuid,text,bigint,text,text,date,text,text)',
    'public.mcp_update_crm_task(uuid,bigint,text,bigint,text,text,jsonb,text)',
    'public.mcp_set_crm_task_state(uuid,bigint,text,bigint,text,text,text,text)',
    'public.mcp_update_crm_activity(uuid,bigint,text,bigint,text,text,jsonb,text)',
    'public.mcp_set_crm_activity_archived(uuid,bigint,text,text,bigint,text,text,boolean,text,text)',
    'public.mcp_preview_crm_company_merge(text,bigint,text,text,bigint,text,boolean,text)',
    'public.mcp_merge_crm_companies(uuid,uuid,text,bigint,text,text,bigint,text,boolean,text)',
    'public.mcp_search_crm_companies(text,text,bigint,text,boolean,integer)',
    'public.mcp_get_crm_company_extras(text,bigint,boolean)',
    'public.mcp_mark_crm_connect_contact_connected(uuid,bigint,text,text)',
    'public.mcp_record_crm_write_failure(text,uuid,text,text,text)',
    'public.create_crm_company(uuid,text,text,text,text,text,text,text,boolean,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$grants$;

revoke all on function public.save_crm_company_notes(text, bigint, text, text) from public;
grant execute on function public.save_crm_company_notes(text, bigint, text, text) to anon, authenticated, service_role;
