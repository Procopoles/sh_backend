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
add column if not exists use_ad_limit boolean not null default false,
add column if not exists ad_limit_type text,
add column if not exists last_limited_count integer;

create table if not exists public.publish_portal_ad_types (
  id serial primary key,
  portal_id integer not null references public.publish_portals(id) on delete cascade,
  name text not null,
  quantity integer not null default 0 check (quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (portal_id, name)
);

create index if not exists publish_portal_ad_types_portal_id_idx
on public.publish_portal_ad_types(portal_id);

create or replace function public.normalize_publish_portal_ad_type_name()
returns trigger
language plpgsql
as $$
begin
  new.name := lower(regexp_replace(btrim(new.name), '[[:space:]]+', ' ', 'g'));
  return new;
end
$$;

drop trigger if exists publish_portal_ad_types_normalize_name on public.publish_portal_ad_types;

create trigger publish_portal_ad_types_normalize_name
before insert or update of name
on public.publish_portal_ad_types
for each row
execute function public.normalize_publish_portal_ad_type_name();

grant all privileges on public.publish_portal_ad_types to service_role;
grant all privileges on sequence public.publish_portal_ad_types_id_seq to service_role;

create or replace function public.publish_ad_limit_quota(target_portal_id integer, target_ad_limit_type text default 'total')
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  normalized_type text := lower(regexp_replace(btrim(coalesce(target_ad_limit_type, 'total')), '[[:space:]]+', ' ', 'g'));
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
      and name = normalized_type;
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
    from jsonb_array_elements_text(coalesce(condition->'jsonPath', '[]'::jsonb)) with ordinality as raw_path(part, ordinality)
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
    select value from jsonb_array_elements(coalesce(filters->'conditions', '[]'::jsonb))
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
    from jsonb_array_elements_text(coalesce(condition->'jsonPath', '[]'::jsonb)) with ordinality as raw_path(part, ordinality)
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
    select value from jsonb_array_elements(coalesce(filters->'conditions', '[]'::jsonb))
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
        from jsonb_array_elements_text(coalesce(filter_item->'jsonPath', '[]'::jsonb)) with ordinality as raw_path(part, ordinality)
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
    from jsonb_array_elements_text(coalesce(priority_item->'jsonPath', '[]'::jsonb)) with ordinality as raw_path(part, ordinality)
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
    from jsonb_array_elements(coalesce(publication_priority, '[]'::jsonb)) with ordinality as item(value, ordinality)
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

create or replace function public.preview_publish_rule_rows(
  filters jsonb,
  include_locked boolean default true,
  active boolean default true,
  source_table text default 'base_imoveis',
  publication_priority jsonb default '[]'::jsonb,
  preview_limit integer default 10,
  portal_id integer default null,
  use_ad_limit boolean default false,
  ad_limit_type text default 'total'
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
    normalized_limit := least(normalized_limit, quota);
  end if;

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
  end loop;

  execute format(
    'select coalesce(jsonb_agg(row_object), ''[]''::jsonb)
     from (
       select jsonb_build_object(%s) as row_object
       from public.%I b
       where %s%s
       limit %s
     ) preview_rows',
    array_to_string(object_parts, ', '),
    source_name,
    where_sql,
    order_sql,
    normalized_limit
  ) into rows_json;

  return jsonb_build_object('columns', columns_json, 'rows', rows_json);
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
  limit_sql text := '';
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
  if rule_row.use_ad_limit then
    limit_sql := format(' limit public.publish_ad_limit_quota(%s, %L)', rule_row.portal_id, coalesce(rule_row.ad_limit_type, 'total'));
  end if;
  view_sql := format(
    'create or replace view public.%I as select b.* from public.%I b where %s%s%s',
    target_view,
    source_name,
    where_sql,
    order_sql,
    limit_sql
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

create or replace function public.drop_publish_rule_view(rule_id integer)
returns setof public.publish_rules
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  rule_row public.publish_rules%rowtype;
  updated_row public.publish_rules%rowtype;
begin
  select * into rule_row
  from public.publish_rules
  where id = rule_id;

  if not found then
    raise exception 'Regra % nao encontrada', rule_id using errcode = 'P0002';
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

grant execute on function public.publish_filter_kind(text) to service_role;
grant execute on function public.publish_base_columns() to service_role;
grant execute on function public.publish_control_counts() to service_role;
grant execute on function public.publish_source_views() to service_role;
grant execute on function public.publish_filter_group_sql(jsonb, boolean) to service_role;
grant execute on function public.publish_filter_value_sql(jsonb) to service_role;
grant execute on function public.publish_preview_filter_columns(jsonb) to service_role;
grant execute on function public.publish_priority_item_sql(jsonb) to service_role;
grant execute on function public.publish_order_by_sql(jsonb) to service_role;
grant execute on function public.preview_publish_rule(jsonb, boolean, boolean, text, integer, boolean, text) to service_role;
grant execute on function public.preview_publish_rule_rows(jsonb, boolean, boolean, text, jsonb, integer, integer, boolean, text) to service_role;
grant execute on function public.refresh_publish_rule_view(integer) to service_role;
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
