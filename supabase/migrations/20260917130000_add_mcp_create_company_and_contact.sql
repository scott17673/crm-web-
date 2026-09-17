create schema if not exists private;

-- Company names are compared on a normalized key so obvious legal-name
-- variations ("Acme Foods Inc." / "ACME Foods Ltd") resolve to one company.
-- Location qualifiers such as "- Brampton Plant" are kept on purpose because
-- the CRM tracks individual plants as separate companies.
create or replace function private.normalize_crm_company_words(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_words text := lower(coalesce(p_name, ''));
  v_previous text;
begin
  v_words := translate(
    v_words,
    'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
    'aaaaaaceeeeiiiinooooouuuuyy'
  );
  v_words := replace(v_words, '&', ' and ');
  v_words := regexp_replace(v_words, '[^a-z0-9]+', ' ', 'g');
  v_words := btrim(regexp_replace(v_words, '\s+', ' ', 'g'));
  v_words := ' ' || regexp_replace(v_words, '^the ', '');
  loop
    v_previous := v_words;
    v_words := regexp_replace(
      v_words,
      ' (inc|incorporated|ltd|limited|ltee|llc|llp|lp|corp|corporation|co|company|plc|ulc|gmbh)$',
      ''
    );
    exit when v_words = v_previous;
  end loop;
  return btrim(v_words);
end;
$function$;

create or replace function private.normalize_crm_person_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select btrim(regexp_replace(
    regexp_replace(
      translate(
        lower(coalesce(p_name, '')),
        'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
        'aaaaaaceeeeiiiinooooouuuuyy'
      ),
      '[^a-z0-9]+', ' ', 'g'
    ),
    '\s+', ' ', 'g'
  ));
$function$;

-- Returns the canonical https://www.linkedin.com/in/<slug> form, '' for a
-- blank value, and null for anything that is not a LinkedIn profile URL.
create or replace function private.normalize_linkedin_profile_url(p_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_url text := lower(btrim(coalesce(p_url, '')));
  v_slug text;
begin
  if v_url = '' then
    return '';
  end if;
  v_url := regexp_replace(v_url, '^https?://', '');
  v_url := regexp_replace(v_url, '[?#].*$', '');
  v_url := regexp_replace(v_url, '^([a-z]{2,3}\.|www\.)?linkedin\.com', 'linkedin.com');
  v_slug := substring(v_url from '^linkedin\.com/in/([^/\s]+)');
  if v_slug is null or v_slug = '' then
    return null;
  end if;
  return 'https://www.linkedin.com/in/' || v_slug;
end;
$function$;

create table if not exists private.mcp_crm_company_operations (
  actor text not null,
  operation_id uuid not null,
  company_type text not null,
  company_name text not null,
  request_fingerprint text not null,
  company_id bigint,
  created_at timestamp with time zone not null default now(),
  primary key (actor, operation_id),
  constraint mcp_crm_company_operations_company_type_check
    check (company_type in ('manufacturer', 'vendor'))
);

create table if not exists private.mcp_crm_contact_operations (
  actor text not null,
  operation_id uuid not null,
  company_id bigint not null,
  company_type text not null,
  company_name text not null,
  request_fingerprint text not null,
  contact_id bigint,
  contact_name text not null,
  contact_title text not null,
  contact_linkedin text not null,
  created_at timestamp with time zone not null default now(),
  primary key (actor, operation_id),
  constraint mcp_crm_contact_operations_company_type_check
    check (company_type in ('manufacturer', 'vendor'))
);

alter table private.mcp_crm_company_operations enable row level security;
alter table private.mcp_crm_contact_operations enable row level security;

revoke all on table private.mcp_crm_company_operations
  from public, anon, authenticated;
revoke all on table private.mcp_crm_contact_operations
  from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on table private.mcp_crm_company_operations
  to service_role;
grant select, insert, update on table private.mcp_crm_contact_operations
  to service_role;

revoke all on function private.normalize_crm_company_words(text)
  from public, anon, authenticated;
revoke all on function private.normalize_crm_person_name(text)
  from public, anon, authenticated;
revoke all on function private.normalize_linkedin_profile_url(text)
  from public, anon, authenticated;
grant execute on function private.normalize_crm_company_words(text)
  to service_role;
grant execute on function private.normalize_crm_person_name(text)
  to service_role;
grant execute on function private.normalize_linkedin_profile_url(text)
  to service_role;

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
  v_words text;
  v_key text;
  v_first_two text;
  v_industry text := btrim(coalesce(p_industry, ''));
  v_region text := btrim(coalesce(p_region, ''));
  v_website text := btrim(coalesce(p_website, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
  v_stage text;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_fingerprint text;
  v_existing private.mcp_crm_company_operations%rowtype;
  v_candidates jsonb;
  v_has_exact boolean;
  v_has_similar boolean;
  v_company_id bigint;
  v_company_notes text;
  v_today date := (now() at time zone 'America/Toronto')::date;
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

  v_words := private.normalize_crm_company_words(v_company_name);
  v_key := replace(v_words, ' ', '');
  if length(v_key) < 2 then
    raise exception 'Company name must contain a distinctive name, not only a legal suffix'
      using errcode = '22023';
  end if;
  v_first_two := substring(v_words from '^([a-z0-9]+ [a-z0-9]+)');

  v_stage := case lower(btrim(coalesce(p_stage, '')))
    when '' then 'Prospect'
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
  if v_stage is null then
    raise exception 'Stage must be one of Unqualified, Prospect, Outreach, Not Interested, Qualified, Proposal, Negotiation, Closed Won, Closed Lost'
      using errcode = '22023';
  end if;

  -- Manufacturer industries drive the CRM website's industry filters, so only
  -- the website's own categories are accepted; "Others" is stored as blank.
  if v_company_type = 'manufacturer' then
    v_industry := case lower(v_industry)
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

  -- One MCP company creation at a time, so two concurrent requests cannot both
  -- pass the duplicate check for the same name.
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
        using errcode = '40001';
    end if;
    return query
    select
      'already_created'::text,
      false,
      v_existing.company_id,
      v_existing.company_type,
      v_existing.company_name,
      '[]'::jsonb;
    return;
  end if;

  with existing_companies as (
    select
      m.id,
      'manufacturer'::text as type,
      m.company,
      coalesce('__deleted' = any(m.tags), false) as hidden
    from public.manufacturers as m
    union all
    select v.id, 'vendor'::text, v.company, false
    from public.vendors as v
    union all
    select l.id, 'lost'::text, l.company, false
    from public.lost_contacts as l
  ),
  normalized as (
    select
      c.*,
      private.normalize_crm_company_words(c.company) as words
    from existing_companies as c
  ),
  matches as (
    select
      n.id,
      n.type,
      n.company,
      n.hidden,
      case
        when replace(n.words, ' ', '') = v_key then 'exact'
        else 'similar'
      end as match
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
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'company_id', ranked.id,
      'company_type', ranked.type,
      'company_name', ranked.company,
      'match', ranked.match,
      'hidden', ranked.hidden
    ) order by ranked.match, ranked.company), '[]'::jsonb),
    coalesce(bool_or(ranked.match = 'exact'), false),
    coalesce(bool_or(ranked.match = 'similar'), false)
  into v_candidates, v_has_exact, v_has_similar
  from (
    select *
    from matches
    order by match, company
    limit 25
  ) as ranked;

  if v_has_exact then
    return query
    select 'duplicate_blocked'::text, false, null::bigint, v_company_type, v_company_name, v_candidates;
    return;
  end if;
  if v_has_similar and not coalesce(p_allow_similar_names, false) then
    return query
    select 'possible_duplicates'::text, false, null::bigint, v_company_type, v_company_name, v_candidates;
    return;
  end if;

  insert into private.mcp_crm_company_operations (
    actor,
    operation_id,
    company_type,
    company_name,
    request_fingerprint
  ) values (
    v_actor,
    p_operation_id,
    v_company_type,
    v_company_name,
    v_fingerprint
  );

  if v_company_type = 'manufacturer' then
    v_company_notes := concat_ws(
      E'\n\n',
      nullif(v_notes, ''),
      nullif(concat_ws(
        E'\n',
        'Website: ' || nullif(v_website, ''),
        'Region: ' || nullif(v_region, '')
      ), '')
    );
    insert into public.manufacturers (
      company,
      stage,
      industry,
      signals,
      tags,
      last_contact
    ) values (
      v_company_name,
      v_stage,
      v_industry,
      coalesce(v_company_notes, ''),
      '{}'::text[],
      v_today
    )
    returning id into v_company_id;
  else
    v_company_notes := concat_ws(
      E'\n\n',
      nullif(v_notes, ''),
      'Website: ' || nullif(v_website, '')
    );
    insert into public.vendors (
      company,
      industry,
      region,
      stage,
      tags,
      notes,
      last_contact
    ) values (
      v_company_name,
      v_industry,
      v_region,
      v_stage,
      '{}'::text[],
      coalesce(v_company_notes, ''),
      v_today
    )
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

comment on function public.create_crm_company(
  uuid, text, text, text, text, text, text, text, boolean, text
) is
'Idempotently creates one manufacturer or vendor after a normalized duplicate check across manufacturers, vendors, and lost_contacts. Exact normalized matches always block; similar names block unless explicitly allowed.';

revoke all on function public.create_crm_company(
  uuid, text, text, text, text, text, text, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.create_crm_company(
  uuid, text, text, text, text, text, text, text, boolean, text
) to service_role;

create or replace function public.create_crm_contact(
  p_operation_id uuid,
  p_company_id bigint,
  p_company_type text,
  p_expected_company_name text,
  p_name text,
  p_title text,
  p_linkedin_url text,
  p_actor text
)
returns table (
  status text,
  created boolean,
  contact_id bigint,
  contact_name text,
  contact_title text,
  contact_linkedin text,
  company_id bigint,
  company_type text,
  company_name text,
  conflict jsonb
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_company_type text := lower(btrim(coalesce(p_company_type, '')));
  v_expected_company_name text := btrim(coalesce(p_expected_company_name, ''));
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_linkedin text;
  v_person_key text;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_fingerprint text;
  v_existing private.mcp_crm_contact_operations%rowtype;
  v_company_name text;
  v_company_tags text[];
  v_conflict jsonb;
  v_contact_id bigint;
begin
  if p_operation_id is null then
    raise exception 'Operation id is required' using errcode = '22023';
  end if;
  if v_actor <> 'github|264040869' then
    raise exception 'OAuth principal is not authorized to create CRM contacts'
      using errcode = '42501';
  end if;
  if p_company_id is null or p_company_id <= 0 then
    raise exception 'Company id must be a positive integer' using errcode = '22023';
  end if;
  if v_company_type = 'lost' then
    raise exception 'Lost records keep a single inline person and do not accept added contacts'
      using errcode = '22023';
  end if;
  if v_company_type not in ('manufacturer', 'vendor') then
    raise exception 'Company type must be manufacturer or vendor' using errcode = '22023';
  end if;
  if v_expected_company_name = '' or length(v_expected_company_name) > 500 then
    raise exception 'Expected company name must contain 1 to 500 characters' using errcode = '22023';
  end if;
  if length(v_name) < 2 or length(v_name) > 200 then
    raise exception 'Contact name must contain 2 to 200 characters' using errcode = '22023';
  end if;
  if length(v_title) > 200 then
    raise exception 'Contact title must contain at most 200 characters' using errcode = '22023';
  end if;
  -- The CRM website edits contacts as "Name, Title, LinkedIn" lines, so a comma
  -- inside a name or title would be split into the wrong fields on next save.
  if position(',' in v_name) > 0 or position(',' in v_title) > 0 then
    raise exception 'Contact name and title must not contain commas; use " - " instead'
      using errcode = '22023';
  end if;

  v_person_key := private.normalize_crm_person_name(v_name);
  if length(replace(v_person_key, ' ', '')) < 2 then
    raise exception 'Contact name must contain letters or digits' using errcode = '22023';
  end if;
  v_linkedin := private.normalize_linkedin_profile_url(p_linkedin_url);
  if v_linkedin is null then
    raise exception 'LinkedIn URL must be a profile URL such as https://www.linkedin.com/in/example'
      using errcode = '22023';
  end if;

  v_fingerprint := md5(jsonb_build_object(
    'company_id', p_company_id,
    'company_type', v_company_type,
    'expected_company_name', lower(v_expected_company_name),
    'name', v_name,
    'title', v_title,
    'linkedin', v_linkedin
  )::text);

  -- Serializes MCP contact creation so the cross-company LinkedIn duplicate
  -- check cannot race another create.
  perform pg_advisory_xact_lock(hashtext('edi_crm_mcp_create_contact'));

  select operation.*
  into v_existing
  from private.mcp_crm_contact_operations as operation
  where operation.actor = v_actor
    and operation.operation_id = p_operation_id;

  if found then
    if v_existing.request_fingerprint <> v_fingerprint then
      raise exception 'Operation id was already used for a different CRM contact request'
        using errcode = '22023';
    end if;
    if v_existing.contact_id is null then
      raise exception 'Operation is still being recorded; retry the same operation id'
        using errcode = '40001';
    end if;
    return query
    select
      'already_created'::text,
      false,
      v_existing.contact_id,
      v_existing.contact_name,
      v_existing.contact_title,
      v_existing.contact_linkedin,
      v_existing.company_id,
      v_existing.company_type,
      v_existing.company_name,
      null::jsonb;
    return;
  end if;

  if v_company_type = 'manufacturer' then
    select m.company, m.tags
    into v_company_name, v_company_tags
    from public.manufacturers as m
    where m.id = p_company_id
    for update;
  else
    select v.company, v.tags
    into v_company_name, v_company_tags
    from public.vendors as v
    where v.id = p_company_id
    for update;
  end if;

  if not found then
    raise exception 'CRM % company % does not exist', v_company_type, p_company_id
      using errcode = '23503';
  end if;
  if lower(btrim(v_company_name)) <> lower(v_expected_company_name) then
    raise exception 'Company name mismatch for CRM % company %', v_company_type, p_company_id
      using errcode = '22023';
  end if;
  if coalesce('__deleted' = any(v_company_tags), false) then
    raise exception 'CRM % company % is deleted in the CRM', v_company_type, p_company_id
      using errcode = '22023';
  end if;

  if v_linkedin <> '' then
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
      select mc.id, mc.name, mc.manufacturer_id as company_id, 'manufacturer'::text as company_type, m.company, mc.linkedin
      from public.manufacturer_contacts as mc
      left join public.manufacturers as m on m.id = mc.manufacturer_id
      where coalesce(mc.linkedin, '') ilike '%linkedin.com/in/%'
      union all
      select vc.id, vc.name, vc.vendor_id, 'vendor'::text, v.company, vc.linkedin
      from public.vendor_contacts as vc
      left join public.vendors as v on v.id = vc.vendor_id
      where coalesce(vc.linkedin, '') ilike '%linkedin.com/in/%'
    ) as found_contact
    where private.normalize_linkedin_profile_url(found_contact.linkedin) = v_linkedin
    order by found_contact.id
    limit 1;

    if v_conflict is not null then
      return query
      select 'duplicate_linkedin'::text, false, null::bigint, v_name, v_title, v_linkedin,
        p_company_id, v_company_type, v_company_name, v_conflict;
      return;
    end if;
  end if;

  if v_company_type = 'manufacturer' then
    select jsonb_build_object(
      'reason', 'same_name_at_company',
      'contact_id', mc.id,
      'contact_name', mc.name,
      'contact_title', mc.title
    )
    into v_conflict
    from public.manufacturer_contacts as mc
    where mc.manufacturer_id = p_company_id
      and private.normalize_crm_person_name(mc.name) = v_person_key
    order by mc.id
    limit 1;
  else
    select conflict_row.detail
    into v_conflict
    from (
      select vc.id as sort_id, jsonb_build_object(
        'reason', 'same_name_at_company',
        'contact_id', vc.id,
        'contact_name', vc.name,
        'contact_title', vc.title
      ) as detail
      from public.vendor_contacts as vc
      where vc.vendor_id = p_company_id
        and private.normalize_crm_person_name(vc.name) = v_person_key
      union all
      select 0, jsonb_build_object(
        'reason', 'same_name_at_company',
        'contact_id', null,
        'contact_name', v.name,
        'contact_title', v.title
      )
      from public.vendors as v
      where v.id = p_company_id
        and private.normalize_crm_person_name(v.name) = v_person_key
    ) as conflict_row
    order by conflict_row.sort_id desc
    limit 1;
  end if;

  if v_conflict is not null then
    return query
    select 'duplicate_name'::text, false, null::bigint, v_name, v_title, v_linkedin,
      p_company_id, v_company_type, v_company_name, v_conflict;
    return;
  end if;

  insert into private.mcp_crm_contact_operations (
    actor,
    operation_id,
    company_id,
    company_type,
    company_name,
    request_fingerprint,
    contact_name,
    contact_title,
    contact_linkedin
  ) values (
    v_actor,
    p_operation_id,
    p_company_id,
    v_company_type,
    v_company_name,
    v_fingerprint,
    v_name,
    v_title,
    v_linkedin
  );

  -- Blank title/LinkedIn are stored as '' to match rows written by the CRM
  -- website, whose contact editor compares these fields as strings.
  if v_company_type = 'manufacturer' then
    insert into public.manufacturer_contacts (manufacturer_id, name, title, linkedin)
    values (p_company_id, v_name, v_title, v_linkedin)
    returning id into v_contact_id;
  else
    insert into public.vendor_contacts (vendor_id, name, title, linkedin)
    values (p_company_id, v_name, v_title, v_linkedin)
    returning id into v_contact_id;
  end if;

  update private.mcp_crm_contact_operations as operation
  set contact_id = v_contact_id
  where operation.actor = v_actor
    and operation.operation_id = p_operation_id;

  return query
  select 'created'::text, true, v_contact_id, v_name, v_title, v_linkedin,
    p_company_id, v_company_type, v_company_name, null::jsonb;
end;
$function$;

comment on function public.create_crm_contact(
  uuid, bigint, text, text, text, text, text, text
) is
'Idempotently attaches one contact to an exact typed manufacturer or vendor after verifying the expected company name and blocking duplicate LinkedIn profiles and same-name contacts.';

revoke all on function public.create_crm_contact(
  uuid, bigint, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_crm_contact(
  uuid, bigint, text, text, text, text, text, text
) to service_role;
