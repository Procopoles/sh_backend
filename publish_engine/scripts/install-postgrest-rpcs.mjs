import fs from "node:fs";
import { Client } from "pg";

function loadLocalEnv() {
  if (!fs.existsSync(".env.local")) return;

  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=["']?(.+?)["']?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const sql = `
alter table public.publish_portals
add column if not exists logo_url text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'publish_portals'::regclass
      and conname = 'publish_portals_slug_format_check'
  ) then
    alter table public.publish_portals
    add constraint publish_portals_slug_format_check
    check (slug ~ '^[a-z0-9_]+$');
  end if;
end
$$;

alter table if exists public.publish_rules
alter column portal_id drop not null;

alter table if exists public.publish_rules
drop constraint if exists publish_rules_portal_id_fkey;

alter table if exists public.publish_rules
add constraint publish_rules_portal_id_fkey
foreign key (portal_id) references public.publish_portals(id) on delete set null;

alter table if exists public.publish_rules
drop constraint if exists publish_rules_portal_id_slug_key;

alter table if exists public.publish_rules
add column if not exists publication_priority jsonb not null default '[]'::jsonb;

alter table if exists public.publish_rules
add column if not exists summary_config jsonb;

alter table if exists public.publish_rules
add column if not exists use_ad_limit boolean not null default false,
add column if not exists ad_limit_type text,
add column if not exists last_limited_count integer;

alter table if exists public.publish_rules
add column if not exists health_expected_count integer,
add column if not exists health_published_count integer,
add column if not exists health_pending_count integer,
add column if not exists health_unexpected_count integer,
add column if not exists health_checked_at timestamptz,
add column if not exists health_error text;

create or replace function public.publish_slugify(value text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      trim(both '_' from regexp_replace(lower(unaccent(value)), '[^a-z0-9]+', '_', 'g')),
      ''
    ),
    'regra'
  )
$$;

create or replace function public.publish_publication_type_slug(publication_data jsonb, portal_slug text)
returns text
language sql
immutable
as $$
  with raw_value as (
    select coalesce(
      nullif(btrim(publication_data -> portal_slug ->> 'tipo_slug'), ''),
      nullif(btrim(publication_data -> portal_slug ->> 'tipo'), ''),
      nullif(btrim(publication_data -> portal_slug ->> 'tipo_crm'), '')
    ) as value
  )
  select case
    when value is null then null
    else public.publish_slugify(value)
  end
  from raw_value
$$;

create table if not exists public.publish_portal_ad_types (
  id serial primary key,
  portal_id integer not null references public.publish_portals(id) on delete cascade,
  name text not null,
  slug text not null,
  quantity integer not null default 0 check (quantity >= 0),
  tier integer not null default 1 check (tier between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (portal_id, name)
);

create index if not exists publish_portal_ad_types_portal_id_idx
on public.publish_portal_ad_types(portal_id);

do $$
begin
  if to_regclass('public.base_imoveis') is not null then
    execute $index$
      create index if not exists idx_base_imoveis_prime_score_filter_numeric
      on public.base_imoveis using btree ((
        case
          when (prime_score #>> ARRAY['prime_score']) ~ '^-?[0-9]+([.][0-9]+)?$'
          then (prime_score #>> ARRAY['prime_score'])::numeric
        end
      ))
    $index$;

    execute $index$
      create index if not exists idx_base_imoveis_prime_score_localizacao_nota_numeric
      on public.base_imoveis using btree ((
        case
          when (prime_score #>> ARRAY['localizacao','nota']) ~ '^-?[0-9]+([.][0-9]+)?$'
          then (prime_score #>> ARRAY['localizacao','nota'])::numeric
        end
      ))
    $index$;

    execute $index$
      create index if not exists idx_base_imoveis_publicacao_portais_gin
      on public.base_imoveis using gin (publicacao_portais jsonb_path_ops)
    $index$;
  end if;
end
$$;

alter table if exists public.publish_portal_ad_types
add column if not exists slug text;

alter table if exists public.publish_portal_ad_types
add column if not exists tier integer;

update public.publish_portal_ad_types
set slug = public.publish_slugify(name)
where slug is null
  or slug = ''
  or slug <> public.publish_slugify(name);

with merged as (
  select portal_id, slug, min(id) as keep_id, sum(quantity)::int as total_quantity
  from public.publish_portal_ad_types
  group by portal_id, slug
  having count(*) > 1
)
update public.publish_portal_ad_types a
set quantity = merged.total_quantity,
    updated_at = now()
from merged
where a.id = merged.keep_id;

with merged as (
  select portal_id, slug, min(id) as keep_id
  from public.publish_portal_ad_types
  group by portal_id, slug
  having count(*) > 1
)
delete from public.publish_portal_ad_types a
using merged
where a.portal_id = merged.portal_id
  and a.slug = merged.slug
  and a.id <> merged.keep_id;

with ranked as (
  select id,
         row_number() over (partition by portal_id order by quantity desc, id asc)::int as next_tier
  from public.publish_portal_ad_types
)
update public.publish_portal_ad_types a
set tier = ranked.next_tier,
    updated_at = now()
from ranked
where a.id = ranked.id
  and (a.tier is null or a.tier < 1 or a.tier > 10);

do $$
begin
  if exists (
    select 1
    from public.publish_portal_ad_types
    where tier is null
       or tier < 1
       or tier > 10
  ) then
    raise exception 'publish_portal_ad_types tier must be between 1 and 10.';
  end if;

  if exists (
    select 1
    from (
      select portal_id, tier, count(*) as total
      from public.publish_portal_ad_types
      group by portal_id, tier
      having count(*) > 1
    ) duplicated_tiers
  ) then
    raise exception 'publish_portal_ad_types cannot repeat tier for the same portal.';
  end if;
end
$$;

alter table public.publish_portal_ad_types
alter column slug set not null;

alter table public.publish_portal_ad_types
alter column tier set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'publish_portal_ad_types'::regclass
      and conname = 'publish_portal_ad_types_slug_format_check'
  ) then
    alter table public.publish_portal_ad_types
    add constraint publish_portal_ad_types_slug_format_check
    check (slug ~ '^[a-z0-9_]+$');
  end if;
end
$$;

create unique index if not exists publish_portal_ad_types_portal_id_slug_idx
on public.publish_portal_ad_types(portal_id, slug);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'publish_portal_ad_types'::regclass
      and conname = 'publish_portal_ad_types_tier_range_check'
  ) then
    alter table public.publish_portal_ad_types
    add constraint publish_portal_ad_types_tier_range_check
    check (tier between 1 and 10);
  end if;
end
$$;

create unique index if not exists publish_portal_ad_types_portal_id_tier_idx
on public.publish_portal_ad_types(portal_id, tier);

update public.publish_rules
set ad_limit_type = public.publish_slugify(ad_limit_type),
    updated_at = now()
where ad_limit_type is not null
  and btrim(ad_limit_type) <> ''
  and ad_limit_type <> 'total'
  and ad_limit_type <> public.publish_slugify(ad_limit_type);

create or replace function public.normalize_publish_portal_ad_type_name()
returns trigger
language plpgsql
as $$
begin
  new.slug := public.publish_slugify(new.name);
  return new;
end
$$;

drop trigger if exists publish_portal_ad_types_normalize_name on public.publish_portal_ad_types;

create trigger publish_portal_ad_types_normalize_name
before insert or update of name, slug
on public.publish_portal_ad_types
for each row
execute function public.normalize_publish_portal_ad_type_name();

grant all privileges on public.publish_portal_ad_types to service_role;
grant all privileges on sequence public.publish_portal_ad_types_id_seq to service_role;

create table if not exists public.publish_automations (
  key text primary key,
  name text not null,
  description text,
  database_name text not null default current_database(),
  schema_name text not null default 'public',
  table_name text not null,
  target_column text not null,
  run_mode text not null,
  active boolean not null default true,
  sql_text text not null,
  trigger_name text,
  function_name text,
  last_run_at timestamptz,
  last_affected_count integer,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.publish_automations
add column if not exists description text,
add column if not exists database_name text not null default current_database(),
add column if not exists schema_name text not null default 'public',
add column if not exists table_name text not null default 'base_imoveis',
add column if not exists target_column text not null default 'publicacao_portais',
add column if not exists run_mode text not null default 'trigger_db',
add column if not exists active boolean not null default true,
add column if not exists sql_text text,
add column if not exists trigger_name text,
add column if not exists function_name text,
add column if not exists last_run_at timestamptz,
add column if not exists last_affected_count integer,
add column if not exists deleted_at timestamptz,
add column if not exists created_at timestamptz not null default now(),
add column if not exists updated_at timestamptz not null default now();

create index if not exists publish_automations_deleted_at_idx
on public.publish_automations(deleted_at);

insert into public.publish_automations
  (key, name, description, database_name, schema_name, table_name, target_column, run_mode, active, sql_text, trigger_name, function_name)
values (
  'grupo_zap_tipo_padrao',
  'Grupo Zap - tipo padrao',
  'Define automaticamente tipo_crm e tipo_slug padrao para publicacoes Grupo Zap sem tipo CRM.',
  current_database(),
  'public',
  'base_imoveis',
  'publicacao_portais',
  'trigger_db',
  true,
  'update public.base_imoveis
set publicacao_portais = jsonb_set(
  jsonb_set(coalesce(publicacao_portais, ''{}''::jsonb), ''{grupo_zap,tipo_crm}'', to_jsonb(''padrão''::text), true),
  ''{grupo_zap,tipo_slug}'', to_jsonb(''padrao''::text), true
)
where publicacao_portais -> ''grupo_zap'' ->> ''publicado'' = ''true''
  and publicacao_portais -> ''grupo_zap'' ->> ''tipo_crm'' is null;',
  'publish_automation_grupo_zap_tipo_padrao_biu',
  'publish_automation_grupo_zap_tipo_padrao'
)
on conflict (key) do update
set name = excluded.name,
    description = excluded.description,
    database_name = current_database(),
    schema_name = excluded.schema_name,
    table_name = excluded.table_name,
    target_column = excluded.target_column,
    run_mode = excluded.run_mode,
    sql_text = excluded.sql_text,
    trigger_name = excluded.trigger_name,
    function_name = excluded.function_name,
    updated_at = now();

create or replace function public.publish_automation_grupo_zap_tipo_padrao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  automation_enabled boolean;
begin
  select exists (
    select 1
    from public.publish_automations
    where key = 'grupo_zap_tipo_padrao'
      and active = true
      and deleted_at is null
  )
  into automation_enabled;

  if not automation_enabled then
    return new;
  end if;

  if new.publicacao_portais -> 'grupo_zap' ->> 'publicado' = 'true'
    and new.publicacao_portais -> 'grupo_zap' ->> 'tipo_crm' is null
  then
    new.publicacao_portais := jsonb_set(
      jsonb_set(coalesce(new.publicacao_portais, '{}'::jsonb), '{grupo_zap,tipo_crm}', to_jsonb('padrão'::text), true),
      '{grupo_zap,tipo_slug}',
      to_jsonb('padrao'::text),
      true
    );
  end if;

  return new;
end
$$;

create or replace function public.publish_apply_automation(target_key text)
returns table (
  automation_key text,
  affected_count integer,
  ran_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  should_run boolean;
begin
  if target_key <> 'grupo_zap_tipo_padrao' then
    raise exception 'Automacao % nao encontrada.', target_key using errcode = 'P0002';
  end if;

  select active = true and deleted_at is null
  into should_run
  from public.publish_automations
  where key = target_key;

  if should_run is null then
    raise exception 'Automacao % nao encontrada.', target_key using errcode = 'P0002';
  end if;

  automation_key := target_key;
  affected_count := 0;
  ran_at := now();

  if not should_run then
    return next;
    return;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'base_imoveis'
      and column_name = 'publicacao_portais'
  ) then
    raise exception 'public.base_imoveis.publicacao_portais indisponivel.' using errcode = 'P0002';
  end if;

  update public.base_imoveis
  set publicacao_portais = jsonb_set(
    jsonb_set(coalesce(publicacao_portais, '{}'::jsonb), '{grupo_zap,tipo_crm}', to_jsonb('padrão'::text), true),
    '{grupo_zap,tipo_slug}',
    to_jsonb('padrao'::text),
    true
  )
  where publicacao_portais -> 'grupo_zap' ->> 'publicado' = 'true'
    and publicacao_portais -> 'grupo_zap' ->> 'tipo_crm' is null;

  get diagnostics affected_count = row_count;

  update public.publish_automations
  set last_run_at = ran_at,
      last_affected_count = affected_count,
      updated_at = now()
  where key = target_key;

  return next;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'base_imoveis'
      and column_name = 'publicacao_portais'
  ) then
    drop trigger if exists publish_automation_grupo_zap_tipo_padrao_biu on public.base_imoveis;

    create trigger publish_automation_grupo_zap_tipo_padrao_biu
    before insert or update of publicacao_portais
    on public.base_imoveis
    for each row
    execute function public.publish_automation_grupo_zap_tipo_padrao();
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from public.publish_automations
    where key = 'grupo_zap_tipo_padrao'
      and active = true
      and deleted_at is null
      and last_run_at is null
  ) then
    perform *
    from public.publish_apply_automation('grupo_zap_tipo_padrao');
  end if;
end
$$;

grant all privileges on public.publish_automations to service_role;
grant execute on function public.publish_automation_grupo_zap_tipo_padrao() to service_role;
grant execute on function public.publish_apply_automation(text) to service_role;

create or replace function public.publish_ad_limit_quota(target_portal_id integer, target_ad_limit_type text default 'total')
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  raw_type text := btrim(coalesce(target_ad_limit_type, 'total'));
  normalized_type text := case
    when raw_type = '' or lower(raw_type) = 'total' then 'total'
    else public.publish_slugify(raw_type)
  end;
  quota integer;
begin
  if target_portal_id is null then
    return 0;
  end if;

  if normalized_type = '' or normalized_type = 'total' then
    select coalesce(sum(quantity), 0)::int
    into quota
    from public.publish_portal_ad_types
    where portal_id = target_portal_id;
  else
    select coalesce(max(quantity), 0)::int
    into quota
    from public.publish_portal_ad_types
    where portal_id = target_portal_id
      and slug = normalized_type;
  end if;

  return coalesce(quota, 0);
end
$$;

grant execute on function public.publish_ad_limit_quota(integer, text) to service_role;

create or replace function public.publish_filter_kind(data_type text)
returns text
language sql
stable
as $$
  select case
    when data_type in ('text', 'character varying', 'character', 'uuid') then 'text'
    when data_type in ('smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision') then 'number'
    when data_type in ('timestamp with time zone', 'timestamp without time zone', 'date') then 'datetime'
    when data_type = 'boolean' then 'boolean'
    when data_type in ('json', 'jsonb') then 'json'
    else 'other'
  end
$$;

drop function if exists public.publish_base_columns();

create or replace function public.publish_base_columns()
returns table (
  column_name text,
  data_type text,
  udt_name text,
  is_nullable text,
  filter_kind text,
  json_path text[],
  display_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  json_column record;
begin
  return query
    select c.column_name::text,
      c.data_type::text,
      c.udt_name::text,
      c.is_nullable::text,
      public.publish_filter_kind(c.data_type)::text as filter_kind,
      null::text[] as json_path,
      c.column_name::text as display_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'base_imoveis'
    order by c.ordinal_position;

  for json_column in
    select c.column_name, c.data_type, c.udt_name, c.is_nullable
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'base_imoveis'
      and c.data_type in ('json', 'jsonb')
    order by c.ordinal_position
  loop
    return query execute format($json_fields$
      with recursive sample(value) as (
        select %1$I::jsonb
        from public.base_imoveis
        where %1$I is not null
        limit 300
      ),
      walk(path, value) as (
        select array[]::text[], value
        from sample
        union all
        select walk.path || child.key, child.value
        from walk
        cross join lateral jsonb_each(case when jsonb_typeof(walk.value) = 'object' then walk.value else '{}'::jsonb end) as child(key, value)
        where coalesce(array_length(walk.path, 1), 0) < 8
      ),
      fields as (
        select path as json_path,
          case
            when bool_or(jsonb_typeof(value) = 'number') and bool_and(jsonb_typeof(value) in ('number', 'null')) then 'number'
            when bool_or(jsonb_typeof(value) = 'boolean') and bool_and(jsonb_typeof(value) in ('boolean', 'null')) then 'boolean'
            when bool_or(jsonb_typeof(value) in ('object', 'array')) then 'json'
            else 'text'
          end::text as filter_kind
        from walk
        where coalesce(array_length(path, 1), 0) > 0
        group by path
        order by array_length(path, 1), array_to_string(path, '.')
        limit 80
      )
      select %2$L::text,
        %3$L::text,
        %4$L::text,
        %5$L::text,
        fields.filter_kind,
        fields.json_path,
        (%2$L::text || '.' || array_to_string(fields.json_path, '.'))::text
      from fields
    $json_fields$,
      json_column.column_name,
      json_column.column_name,
      json_column.data_type,
      json_column.udt_name,
      json_column.is_nullable
    );
  end loop;
end
$$;

create or replace function public.publish_control_counts()
returns table (
  base_imoveis integer,
  publish_locks integer
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    (select count(*)::int from public.base_imoveis),
    (select count(*)::int from public.publish_locks)
$$;

create or replace function public.publish_source_views()
returns table (
  view_name text,
  view_type text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select c.relname::text as view_name,
    case c.relkind when 'm' then 'materialized' else 'view' end::text as view_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
  order by c.relname
$$;

create or replace function public.publish_slugify(value text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      trim(both '_' from regexp_replace(lower(unaccent(value)), '[^a-z0-9]+', '_', 'g')),
      ''
    ),
    'regra'
  )
$$;

create or replace function public.publish_sql_literal(value text, filter_kind text)
returns text
language plpgsql
immutable
as $$
declare
  normalized text := coalesce(value, '');
begin
  if filter_kind = 'number' then
    if normalized ~ '^-?[0-9]+([.][0-9]+)?$' then
      return normalized;
    end if;
    return '0';
  end if;

  if filter_kind = 'boolean' then
    if lower(normalized) in ('true', 't', '1', 'yes', 'sim') then
      return 'true';
    end if;
    return 'false';
  end if;

  return quote_literal(normalized);
end
$$;

create or replace function public.publish_condition_sql(condition jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  target_column_name text := condition->>'column';
  operator text := condition->>'operator';
  value text := condition->>'value';
  secondary_value text := condition->>'secondaryValue';
  case_insensitive boolean := case when condition->>'caseInsensitive' = 'false' then false else true end;
  data_type text;
  filter_kind text;
  column_sql text;
  null_check_sql text;
  text_column_sql text;
  json_path text[];
  json_text_sql text;
  json_value_sql text;
  json_value_kind text;
  list_values text;
begin
  select c.data_type, public.publish_filter_kind(c.data_type)
  into data_type, filter_kind
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'base_imoveis'
    and c.column_name = target_column_name;

  if data_type is null or filter_kind = 'other' then
    return null;
  end if;

  select array_agg(path_item.part order by path_item.ordinality)
  into json_path
  from (
    select part, ordinality
    from jsonb_array_elements_text(
      case when jsonb_typeof(condition->'jsonPath') = 'array' then condition->'jsonPath' else '[]'::jsonb end
    ) with ordinality as raw_path(part, ordinality)
    where btrim(part) <> ''
      and length(part) <= 120
    order by ordinality
    limit 8
  ) as path_item;

  column_sql := format('b.%I', target_column_name);
  null_check_sql := column_sql;
  text_column_sql := case
    when filter_kind = 'json' then column_sql || '::text'
    else column_sql
  end;

  if filter_kind = 'json' and array_length(json_path, 1) > 0 then
    json_value_kind := condition->>'jsonValueKind';
    if json_value_kind not in ('text', 'number', 'boolean', 'datetime', 'json') then
      json_value_kind := 'text';
    end if;

    json_text_sql := format('(b.%I #>> %L::text[])', target_column_name, json_path);
    json_value_sql := format('(b.%I #> %L::text[])', target_column_name, json_path);
    filter_kind := json_value_kind;

    if filter_kind = 'number' then
      column_sql := '(case when ' || json_text_sql || ' ~ ''^-?[0-9]+([.][0-9]+)?$'' then (' || json_text_sql || ')::numeric end)';
      text_column_sql := json_text_sql;
      null_check_sql := json_text_sql;
    elsif filter_kind = 'boolean' then
      column_sql := '(case when lower(' || json_text_sql || ') in (''true'', ''t'', ''1'', ''yes'', ''sim'') then true when lower(' || json_text_sql || ') in (''false'', ''f'', ''0'', ''no'', ''nao'') then false end)';
      text_column_sql := json_text_sql;
      null_check_sql := json_text_sql;
    elsif filter_kind = 'json' then
      column_sql := json_value_sql;
      text_column_sql := json_value_sql || '::text';
      null_check_sql := json_value_sql;
    else
      column_sql := json_text_sql;
      text_column_sql := json_text_sql;
      null_check_sql := json_text_sql;
    end if;
  end if;

  if operator = 'is_null' then
    return null_check_sql || ' is null';
  elsif operator = 'is_not_null' then
    return null_check_sql || ' is not null';
  elsif filter_kind = 'boolean' and operator = 'is_true' then
    return column_sql || ' is true';
  elsif filter_kind = 'boolean' and operator = 'is_false' then
    return column_sql || ' is false';
  elsif operator = 'between' and filter_kind in ('number', 'datetime') then
    return column_sql || ' between '
      || public.publish_sql_literal(value, filter_kind)
      || ' and '
      || public.publish_sql_literal(secondary_value, filter_kind);
  elsif operator = 'contains' and filter_kind in ('text', 'json') then
    return text_column_sql || case when case_insensitive then ' ilike ' else ' like ' end || quote_literal('%' || coalesce(value, '') || '%');
  elsif operator = 'starts_with' and filter_kind = 'text' then
    return text_column_sql || case when case_insensitive then ' ilike ' else ' like ' end || quote_literal(coalesce(value, '') || '%');
  elsif operator = 'in' and filter_kind = 'text' then
    select string_agg(quote_literal(case when case_insensitive then lower(trim(item)) else trim(item) end), ', ')
    into list_values
    from unnest(string_to_array(coalesce(value, ''), ',')) as item
    where trim(item) <> '';

    if list_values is null then
      return 'false';
    end if;

    return case when case_insensitive then 'lower(' || column_sql || ')' else column_sql end || ' in (' || list_values || ')';
  elsif operator = 'equals' then
    if filter_kind = 'text' and case_insensitive then
      return 'lower(' || column_sql || ') = lower(' || public.publish_sql_literal(value, filter_kind) || ')';
    end if;
    return column_sql || ' = ' || public.publish_sql_literal(value, filter_kind);
  elsif operator = 'not_equals' then
    if filter_kind = 'text' and case_insensitive then
      return 'lower(' || column_sql || ') <> lower(' || public.publish_sql_literal(value, filter_kind) || ')';
    end if;
    return column_sql || ' <> ' || public.publish_sql_literal(value, filter_kind);
  elsif operator = 'gt' and filter_kind in ('number', 'datetime') then
    return column_sql || ' > ' || public.publish_sql_literal(value, filter_kind);
  elsif operator = 'gte' and filter_kind in ('number', 'datetime') then
    return column_sql || ' >= ' || public.publish_sql_literal(value, filter_kind);
  elsif operator = 'lt' and filter_kind in ('number', 'datetime') then
    return column_sql || ' < ' || public.publish_sql_literal(value, filter_kind);
  elsif operator = 'lte' and filter_kind in ('number', 'datetime') then
    return column_sql || ' <= ' || public.publish_sql_literal(value, filter_kind);
  end if;

  return null;
end
$$;

create or replace function public.publish_filter_group_sql(filters jsonb, root boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  filter_item jsonb;
  item_sql text;
  parts text[] := array[]::text[];
  combinator text;
begin
  combinator := case when filters->>'combinator' = 'or' then ' or ' else ' and ' end;

  for filter_item in
    select value
    from jsonb_array_elements(
      case when jsonb_typeof(filters->'conditions') = 'array' then filters->'conditions' else '[]'::jsonb end
    )
  loop
    if jsonb_typeof(filter_item->'conditions') = 'array' then
      item_sql := public.publish_filter_group_sql(filter_item, false);
    else
      item_sql := public.publish_condition_sql(filter_item);
    end if;

    if item_sql is not null and item_sql <> '' then
      parts := array_append(parts, item_sql);
    end if;
  end loop;

  if array_length(parts, 1) is null then
    if root then
      return 'true';
    end if;
    return null;
  end if;

  return '(' || array_to_string(parts, combinator) || ')';
end
$$;

create or replace function public.publish_filter_value_sql(condition jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  target_column_name text := condition->>'column';
  data_type text;
  filter_kind text;
  column_sql text;
  json_path text[];
  json_text_sql text;
  json_value_sql text;
  json_value_kind text;
begin
  select c.data_type, public.publish_filter_kind(c.data_type)
  into data_type, filter_kind
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'base_imoveis'
    and c.column_name = target_column_name;

  if data_type is null or filter_kind = 'other' then
    return null;
  end if;

  select array_agg(path_item.part order by path_item.ordinality)
  into json_path
  from (
    select part, ordinality
    from jsonb_array_elements_text(
      case when jsonb_typeof(condition->'jsonPath') = 'array' then condition->'jsonPath' else '[]'::jsonb end
    ) with ordinality as raw_path(part, ordinality)
    where btrim(part) <> ''
      and length(part) <= 120
    order by ordinality
    limit 8
  ) as path_item;

  column_sql := format('b.%I', target_column_name);

  if filter_kind = 'json' and array_length(json_path, 1) > 0 then
    json_value_kind := condition->>'jsonValueKind';
    if json_value_kind not in ('text', 'number', 'boolean', 'datetime', 'json') then
      json_value_kind := 'text';
    end if;

    json_text_sql := format('(b.%I #>> %L::text[])', target_column_name, json_path);
    json_value_sql := format('(b.%I #> %L::text[])', target_column_name, json_path);
    filter_kind := json_value_kind;

    if filter_kind = 'number' then
      column_sql := '(case when ' || json_text_sql || ' ~ ''^-?[0-9]+([.][0-9]+)?$'' then (' || json_text_sql || ')::numeric end)';
    elsif filter_kind = 'boolean' then
      column_sql := '(case when lower(' || json_text_sql || ') in (''true'', ''t'', ''1'', ''yes'', ''sim'') then true when lower(' || json_text_sql || ') in (''false'', ''f'', ''0'', ''no'', ''nao'') then false end)';
    elsif filter_kind = 'json' then
      column_sql := json_value_sql;
    else
      column_sql := json_text_sql;
    end if;
  end if;

  return column_sql;
end
$$;

create or replace function public.publish_preview_filter_columns(filters jsonb)
returns table(column_key text, column_label text, column_sql text, ordinal integer)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  filter_item jsonb;
  json_path text[];
  item_sql text;
  item_ordinal integer := 0;
begin
  for filter_item in
    select value
    from jsonb_array_elements(
      case when jsonb_typeof(filters->'conditions') = 'array' then filters->'conditions' else '[]'::jsonb end
    )
  loop
    item_ordinal := item_ordinal + 1;

    if jsonb_typeof(filter_item->'conditions') = 'array' then
      return query
      select nested.column_key, nested.column_label, nested.column_sql, item_ordinal * 100 + nested.ordinal
      from public.publish_preview_filter_columns(filter_item) nested;
    else
      item_sql := public.publish_filter_value_sql(filter_item);
      if item_sql is null then
        continue;
      end if;

      select array_agg(path_item.part order by path_item.ordinality)
      into json_path
      from (
        select part, ordinality
        from jsonb_array_elements_text(
          case when jsonb_typeof(filter_item->'jsonPath') = 'array' then filter_item->'jsonPath' else '[]'::jsonb end
        ) with ordinality as raw_path(part, ordinality)
        where btrim(part) <> ''
          and length(part) <= 120
        order by ordinality
        limit 8
      ) as path_item;

      if array_length(json_path, 1) > 0 then
        column_key := filter_item->>'column' || '__' || array_to_string(json_path, '__');
        column_label := filter_item->>'column' || '.' || array_to_string(json_path, '.');
      else
        column_key := filter_item->>'column';
        column_label := filter_item->>'column';
      end if;

      column_sql := item_sql;
      ordinal := item_ordinal;
      return next;
    end if;
  end loop;
end
$$;

create or replace function public.publish_where_sql(
  filters jsonb,
  include_locked boolean default true,
  active boolean default true
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  filter_sql text;
  locked_sql text := 'exists (
    select 1
    from public.publish_locks l
    where l.id_imovel::bigint = b.id_interno
      and l.publish_lock_until::date > current_date
      and l.lock_level >= 1
  )';
begin
  if active is false then
    return 'false';
  end if;

  filter_sql := public.publish_filter_group_sql(filters, true);

  if include_locked then
    return '((' || filter_sql || ') or ' || locked_sql || ')';
  end if;

  return filter_sql;
end
$$;

create or replace function public.publish_priority_item_sql(priority_item jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  target_column_name text := priority_item->>'column';
  direction text := case when priority_item->>'direction' = 'desc' then 'desc' else 'asc' end;
  nulls_position text := case when priority_item->>'nulls' = 'first' then 'nulls first' else 'nulls last' end;
  data_type text;
  filter_kind text;
  column_sql text;
  json_path text[];
  json_text_sql text;
  json_value_kind text;
  group_sql text;
begin
  if jsonb_typeof(priority_item->'conditions') = 'array' then
    group_sql := public.publish_filter_group_sql(priority_item, false);
    if group_sql is null or group_sql = '' then
      return null;
    end if;

    return 'case when ' || group_sql || ' then 0 else 1 end asc';
  end if;

  select c.data_type, public.publish_filter_kind(c.data_type)
  into data_type, filter_kind
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'base_imoveis'
    and c.column_name = target_column_name;

  if data_type is null or filter_kind = 'other' then
    return null;
  end if;

  select array_agg(path_item.part order by path_item.ordinality)
  into json_path
  from (
    select part, ordinality
    from jsonb_array_elements_text(
      case when jsonb_typeof(priority_item->'jsonPath') = 'array' then priority_item->'jsonPath' else '[]'::jsonb end
    ) with ordinality as raw_path(part, ordinality)
    where btrim(part) <> ''
      and length(part) <= 120
    order by ordinality
    limit 8
  ) as path_item;

  column_sql := format('b.%I', target_column_name);

  if filter_kind = 'json' and array_length(json_path, 1) > 0 then
    json_value_kind := priority_item->>'jsonValueKind';
    if json_value_kind not in ('text', 'number', 'boolean', 'datetime') then
      json_value_kind := 'text';
    end if;

    json_text_sql := format('(b.%I #>> %L::text[])', target_column_name, json_path);
    filter_kind := json_value_kind;

    if filter_kind = 'number' then
      column_sql := '(case when ' || json_text_sql || ' ~ ''^-?[0-9]+([.][0-9]+)?$'' then (' || json_text_sql || ')::numeric end)';
    elsif filter_kind = 'boolean' then
      column_sql := '(case when lower(' || json_text_sql || ') in (''true'', ''t'', ''1'', ''yes'', ''sim'') then true when lower(' || json_text_sql || ') in (''false'', ''f'', ''0'', ''no'', ''nao'') then false end)';
    else
      column_sql := json_text_sql;
    end if;
  end if;

  if filter_kind not in ('text', 'number', 'boolean', 'datetime') then
    return null;
  end if;

  return column_sql || ' ' || direction || ' ' || nulls_position;
end
$$;

create or replace function public.publish_order_by_sql(publication_priority jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  priority_item jsonb;
  item_sql text;
  parts text[] := array[]::text[];
begin
  for priority_item in
    select value
    from jsonb_array_elements(
      case when jsonb_typeof(publication_priority) = 'array' then publication_priority else '[]'::jsonb end
    ) with ordinality as item(value, ordinality)
    order by ordinality
    limit 8
  loop
    item_sql := public.publish_priority_item_sql(priority_item);
    if item_sql is not null and item_sql <> '' then
      parts := array_append(parts, item_sql);
    end if;
  end loop;

  if array_length(parts, 1) is null then
    return '';
  end if;

  return ' order by ' || array_to_string(parts, ', ');
end
$$;

drop function if exists public.preview_publish_rule(jsonb, boolean, boolean);
drop function if exists public.preview_publish_rule(jsonb, boolean, boolean, text);
drop function if exists public.preview_publish_rule(jsonb, boolean, boolean, text, integer, boolean, text);

create or replace function public.preview_publish_rule(
  filters jsonb,
  include_locked boolean default true,
  active boolean default true,
  source_table text default 'base_imoveis',
  portal_id integer default null,
  use_ad_limit boolean default false,
  ad_limit_type text default 'total'
)
returns table(count integer, limited_count integer)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  where_sql text;
  source_name text := coalesce(nullif(source_table, ''), 'base_imoveis');
  matched_count integer;
  quota integer;
begin
  if source_name <> 'base_imoveis' and not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and c.relname = source_name
  ) then
    raise exception 'Preset inicial invalido: %', source_name using errcode = '22023';
  end if;

  where_sql := public.publish_where_sql(filters, include_locked, active);
  execute format('select count(*)::int from public.%I b where %s', source_name, where_sql) into matched_count;
  quota := case when use_ad_limit then public.publish_ad_limit_quota(portal_id, ad_limit_type) else null end;
  return query select matched_count, case when quota is null then null else least(matched_count, quota) end;
end
$$;

drop function if exists public.preview_publish_rule_rows(jsonb, boolean, boolean, text, jsonb, integer);
drop function if exists public.preview_publish_rule_rows(jsonb, boolean, boolean, text, jsonb, integer, integer, boolean, text);
drop function if exists public.preview_publish_rule_rows(jsonb, boolean, boolean, text, jsonb, integer, integer, boolean, text, text, text);

create or replace function public.preview_publish_rule_rows(
  filters jsonb,
  include_locked boolean default true,
  active boolean default true,
  source_table text default 'base_imoveis',
  publication_priority jsonb default '[]'::jsonb,
  preview_limit integer default 10,
  portal_id integer default null,
  use_ad_limit boolean default false,
  ad_limit_type text default 'total',
  preview_sort_column text default null,
  preview_sort_direction text default 'asc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  where_sql text;
  order_sql text;
  source_name text := coalesce(nullif(source_table, ''), 'base_imoveis');
  normalized_limit integer := case when preview_limit = 100 then 100 else 10 end;
  quota integer;
  final_limit_sql text := '';
  post_order_sql text;
  sort_direction text := case when lower(coalesce(preview_sort_direction, 'asc')) = 'desc' then 'desc' else 'asc' end;
  columns_json jsonb := '[]'::jsonb;
  rows_json jsonb := '[]'::jsonb;
  object_parts text[] := array[]::text[];
  identifier_column text;
  preview_column record;
begin
  if source_name <> 'base_imoveis' and not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and c.relname = source_name
  ) then
    raise exception 'Preset inicial invalido: %', source_name using errcode = '22023';
  end if;

  where_sql := public.publish_where_sql(filters, include_locked, active);
  order_sql := public.publish_order_by_sql(publication_priority);
  if use_ad_limit then
    quota := public.publish_ad_limit_quota(portal_id, ad_limit_type);
    final_limit_sql := format('limit %s', greatest(quota, 0));
  end if;
  post_order_sql := format('b.__preview_rule_order %s', sort_direction);

  select c.column_name
  into identifier_column
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'base_imoveis'
    and c.column_name in ('codigo_crm', 'codigo_crm', 'id_interno')
  order by case c.column_name
    when 'codigo_crm' then 1
    when 'codigo_crm' then 2
    when 'id_interno' then 3
    else 4
  end
  limit 1;

  if identifier_column is null then
    select c.column_name
    into identifier_column
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'base_imoveis'
    order by c.ordinal_position
    limit 1;
  end if;

  for preview_column in
    with raw_columns as (
      select identifier_column as column_key,
        identifier_column as column_label,
        'b.' || quote_ident(identifier_column) as column_sql,
        0 as ordinal
      where identifier_column is not null
      union all
      select column_key, column_label, column_sql, ordinal
      from public.publish_preview_filter_columns(filters)
    ),
    deduped as (
      select distinct on (column_key) column_key, column_label, column_sql, ordinal
      from raw_columns
      order by column_key, ordinal
    )
    select column_key, column_label, column_sql
    from deduped
    order by ordinal, column_key
  loop
    columns_json := columns_json || jsonb_build_object('key', preview_column.column_key, 'label', preview_column.column_label);
    object_parts := array_append(object_parts, quote_literal(preview_column.column_key) || ', ' || preview_column.column_sql);
    if preview_column.column_key = preview_sort_column then
      post_order_sql := format('%s %s nulls last, b.__preview_rule_order asc', preview_column.column_sql, sort_direction);
    end if;
  end loop;

  execute format(
    'select coalesce(jsonb_agg(row_object), ''[]''::jsonb)
     from (
       select jsonb_build_object(%s) as row_object
       from (
         select b.*, row_number() over () as __preview_rule_order
         from (
           select b.*
           from public.%I b
           where %s%s
           %s
         ) b
       ) b
       order by %s
       limit %s
     ) preview_rows',
    array_to_string(object_parts, ', '),
    source_name,
    where_sql,
    order_sql,
    final_limit_sql,
    post_order_sql,
    normalized_limit
  ) into rows_json;

  return jsonb_build_object('columns', columns_json, 'rows', rows_json);
end
$$;

drop function if exists public.preview_publish_rule_summary(jsonb, boolean, boolean, text, jsonb, integer, boolean, text, jsonb);
drop function if exists public.preview_publish_rule_summary(jsonb);

create or replace function public.preview_publish_rule_summary(
  filters jsonb,
  include_locked boolean default true,
  active boolean default true,
  source_table text default 'base_imoveis',
  publication_priority jsonb default '[]'::jsonb,
  portal_id integer default null,
  use_ad_limit boolean default false,
  ad_limit_type text default 'total',
  items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
declare
  where_sql text;
  order_sql text;
  limit_sql text := '';
  source_name text := coalesce(nullif(source_table, ''), 'base_imoveis');
  selection_sql text;
  selection_columns_sql text;
  total_count integer := 0;
  summary_items jsonb := '[]'::jsonb;
  summary_item jsonb;
  target_column_name text;
  data_type text;
  filter_kind text;
  json_path text[];
  column_sql text;
  label text;
  calculation text;
  group_count integer;
  item_total_count integer;
  filled_count integer;
  empty_count integer;
  distinct_count integer;
  min_value text;
  max_value text;
  groups_json jsonb;
  value_counts_json jsonb;
  filled_sql text;
  label_sql text;
begin
  if source_name <> 'base_imoveis' and not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and c.relname = source_name
  ) then
    raise exception 'Preset inicial invalido: %', source_name using errcode = '22023';
  end if;

  where_sql := public.publish_where_sql(filters, include_locked, active);
  order_sql := public.publish_order_by_sql(publication_priority);
  if use_ad_limit then
    limit_sql := format(' limit %s', public.publish_ad_limit_quota(portal_id, ad_limit_type));
  end if;

  select string_agg(format('b.%I', selected_columns.column_name), ', ' order by selected_columns.ordinal_position)
  into selection_columns_sql
  from (
    select distinct c.column_name, c.ordinal_position
    from jsonb_array_elements(
      case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end
    ) summary_item(value)
    join information_schema.columns c
      on c.table_schema = 'public'
     and c.table_name = 'base_imoveis'
     and c.column_name = summary_item.value->>'column'
    where public.publish_filter_kind(c.data_type) <> 'other'
  ) selected_columns;

  if selection_columns_sql is null then
    select format('b.%I', c.column_name)
    into selection_columns_sql
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'base_imoveis'
      and c.column_name in ('id_interno', 'codigo_crm')
    order by case c.column_name when 'id_interno' then 0 else 1 end
    limit 1;
  end if;

  selection_sql := format(
    'select %s from public.%I b where %s%s%s',
    coalesce(selection_columns_sql, '1 as __summary_row'),
    source_name,
    where_sql,
    order_sql,
    limit_sql
  );
  execute 'drop table if exists pg_temp.rule_summary_selection';
  execute format('create temporary table rule_summary_selection on commit drop as %s', selection_sql);
  selection_sql := 'select * from pg_temp.rule_summary_selection';
  execute 'select count(*)::int from pg_temp.rule_summary_selection' into total_count;

  for summary_item in
    select value
    from jsonb_array_elements(
      case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end
    )
  loop
    target_column_name := summary_item->>'column';
    if target_column_name is null or target_column_name = '' then
      continue;
    end if;

    select c.data_type, public.publish_filter_kind(c.data_type)
    into data_type, filter_kind
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'base_imoveis'
      and c.column_name = target_column_name;

    if data_type is null or filter_kind = 'other' then
      continue;
    end if;

    select array_agg(path_item.part order by path_item.ordinality)
    into json_path
    from (
      select part, ordinality
      from jsonb_array_elements_text(
        case when jsonb_typeof(summary_item->'jsonPath') = 'array' then summary_item->'jsonPath' else '[]'::jsonb end
      ) with ordinality as raw_path(part, ordinality)
      where btrim(part) <> ''
        and length(part) <= 120
      order by ordinality
      limit 8
    ) as path_item;

    if filter_kind = 'json' and array_length(json_path, 1) > 0 then
      filter_kind := summary_item->>'jsonValueKind';
      if filter_kind not in ('text', 'number', 'boolean', 'datetime', 'json') then
        filter_kind := 'text';
      end if;
      label := target_column_name || '.' || array_to_string(json_path, '.');
    else
      json_path := null;
      label := target_column_name;
    end if;

    column_sql := public.publish_filter_value_sql(summary_item);
    if column_sql is null then
      continue;
    end if;

    calculation := case
      when summary_item->>'calculation' in ('range', 'count', 'group') then summary_item->>'calculation'
      else 'count'
    end;
    if calculation = 'range' and filter_kind not in ('number', 'datetime', 'text') then
      calculation := 'count';
    end if;

    begin
      group_count := (summary_item->>'groupCount')::integer;
    exception when others then
      group_count := 5;
    end;
    group_count := least(greatest(coalesce(group_count, 5), 2), 10);

    if calculation = 'range' then
      execute format($summary_range$
        with final_selection as (%1$s)
        select
          count(*)::int,
          count(%2$s)::int,
          min(%2$s)::text,
          max(%2$s)::text
        from final_selection b
      $summary_range$, selection_sql, column_sql)
      into item_total_count, filled_count, min_value, max_value;

      summary_items := summary_items || jsonb_build_array(jsonb_build_object(
        'column', target_column_name,
        'jsonPath', json_path,
        'label', label,
        'calculation', 'range',
        'data_type', data_type,
        'filter_kind', filter_kind,
        'filled_count', coalesce(filled_count, 0),
        'total_count', coalesce(item_total_count, 0),
        'min', min_value,
        'max', max_value
      ));
    elsif calculation = 'group' then
      if filter_kind = 'number' then
        execute format($summary_numeric_group$
          with final_selection as (%1$s),
          summary_values as (
            select %2$s::numeric as value
            from final_selection b
            where %2$s is not null
          ),
          bounds as (
            select
              case
                when min(value) = 0 and min(value) filter (where value <> 0) is not null then min(value) filter (where value <> 0)
                else min(value)
              end as min_value,
              max(value) as max_value,
              min(value) = 0 and min(value) filter (where value <> 0) is not null as ignore_zero_floor
            from summary_values
          ),
          bucket_settings as (
            select
              bounds.*,
              chosen_step.step,
              floor(bounds.min_value / chosen_step.floor_unit) * chosen_step.floor_unit as floor_value
            from bounds
            left join lateral (
              with raw as (
                select (bounds.max_value - bounds.min_value) / %3$s as raw_step
              ),
              step_candidates as (
                select
                  factor * power(10::double precision, exponent)::numeric as step,
                  power(10::double precision, exponent)::numeric as floor_unit,
                  raw.raw_step
                from raw
                cross join lateral generate_series(
                  floor(log(greatest(raw.raw_step::double precision, 1e-12)))::int - 1,
                  floor(log(greatest(raw.raw_step::double precision, 1e-12)))::int + 12
                ) as exponents(exponent)
                cross join (values (1::numeric), (2::numeric), (5::numeric), (10::numeric)) factors(factor)
                where raw.raw_step > 0
              )
              select step, floor_unit
              from step_candidates
              where step >= raw_step
                and ceil((bounds.max_value - floor(bounds.min_value / floor_unit) * floor_unit) / step) <= %3$s
              order by step
              limit 1
            ) chosen_step on bounds.min_value is not null and bounds.min_value <> bounds.max_value
          ),
          bucketed_raw as (
            select
              case
                when bucket_settings.min_value is null then null
                when bucket_settings.min_value = bucket_settings.max_value then 1
                else least(
                  greatest(floor((summary_values.value - bucket_settings.floor_value) / bucket_settings.step)::int + 1, 1),
                  %3$s
                )
              end as bucket,
              summary_values.value,
              bucket_settings.min_value,
              bucket_settings.max_value,
              bucket_settings.floor_value,
              bucket_settings.step
            from summary_values
            cross join bucket_settings
            where bucket_settings.min_value is not null
              and (not bucket_settings.ignore_zero_floor or summary_values.value <> 0)
          ),
          bucketed as (
            select
              bucket,
              value,
              case
                when min_value = max_value then value
                else floor_value + ((bucket - 1) * step)
              end as bucket_min,
              case
                when min_value = max_value then value
                else floor_value + (bucket * step)
              end as bucket_max
            from bucketed_raw
          ),
          grouped as (
            select bucket::int,
              min(bucket_min)::text as min_value,
              max(bucket_max)::text as max_value,
              count(*)::int as count
            from bucketed
            where bucket is not null
            group by bucket
            order by bucket
          )
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'label',
                case
                  when min_value is null and max_value is null then 'Sem valor'
                  when min_value = max_value then min_value
                  else coalesce(min_value, '-') || ' ate ' || coalesce(max_value, '-')
                end,
                'count', count,
                'min', min_value,
                'max', max_value
              )
              order by bucket
            ),
            '[]'::jsonb
          )
          from grouped
        $summary_numeric_group$, selection_sql, column_sql, group_count)
        into groups_json;
      else
        label_sql := 'coalesce(nullif(btrim(' || column_sql || '::text), ' || quote_literal('') || '), ' || quote_literal('Sem valor') || ')';
        execute format($summary_exact_group$
          with final_selection as (%1$s),
          grouped as (
            select %2$s as label, count(*)::int as count
            from final_selection b
            group by label
            order by count desc, label asc
            limit %3$s
          )
          select coalesce(jsonb_agg(jsonb_build_object('label', label, 'count', count)), '[]'::jsonb)
          from grouped
        $summary_exact_group$, selection_sql, label_sql, group_count)
        into groups_json;
      end if;

      summary_items := summary_items || jsonb_build_array(jsonb_build_object(
        'column', target_column_name,
        'jsonPath', json_path,
        'label', label,
        'calculation', 'group',
        'data_type', data_type,
        'filter_kind', filter_kind,
        'group_count', group_count,
        'total_count', total_count,
        'groups', coalesce(groups_json, '[]'::jsonb)
      ));
    else
      if filter_kind in ('text', 'json') then
        filled_sql := 'nullif(btrim(' || column_sql || '::text), ' || quote_literal('') || ')';
        label_sql := 'coalesce(nullif(btrim(' || column_sql || '::text), ' || quote_literal('') || '), ' || quote_literal('Sem valor') || ')';
      elsif filter_kind = 'boolean' then
        filled_sql := column_sql;
        label_sql := 'case when ' || column_sql || ' is true then ' || quote_literal('Verdadeiro') ||
          ' when ' || column_sql || ' is false then ' || quote_literal('Falso') ||
          ' else ' || quote_literal('Sem valor') || ' end';
      else
        filled_sql := column_sql;
        label_sql := 'coalesce(' || column_sql || '::text, ' || quote_literal('Sem valor') || ')';
      end if;

      execute format($summary_count$
        with final_selection as (%1$s),
        summary_labels as (
          select %2$s as filled_value, %3$s as label
          from final_selection b
        ),
        stats as (
          select
            count(*)::int as total_count,
            count(filled_value)::int as filled_count,
            (count(*) - count(filled_value))::int as empty_count,
            count(distinct label)::int as distinct_count
          from summary_labels
        ),
        top_values as (
          select label, count(*)::int as count
          from summary_labels
          group by label
          order by count desc, label asc
          limit 5
        )
        select
          stats.total_count,
          stats.filled_count,
          stats.empty_count,
          stats.distinct_count,
          coalesce(
            jsonb_agg(
              jsonb_build_object('label', top_values.label, 'count', top_values.count)
              order by top_values.count desc, top_values.label asc
            ) filter (where top_values.label is not null),
            '[]'::jsonb
          )
        from stats
        left join top_values on true
        group by stats.total_count, stats.filled_count, stats.empty_count, stats.distinct_count
      $summary_count$, selection_sql, filled_sql, label_sql)
      into item_total_count, filled_count, empty_count, distinct_count, value_counts_json;

      summary_items := summary_items || jsonb_build_array(jsonb_build_object(
        'column', target_column_name,
        'jsonPath', json_path,
        'label', label,
        'calculation', 'count',
        'data_type', data_type,
        'filter_kind', filter_kind,
        'filled_count', coalesce(filled_count, 0),
        'empty_count', coalesce(empty_count, 0),
        'distinct_count', coalesce(distinct_count, 0),
        'total_count', coalesce(item_total_count, 0),
        'value_count_limit', 5,
        'values', coalesce(value_counts_json, '[]'::jsonb)
      ));
    end if;
  end loop;

  return jsonb_build_object('total', total_count, 'items', summary_items);
end
$$;

create or replace function public.preview_publish_rule_summary(jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = public, pg_catalog
as $$
  select public.preview_publish_rule_summary(
    coalesce($1 -> 'filters', '[]'::jsonb),
    coalesce(($1 ->> 'include_locked')::boolean, true),
    coalesce(($1 ->> 'active')::boolean, true),
    coalesce(nullif($1 ->> 'source_table', ''), 'base_imoveis'),
    coalesce($1 -> 'publication_priority', '[]'::jsonb),
    nullif($1 ->> 'portal_id', '')::integer,
    coalesce(($1 ->> 'use_ad_limit')::boolean, false),
    coalesce(nullif($1 ->> 'ad_limit_type', ''), 'total'),
    coalesce($1 -> 'items', '[]'::jsonb)
  )
$$;

drop function if exists public.publish_rule_healthcheck(integer);
drop function if exists public.publish_rule_healthcheck(jsonb);

create or replace function public.publish_rule_healthcheck(target_rule_id integer default null)
returns table (
  rule_id integer,
  portal_id integer,
  portal_slug text,
  expected_count integer,
  published_count integer,
  pending_count integer,
  unexpected_count integer,
  checked_at timestamptz,
  error text
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  rule_row record;
  final_view_name text;
  final_view_ready boolean;
  should_filter_type boolean;
  ad_limit_type_slug text;
  refreshed_portal_ids integer[] := array[]::integer[];
begin
  for rule_row in
    select r.id, r.portal_id, r.view_name, r.use_ad_limit, r.ad_limit_type, p.slug as portal_slug
    from public.publish_rules r
    left join public.publish_portals p on p.id = r.portal_id
    where target_rule_id is null or r.id = target_rule_id
    order by r.updated_at desc, r.id desc
  loop
    rule_id := rule_row.id;
    portal_id := rule_row.portal_id;
    portal_slug := rule_row.portal_slug;
    expected_count := null;
    published_count := null;
    pending_count := null;
    unexpected_count := null;
    checked_at := now();
    error := null;

    begin
      if rule_row.portal_id is null or rule_row.portal_slug is null or rule_row.portal_slug = '' then
        error := 'Regra sem portal vinculado.';
      else
        if rule_row.portal_id <> all(refreshed_portal_ids) then
          perform *
          from public.refresh_publish_portal_final_view(rule_row.portal_id);
          refreshed_portal_ids := array_append(refreshed_portal_ids, rule_row.portal_id);
        end if;

        final_view_name := 'pc_' || rule_row.portal_slug || '_final';
        if final_view_name !~ '^pc_[a-z0-9_]+_final$' or length(final_view_name) > 63 then
          error := 'Nome de view final invalido.';
        elsif not exists (
          select 1
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('v', 'm')
            and c.relname = final_view_name
        ) then
          error := 'View final do portal nao encontrada.';
        else
          select not exists (
            select 1
            from (values ('codigo_crm'), ('ad_type_slug'), ('publication_rank'), ('status'), ('current_publication')) as required(column_name)
            where not exists (
              select 1
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
              join pg_attribute a on a.attrelid = c.oid
              where n.nspname = 'public'
                and c.relkind in ('v', 'm')
                and c.relname = final_view_name
                and a.attnum > 0
                and not a.attisdropped
                and a.attname = required.column_name
            )
          ) into final_view_ready;

          if not final_view_ready then
            error := 'View final do portal sem codigo_crm, ad_type_slug, publication_rank, status ou current_publication.';
          else
            should_filter_type := rule_row.use_ad_limit
              and coalesce(rule_row.ad_limit_type, '') <> ''
              and rule_row.ad_limit_type <> 'total';
            ad_limit_type_slug := public.publish_slugify(rule_row.ad_limit_type);

            if should_filter_type then
              execute format(
                'select count(*)::int from public.%I b where b.ad_type_slug = %L and b.status in (''published'', ''pending'')',
                final_view_name,
                ad_limit_type_slug
              ) into expected_count;
            else
              execute format('select count(*)::int from public.%I b where b.status in (''published'', ''pending'')', final_view_name)
              into expected_count;
            end if;

            if should_filter_type then
              execute format(
                'select count(*)::int from public.%I b where b.ad_type_slug = %L and b.status = ''published''',
                final_view_name,
                ad_limit_type_slug
              ) into published_count;
            else
              execute format(
                'select count(*)::int from public.%I b where b.status = ''published''',
                final_view_name
              ) into published_count;
            end if;

            if should_filter_type then
              execute format(
                'select count(*)::int from public.%I b where b.ad_type_slug = %L and b.status = ''pending''',
                final_view_name,
                ad_limit_type_slug
              ) into pending_count;
            else
              execute format(
                'select count(*)::int from public.%I b where b.status = ''pending''',
                final_view_name
              ) into pending_count;
            end if;

            unexpected_count := 0;
          end if;
        end if;
      end if;
    exception when others then
      expected_count := null;
      published_count := null;
      pending_count := null;
      unexpected_count := null;
      error := sqlerrm;
    end;

    update public.publish_rules
    set health_expected_count = expected_count,
        health_published_count = published_count,
        health_pending_count = pending_count,
        health_unexpected_count = unexpected_count,
        health_checked_at = checked_at,
        health_error = error,
        updated_at = now()
    where id = rule_row.id;

    return next;
  end loop;
end
$$;

create or replace function public.publish_rule_healthcheck(jsonb)
returns table (
  rule_id integer,
  portal_id integer,
  portal_slug text,
  expected_count integer,
  published_count integer,
  pending_count integer,
  unexpected_count integer,
  checked_at timestamptz,
  error text
)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select *
  from public.publish_rule_healthcheck(nullif($1 ->> 'target_rule_id', '')::integer)
$$;

drop function if exists public.publish_rule_healthcheck_report(integer);
drop function if exists public.publish_rule_healthcheck_report(jsonb);

create or replace function public.publish_rule_healthcheck_report(target_rule_id integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  rule_row record;
  should_filter_type boolean;
  ad_limit_type_name text;
  ad_limit_type_slug text;
  pending_query text;
  pending_codes jsonb;
  unexpected_codes jsonb;
  rules_json jsonb := '[]'::jsonb;
  rule_error text;
  final_view_name text;
begin
  for rule_row in
    select r.id,
           r.name,
           r.slug,
           r.view_name,
           r.active,
           r.use_ad_limit,
           r.ad_limit_type,
           r.health_expected_count,
           r.health_published_count,
           r.health_pending_count,
           r.health_unexpected_count,
           r.health_checked_at,
           r.health_error,
           p.id as portal_id,
           p.name as portal_name,
           p.slug as portal_slug
    from public.publish_rules r
    join public.publish_portals p on p.id = r.portal_id
    where r.active = true
      and (target_rule_id is null or r.id = target_rule_id)
    order by p.name asc, r.name asc, r.id asc
  loop
    pending_codes := '[]'::jsonb;
    unexpected_codes := '[]'::jsonb;
    pending_query := null;
    rule_error := rule_row.health_error;
    ad_limit_type_name := case
      when rule_row.use_ad_limit and coalesce(rule_row.ad_limit_type, '') <> '' then rule_row.ad_limit_type
      else 'total'
    end;
    ad_limit_type_slug := case
      when ad_limit_type_name = 'total' then 'total'
      else public.publish_slugify(ad_limit_type_name)
    end;
    should_filter_type := rule_row.use_ad_limit
      and coalesce(rule_row.ad_limit_type, '') <> ''
      and rule_row.ad_limit_type <> 'total';
    final_view_name := 'pc_' || rule_row.portal_slug || '_final';

    begin
      if final_view_name !~ '^pc_[a-z0-9_]+_final$' or length(final_view_name) > 63 then
        rule_error := coalesce(rule_error, 'Nome de view final invalido.');
      else
        pending_query := case when should_filter_type then
          format(
            'select b.codigo_crm::text as codigo_crm, b.publication_rank::integer as publication_rank from public.%I b where b.status = ''pending'' and b.ad_type_slug = %L order by b.publication_rank asc nulls last, b.codigo_crm asc',
            final_view_name,
            ad_limit_type_slug
          )
        else
          format(
            'select b.codigo_crm::text as codigo_crm, b.publication_rank::integer as publication_rank from public.%I b where b.status = ''pending'' order by b.publication_rank asc nulls last, b.codigo_crm asc',
            final_view_name
          )
        end;

        execute format('select coalesce(jsonb_agg(codigo_crm order by publication_rank asc nulls last, codigo_crm asc), ''[]''::jsonb) from (%s) codes', pending_query)
        into pending_codes;
      end if;
    exception when others then
      pending_codes := '[]'::jsonb;
      unexpected_codes := '[]'::jsonb;
      rule_error := sqlerrm;
    end;

    rules_json := rules_json || jsonb_build_array(
      jsonb_build_object(
        'rule', jsonb_build_object(
          'id', rule_row.id,
          'name', rule_row.name,
          'slug', rule_row.slug,
          'view_name', rule_row.view_name,
          'active', rule_row.active
        ),
        'portal', jsonb_build_object(
          'id', rule_row.portal_id,
          'name', rule_row.portal_name,
          'slug', rule_row.portal_slug
        ),
        'ad_type', jsonb_build_object(
          'name', ad_limit_type_name,
          'slug', ad_limit_type_slug,
          'is_total', ad_limit_type_name = 'total'
        ),
        'status', jsonb_build_object(
          'expected_count', rule_row.health_expected_count,
          'published_count', rule_row.health_published_count,
          'pending_count', rule_row.health_pending_count,
          'unexpected_count', rule_row.health_unexpected_count,
          'checked_at', rule_row.health_checked_at,
          'error', rule_row.health_error
        ),
        'codes', jsonb_build_object(
          'pending', pending_codes,
          'unexpected', unexpected_codes
        ),
        'queries', jsonb_build_object(
          'pending_codes', pending_query,
          'unexpected_codes', null
        ),
        'error', rule_error
      )
    );
  end loop;

  return jsonb_build_object(
    'generated_at', now(),
    'cached', false,
    'cache', jsonb_build_object(
      'ttl_ms', 0,
      'rule_hits', 0,
      'rule_misses', jsonb_array_length(rules_json)
    ),
    'rules', rules_json
  );
end
$$;

create or replace function public.refresh_publish_rule_view(rule_id integer)
returns setof public.publish_rules
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  rule_row public.publish_rules%rowtype;
  portal_slug text;
  target_view text;
  source_name text;
  where_sql text;
  order_sql text;
  order_expression_sql text;
  window_order_sql text := '';
  tie_breaker_sql text := '';
  source_columns_sql text;
  view_sql text;
  matched_count integer;
  limited_count integer;
  updated_row public.publish_rules%rowtype;
begin
  select r.*
  into rule_row
  from public.publish_rules r
  where r.id = rule_id;

  if not found then
    raise exception 'Regra % nao encontrada', rule_id using errcode = 'P0002';
  end if;

  select p.slug
  into portal_slug
  from public.publish_portals p
  where p.id = rule_row.portal_id;

  target_view := coalesce(
    nullif(rule_row.view_name, ''),
    left('pc_' || case when portal_slug is null then '' else portal_slug || '_' end || rule_row.slug || '_' || rule_row.id::text, 62)
  );

  if target_view !~ '^pc_[a-z0-9_]+$' then
    raise exception 'Nome de view invalido: %', target_view using errcode = '22023';
  end if;

  source_name := coalesce(nullif(rule_row.source_table, ''), 'base_imoveis');
  if source_name = target_view then
    raise exception 'Preset inicial nao pode ser a propria view da regra: %', source_name using errcode = '22023';
  end if;

  if source_name <> 'base_imoveis' and not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
      and c.relname = source_name
  ) then
    raise exception 'Preset inicial invalido: %', source_name using errcode = '22023';
  end if;

  where_sql := public.publish_where_sql(rule_row.filters, rule_row.include_locked, rule_row.active);
  order_sql := public.publish_order_by_sql(rule_row.publication_priority);

  select string_agg(format('b.%I', a.attname), ', ' order by a.attnum)
  into source_columns_sql
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'm')
    and c.relname = source_name
    and a.attnum > 0
    and not a.attisdropped
    and a.attname not in ('__publish_rule_index', '__allocation_rule_order', '__ad_type_duplicate_rank', '__allocation_match_rank', '__allocation_tier_distance', '__candidate_ad_type_slug', '__candidate_tier', 'ad_type_name', 'ad_type_slug', 'tier', 'publication_rank', 'status', 'current_publication');

  if source_columns_sql is null or source_columns_sql = '' then
    raise exception 'Nenhuma coluna publicavel encontrada em %', source_name using errcode = '22023';
  end if;

  order_expression_sql := btrim(regexp_replace(order_sql, '^\\s*order\\s+by\\s+', '', 'i'));
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'v', 'm')
      and c.relname = source_name
      and a.attnum > 0
      and not a.attisdropped
      and a.attname = 'codigo_crm'
  ) then
    tie_breaker_sql := 'b.codigo_crm asc nulls last';
  elsif exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'v', 'm')
      and c.relname = source_name
      and a.attnum > 0
      and not a.attisdropped
      and a.attname = 'id_interno'
  ) then
    tie_breaker_sql := 'b.id_interno asc nulls last';
  end if;

  if tie_breaker_sql <> '' and position(tie_breaker_sql in order_expression_sql) = 0 then
    order_expression_sql := concat_ws(', ', nullif(order_expression_sql, ''), tie_breaker_sql);
  end if;

  if order_expression_sql <> '' then
    window_order_sql := 'order by ' || order_expression_sql;
  end if;

  view_sql := format(
    'create or replace view public.%I as select %s, row_number() over (%s)::integer as __publish_rule_index from public.%I b where %s order by __publish_rule_index',
    target_view,
    source_columns_sql,
    window_order_sql,
    source_name,
    where_sql
  );

  execute view_sql;
  execute format('grant select on public.%I to service_role', target_view);
  execute format('select count(*)::int from public.%I b where %s', source_name, where_sql) into matched_count;
  limited_count := case
    when rule_row.use_ad_limit then least(matched_count, public.publish_ad_limit_quota(rule_row.portal_id, rule_row.ad_limit_type))
    else null
  end;

  update public.publish_rules
  set view_name = target_view,
      last_sql = view_sql,
      last_count = matched_count,
      last_limited_count = limited_count,
      updated_at = now()
  where id = rule_id
  returning * into updated_row;

  return next updated_row;
end
$$;

drop function if exists public.refresh_publish_portal_final_view(integer);
drop function if exists public.refresh_publish_portal_final_view(jsonb);

create or replace function public.refresh_publish_portal_final_view(target_portal_id integer)
returns table (view_name text, sql text)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  portal_row record;
  rule_row record;
  ad_type_row record;
  target_view text;
  final_column_names text[] := array['codigo_crm', 'publicacao_portais'];
  output_column_names text[] := array['codigo_crm'];
  candidate_columns_sql text;
  eligible_columns_sql text;
  final_columns_sql text;
  combined_columns_sql text;
  view_sql text;
  candidate_parts text[] := array[]::text[];
  allocated_parts text[] := array[]::text[];
  allocated_names text[] := array[]::text[];
  final_union_sql text;
  previous_cte text;
  exclusion_sql text;
  has_rule_index boolean;
  existing_relkind text;
  rule_ordinal integer := 0;
  allocation_index integer := 0;
  cte_name text;
  ad_type_values_sql text;
  ad_type_source_sql text;
  combined_select_sql text;
  missing_columns text[];
begin
  select *
  into portal_row
  from public.publish_portals
  where id = target_portal_id;

  if not found then
    raise exception 'Portal % nao encontrado', target_portal_id using errcode = 'P0002';
  end if;

  target_view := 'pc_' || portal_row.slug || '_final';
  if target_view !~ '^pc_[a-z0-9_]+_final$' or length(target_view) > 63 then
    raise exception 'Nome de view final invalido: %', target_view using errcode = '22023';
  end if;

  select string_agg(format('b.%I', column_item.column_name), ', ')
  into candidate_columns_sql
  from unnest(final_column_names) as column_item(column_name);

  select string_agg(format('c.%I', column_item.column_name), ', ')
  into eligible_columns_sql
  from unnest(final_column_names) as column_item(column_name);

  select string_agg(format('ranked.%I', column_item.column_name), ', ')
  into final_columns_sql
  from unnest(final_column_names) as column_item(column_name);

  select string_agg(format('expected.%I', column_item.column_name), ', ')
  into combined_columns_sql
  from unnest(output_column_names) as column_item(column_name);

  select string_agg(
    format(
      '(%L::text, %L::text, %s::integer, %s::integer)',
      a.name,
      a.slug,
      coalesce(a.tier, 0),
      greatest(coalesce(a.quantity, 0), 0)
    ),
    E',\\n  '
    order by a.tier desc, a.slug asc
  )
  into ad_type_values_sql
  from public.publish_portal_ad_types a
  where a.portal_id = target_portal_id;

  ad_type_source_sql := case
    when ad_type_values_sql is null then 'select null::text as ad_type_name, null::text as ad_type_slug, null::integer as tier, null::integer as quantity where false'
    else 'values ' || ad_type_values_sql
  end;

  select array_agg(required.column_name order by required.ordinality)
  into missing_columns
  from unnest(final_column_names) with ordinality as required(column_name, ordinality)
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute attr on attr.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'v', 'm')
      and c.relname = 'base_imoveis'
      and attr.attnum > 0
      and not attr.attisdropped
      and attr.attname = required.column_name
  );

  if missing_columns is not null then
    raise exception 'base_imoveis precisa expor % para consolidacao final.', array_to_string(missing_columns, ', ') using errcode = '22023';
  end if;

  combined_select_sql := format(
    'select %s, expected.ad_type_name, expected.ad_type_slug, expected.tier, expected.publication_rank, expected.status, expected.current_publication from expected_publications expected order by case expected.status when ''pending'' then 0 when ''published'' then 2 else 2 end, expected.publication_rank asc nulls last, expected.tier desc nulls last, expected.codigo_crm asc',
    combined_columns_sql
  );

  for rule_row in
    select r.id as rule_id,
           r.view_name,
           case
             when r.use_ad_limit = true
              and coalesce(r.ad_limit_type, '') <> ''
              and r.ad_limit_type <> 'total'
             then a.slug
             else null
           end as candidate_ad_type_slug,
           case
             when r.use_ad_limit = true
              and coalesce(r.ad_limit_type, '') <> ''
              and r.ad_limit_type <> 'total'
             then a.tier
             else null
           end as candidate_tier
    from public.publish_rules r
    left join public.publish_portal_ad_types a
      on a.portal_id = r.portal_id
     and a.slug = r.ad_limit_type
    where r.portal_id = target_portal_id
      and r.active = true
      and r.view_name is not null
      and r.use_ad_limit = true
      and coalesce(r.ad_limit_type, '') <> ''
      and r.ad_limit_type <> 'total'
      and a.slug is not null
    order by
      case
        when r.use_ad_limit = true
         and coalesce(r.ad_limit_type, '') <> ''
         and r.ad_limit_type <> 'total'
        then coalesce(a.tier, -2147483648)
        else -2147483648
      end desc,
      r.id asc
  loop
    select array_agg(required.column_name order by required.ordinality)
    into missing_columns
    from unnest(final_column_names) with ordinality as required(column_name, ordinality)
    where not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute attr on attr.attrelid = c.oid
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm')
        and c.relname = rule_row.view_name
        and attr.attnum > 0
        and not attr.attisdropped
        and attr.attname = required.column_name
    );

    if missing_columns is not null then
      raise exception 'As views candidatas precisam expor % para consolidacao final.', array_to_string(missing_columns, ', ') using errcode = '22023';
    end if;

    rule_ordinal := rule_ordinal + 1;
    select exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute attr on attr.attrelid = c.oid
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm')
        and c.relname = rule_row.view_name
        and attr.attnum > 0
        and not attr.attisdropped
        and attr.attname = '__publish_rule_index'
    ) into has_rule_index;

    candidate_parts := array_append(candidate_parts, format(
      'select %s::integer as __allocation_rule_order, %s::text as __candidate_ad_type_slug, %s::integer as __candidate_tier, %s as __publish_rule_index, %s from public.%I b where b.codigo_crm is not null',
      rule_ordinal,
      case when rule_row.candidate_ad_type_slug is null then 'null' else quote_literal(rule_row.candidate_ad_type_slug) end,
      case when rule_row.candidate_tier is null then 'null' else rule_row.candidate_tier::text end,
      case when has_rule_index then 'coalesce(b.__publish_rule_index, 2147483647)::integer' else 'row_number() over ()::integer' end,
      candidate_columns_sql,
      rule_row.view_name
    ));
  end loop;

  if array_length(candidate_parts, 1) is null or ad_type_values_sql is null then
    select array_agg(required.column_name order by required.ordinality)
    into missing_columns
    from unnest(final_column_names) with ordinality as required(column_name, ordinality)
    where not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute attr on attr.attrelid = c.oid
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm')
        and c.relname = 'base_imoveis'
        and attr.attnum > 0
        and not attr.attisdropped
        and attr.attname = required.column_name
    );

    if missing_columns is not null then
      raise exception 'base_imoveis precisa expor % para consolidacao final.', array_to_string(missing_columns, ', ') using errcode = '22023';
    end if;

    view_sql := format(
      'create materialized view public.%I as with ad_types(ad_type_name, ad_type_slug, tier, quantity) as (%s), expected_publications as (select %s, null::text as ad_type_name, null::text as ad_type_slug, null::integer as tier, null::integer as publication_rank, ''published''::text as status, b.publicacao_portais::jsonb as current_publication from public.base_imoveis b where false) %s',
      target_view,
      ad_type_source_sql,
      candidate_columns_sql,
      combined_select_sql
    );
  else
    for ad_type_row in
      select a.name as ad_type_name,
             a.slug as ad_type_slug,
             a.tier,
             a.quantity
      from public.publish_portal_ad_types a
      where a.portal_id = target_portal_id
      order by a.tier desc, a.slug asc
    loop
      cte_name := 'allocated_' || allocation_index::text;
      exclusion_sql := '';
      foreach previous_cte in array allocated_names
      loop
        exclusion_sql := exclusion_sql || format(' and not exists (select 1 from %I previous where previous.codigo_crm = d.codigo_crm)', previous_cte);
      end loop;

      allocated_parts := array_append(allocated_parts, format(
        '%I as (select * from deduped d where d.ad_type_slug = %L%s order by d.__publish_rule_index asc, d.__allocation_rule_order asc, d.codigo_crm asc limit %s)',
        cte_name,
        ad_type_row.ad_type_slug,
        exclusion_sql,
        greatest(coalesce(ad_type_row.quantity, 0), 0)
      ));
      allocated_names := array_append(allocated_names, cte_name);
      allocation_index := allocation_index + 1;
    end loop;

    select string_agg(format('select * from %I', allocated_name), E'\\nunion all\\n')
    into final_union_sql
    from unnest(allocated_names) as allocated(allocated_name);

    view_sql := format(
      'create materialized view public.%I as with ad_types(ad_type_name, ad_type_slug, tier, quantity) as (%s), candidates as (%s), eligible as (select c.__allocation_rule_order, a.ad_type_name, a.ad_type_slug, a.tier, case when c.__candidate_ad_type_slug = a.ad_type_slug then 0 when c.__candidate_ad_type_slug is null then 2 else 1 end::integer as __allocation_match_rank, abs(coalesce(c.__candidate_tier, a.tier) - a.tier)::integer as __allocation_tier_distance, c.__candidate_tier, c.__publish_rule_index, %s from candidates c join ad_types a on c.__candidate_ad_type_slug = a.ad_type_slug), deduped as (select * from (select eligible.*, row_number() over (partition by codigo_crm, ad_type_slug order by __publish_rule_index asc, __allocation_rule_order asc) as __ad_type_duplicate_rank from eligible) ranked where __ad_type_duplicate_rank = 1), %s, final_allocation as (%s), ranked_expected as (select final_allocation.*, row_number() over (order by tier desc, __publish_rule_index asc, __allocation_rule_order asc, __allocation_match_rank asc, __allocation_tier_distance asc, codigo_crm asc)::integer as publication_rank from final_allocation), expected_publications as (select %s, ranked.ad_type_name, ranked.ad_type_slug, ranked.tier, ranked.publication_rank, case when coalesce((coalesce(current_base.publicacao_portais::jsonb, ranked.publicacao_portais::jsonb) -> %L ->> ''publicado'')::boolean, false) is true and public.publish_publication_type_slug(coalesce(current_base.publicacao_portais::jsonb, ranked.publicacao_portais::jsonb), %L) = ranked.ad_type_slug then ''published''::text else ''pending''::text end as status, coalesce(current_base.publicacao_portais::jsonb, ranked.publicacao_portais::jsonb) as current_publication from ranked_expected ranked left join public.base_imoveis current_base on current_base.codigo_crm = ranked.codigo_crm) %s',
      target_view,
      ad_type_source_sql,
      array_to_string(candidate_parts, E'\\nunion all\\n'),
      eligible_columns_sql,
      array_to_string(allocated_parts, E',\\n'),
      final_union_sql,
      final_columns_sql,
      portal_row.slug,
      portal_row.slug,
      combined_select_sql
    );
  end if;

  select c.relkind
  into existing_relkind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = target_view
    and c.relkind in ('v', 'm')
  limit 1;

  if existing_relkind = 'm' then
    execute format('drop materialized view if exists public.%I', target_view);
  elsif existing_relkind = 'v' then
    execute format('drop view if exists public.%I', target_view);
  end if;

  execute view_sql;
  execute format('create index on public.%I (ad_type_slug)', target_view);
  execute format('create index on public.%I (publication_rank)', target_view);
  execute format('create index on public.%I (status)', target_view);
  if final_column_names is not null and 'codigo_crm' = any(final_column_names) then
    execute format('create unique index on public.%I (codigo_crm)', target_view);
    execute format('create index on public.%I (ad_type_slug, codigo_crm)', target_view);
  end if;
  execute format('grant select on public.%I to service_role', target_view);
  view_name := target_view;
  sql := view_sql;
  return next;
end
$$;

create or replace function public.refresh_publish_portal_final_view(jsonb)
returns table (view_name text, sql text)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select *
  from public.refresh_publish_portal_final_view(nullif($1 ->> 'portal_id', '')::integer)
$$;

drop function if exists public.drop_publish_portal_final_view(text);
drop function if exists public.drop_publish_portal_final_view(jsonb);

create or replace function public.drop_publish_portal_final_view(target_portal_slug text)
returns table (ok boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  target_view text := 'pc_' || coalesce(target_portal_slug, '') || '_final';
  existing_relkind text;
begin
  if target_view !~ '^pc_[a-z0-9_]+_final$' or length(target_view) > 63 then
    raise exception 'Nome de view final invalido: %', target_view using errcode = '22023';
  end if;

  select c.relkind
  into existing_relkind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = target_view
    and c.relkind in ('v', 'm')
  limit 1;

  if existing_relkind = 'm' then
    execute format('drop materialized view if exists public.%I', target_view);
  elsif existing_relkind = 'v' then
    execute format('drop view if exists public.%I', target_view);
  end if;
  ok := true;
  return next;
end
$$;

create or replace function public.drop_publish_portal_final_view(jsonb)
returns table (ok boolean)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select *
  from public.drop_publish_portal_final_view($1 ->> 'portal_slug')
$$;

create or replace function public.drop_publish_rule_view(rule_id integer)
returns setof public.publish_rules
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  rule_row public.publish_rules%rowtype;
  portal_slug text;
  updated_row public.publish_rules%rowtype;
begin
  select * into rule_row
  from public.publish_rules
  where id = rule_id;

  if not found then
    raise exception 'Regra % nao encontrada', rule_id using errcode = 'P0002';
  end if;

  select p.slug
  into portal_slug
  from public.publish_portals p
  where p.id = rule_row.portal_id;

  if portal_slug is not null and portal_slug <> '' then
    perform *
    from public.drop_publish_portal_final_view(portal_slug);
  end if;

  if rule_row.view_name is not null and rule_row.view_name <> '' then
    if rule_row.view_name !~ '^pc_[a-z0-9_]+$' then
      raise exception 'Nome de view invalido: %', rule_row.view_name using errcode = '22023';
    end if;

    execute format('drop view if exists public.%I', rule_row.view_name);
  end if;

  update public.publish_rules
  set view_name = null,
      last_sql = null,
      last_count = null,
      updated_at = now()
  where id = rule_id
  returning * into updated_row;

  return next updated_row;
end
$$;

create or replace function public.publish_rule_healthcheck_report(jsonb)
returns jsonb
language sql
security definer
set search_path = public, pg_catalog
as $$
  select public.publish_rule_healthcheck_report(nullif($1 ->> 'target_rule_id', '')::integer)
$$;

grant execute on function public.publish_filter_kind(text) to service_role;
grant execute on function public.publish_publication_type_slug(jsonb, text) to service_role;
grant execute on function public.publish_base_columns() to service_role;
grant execute on function public.publish_control_counts() to service_role;
grant execute on function public.publish_source_views() to service_role;
grant execute on function public.publish_filter_group_sql(jsonb, boolean) to service_role;
grant execute on function public.publish_filter_value_sql(jsonb) to service_role;
grant execute on function public.publish_preview_filter_columns(jsonb) to service_role;
grant execute on function public.publish_priority_item_sql(jsonb) to service_role;
grant execute on function public.publish_order_by_sql(jsonb) to service_role;
grant execute on function public.preview_publish_rule(jsonb, boolean, boolean, text, integer, boolean, text) to service_role;
grant execute on function public.preview_publish_rule_rows(jsonb, boolean, boolean, text, jsonb, integer, integer, boolean, text, text, text) to service_role;
grant execute on function public.preview_publish_rule_summary(jsonb, boolean, boolean, text, jsonb, integer, boolean, text, jsonb) to service_role;
grant execute on function public.preview_publish_rule_summary(jsonb) to service_role;
grant execute on function public.publish_rule_healthcheck(integer) to service_role;
grant execute on function public.publish_rule_healthcheck(jsonb) to service_role;
grant execute on function public.publish_rule_healthcheck_report(integer) to service_role;
grant execute on function public.publish_rule_healthcheck_report(jsonb) to service_role;
grant execute on function public.refresh_publish_rule_view(integer) to service_role;
grant execute on function public.refresh_publish_portal_final_view(integer) to service_role;
grant execute on function public.refresh_publish_portal_final_view(jsonb) to service_role;
grant execute on function public.drop_publish_portal_final_view(text) to service_role;
grant execute on function public.drop_publish_portal_final_view(jsonb) to service_role;
grant execute on function public.drop_publish_rule_view(integer) to service_role;

notify pgrst, 'reload schema';
`;

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL nao configurado.");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query("create extension if not exists unaccent");
  await client.query(sql);
  console.log("postgrest_rpcs_ok");
} finally {
  await client.end();
}
