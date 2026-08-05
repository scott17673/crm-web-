create or replace function public.create_crm_task(
  p_contact_id bigint,
  p_contact_type text,
  p_title text,
  p_due_date date default null,
  p_owner text default 'Scott'
)
returns setof public.activities
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_contact_type text := lower(trim(coalesce(p_contact_type, '')));
  v_title text := trim(coalesce(p_title, ''));
  v_owner text;
  v_record_exists boolean := false;
begin
  if p_contact_id is null then
    raise exception 'A CRM record id is required' using errcode = '22023';
  end if;

  if v_contact_type not in ('manufacturer', 'vendor', 'lost') then
    raise exception 'Invalid CRM record type: %', p_contact_type using errcode = '22023';
  end if;

  if v_title = '' then
    raise exception 'Task title is required' using errcode = '22023';
  end if;

  v_owner := case lower(trim(coalesce(p_owner, 'Scott')))
    when 'scott' then 'Scott'
    when 'jeff' then 'Jeff'
    else null
  end;

  if v_owner is null then
    raise exception 'Task owner must be Scott or Jeff' using errcode = '22023';
  end if;

  if v_contact_type = 'manufacturer' then
    select exists(select 1 from public.manufacturers where id = p_contact_id) into v_record_exists;
  elsif v_contact_type = 'vendor' then
    select exists(select 1 from public.vendors where id = p_contact_id) into v_record_exists;
  else
    select exists(select 1 from public.lost_contacts where id = p_contact_id) into v_record_exists;
  end if;

  if not v_record_exists then
    raise exception 'CRM % record % does not exist', v_contact_type, p_contact_id using errcode = '23503';
  end if;

  return query
  insert into public.activities (contact_id, contact_type, type, note, date, created_by)
  values (p_contact_id, v_contact_type, 'Note', v_title, p_due_date, '__task__|open|' || v_owner)
  returning *;
end;
$function$;

comment on function public.create_crm_task(bigint, text, text, date, text) is
'Creates one CRM task as a validated activities row. Use this function instead of manually encoding task metadata.';

revoke all on function public.create_crm_task(bigint, text, text, date, text) from public;
grant execute on function public.create_crm_task(bigint, text, text, date, text) to anon, authenticated, service_role;

do $migration$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'activities'
     ) then
    execute 'alter publication supabase_realtime add table public.activities';
  end if;
end;
$migration$;
