import { Pool, type PoolClient, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var publishControlPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var publishControlSchemaReady: Promise<void> | undefined;
}

const SCHEMA_LOCK_NAME = "publish_control_schema";
const DEFAULT_AUTOMATION_KEY = "grupo_zap_tipo_padrao";
const DEFAULT_AUTOMATION_FUNCTION = "publish_automation_grupo_zap_tipo_padrao";
const DEFAULT_AUTOMATION_TRIGGER = "publish_automation_grupo_zap_tipo_padrao_biu";
const DEFAULT_AUTOMATION_SQL = `update public.base_imoveis
set publicacao_portais = jsonb_set(
  jsonb_set(coalesce(publicacao_portais, '{}'::jsonb), '{grupo_zap,tipo_crm}', to_jsonb('padrão'::text), true),
  '{grupo_zap,tipo_slug}', to_jsonb('padrao'::text), true
)
where publicacao_portais -> 'grupo_zap' ->> 'publicado' = 'true'
  and publicacao_portais -> 'grupo_zap' ->> 'tipo_crm' is null;`;

function getConnectionString() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL não configurado.");
  }
  return connectionString;
}

export function getPool() {
  if (!global.publishControlPool) {
    global.publishControlPool = new Pool({
      connectionString: getConnectionString(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
  }

  return global.publishControlPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
) {
  return getPool().query<T>(text, params);
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureControlSchema() {
  if (!global.publishControlSchemaReady) {
    global.publishControlSchemaReady = initializeControlSchema().catch((error) => {
      global.publishControlSchemaReady = undefined;
      throw error;
    });
  }

  return global.publishControlSchemaReady;
}

async function initializeControlSchema() {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [SCHEMA_LOCK_NAME]);
    await runControlSchemaMigration(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function runControlSchemaMigration(client: PoolClient) {
  await client.query("create extension if not exists unaccent");

  await client.query(`
    create table if not exists publish_portals (
      id serial primary key,
      name text not null,
      slug text not null unique,
      description text,
      logo_url text,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists publish_rules (
      id serial primary key,
      portal_id integer references publish_portals(id) on delete set null,
      name text not null,
      slug text not null,
      description text,
      source_table text not null default 'base_imoveis',
      view_name text unique,
      active boolean not null default true,
      include_locked boolean not null default true,
      filters jsonb not null default '{"combinator":"and","conditions":[]}'::jsonb,
      publication_priority jsonb not null default '[]'::jsonb,
      summary_config jsonb,
      last_sql text,
      last_count integer,
      health_expected_count integer,
      health_published_count integer,
      health_pending_count integer,
      health_unexpected_count integer,
      health_checked_at timestamptz,
      health_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (portal_id, slug)
    );
  `);

  await client.query(`
    create table if not exists publish_portal_ad_types (
      id serial primary key,
      portal_id integer not null references publish_portals(id) on delete cascade,
      name text not null,
      slug text not null,
      quantity integer not null default 0 check (quantity >= 0),
      tier integer not null default 1 check (tier between 1 and 10),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (portal_id, name)
    );
  `);

  await client.query(`
    create index if not exists publish_rules_portal_id_idx on publish_rules(portal_id);
    create index if not exists publish_portal_ad_types_portal_id_idx on publish_portal_ad_types(portal_id);
  `);

  await client.query(`
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
  `);

  await client.query(`
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
  `);

  await client.query(`
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
  `);

  await client.query(`
    alter table if exists publish_portal_ad_types
    add column if not exists slug text;

    alter table if exists publish_portal_ad_types
    add column if not exists tier integer;

    update publish_portal_ad_types
    set slug = public.publish_slugify(name)
    where slug is null
      or slug = ''
      or slug <> public.publish_slugify(name);

    with merged as (
      select portal_id, slug, min(id) as keep_id, sum(quantity)::int as total_quantity
      from publish_portal_ad_types
      group by portal_id, slug
      having count(*) > 1
    )
    update publish_portal_ad_types a
    set quantity = merged.total_quantity,
        updated_at = now()
    from merged
    where a.id = merged.keep_id;

    with merged as (
      select portal_id, slug, min(id) as keep_id
      from publish_portal_ad_types
      group by portal_id, slug
      having count(*) > 1
    )
    delete from publish_portal_ad_types a
    using merged
    where a.portal_id = merged.portal_id
      and a.slug = merged.slug
      and a.id <> merged.keep_id;

    with ranked as (
      select id,
             row_number() over (partition by portal_id order by quantity desc, id asc)::int as next_tier
      from publish_portal_ad_types
    )
    update publish_portal_ad_types a
    set tier = ranked.next_tier,
        updated_at = now()
    from ranked
    where a.id = ranked.id
      and (a.tier is null or a.tier < 1 or a.tier > 10);

    do $$
    begin
      if exists (
        select 1
        from publish_portal_ad_types
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
          from publish_portal_ad_types
          group by portal_id, tier
          having count(*) > 1
        ) duplicated_tiers
      ) then
        raise exception 'publish_portal_ad_types cannot repeat tier for the same portal.';
      end if;
    end
    $$;

    alter table publish_portal_ad_types
    alter column slug set not null;

    alter table publish_portal_ad_types
    alter column tier set not null;

    update publish_rules
    set ad_limit_type = public.publish_slugify(ad_limit_type),
        updated_at = now()
    where ad_limit_type is not null
      and btrim(ad_limit_type) <> ''
      and ad_limit_type <> 'total'
      and ad_limit_type <> public.publish_slugify(ad_limit_type);
  `);

  await client.query(`
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'publish_portal_ad_types'::regclass
          and conname = 'publish_portal_ad_types_slug_format_check'
      ) then
        alter table publish_portal_ad_types
        add constraint publish_portal_ad_types_slug_format_check
        check (slug ~ '^[a-z0-9_]+$');
      end if;
    end
    $$;
  `);

  await client.query(`
    create unique index if not exists publish_portal_ad_types_portal_id_slug_idx
    on publish_portal_ad_types(portal_id, slug);
  `);

  await client.query(`
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'publish_portal_ad_types'::regclass
          and conname = 'publish_portal_ad_types_tier_range_check'
      ) then
        alter table publish_portal_ad_types
        add constraint publish_portal_ad_types_tier_range_check
        check (tier between 1 and 10);
      end if;
    end
    $$;
  `);

  await client.query(`
    create unique index if not exists publish_portal_ad_types_portal_id_tier_idx
    on publish_portal_ad_types(portal_id, tier);
  `);

  await client.query(`
    create or replace function normalize_publish_portal_ad_type_name()
    returns trigger
    language plpgsql
    set search_path = public, pg_catalog
    as $$
    begin
      new.slug := public.publish_slugify(new.name);
      return new;
    end
    $$;
  `);

  await client.query(`
    drop trigger if exists publish_portal_ad_types_normalize_name on publish_portal_ad_types;

    create trigger publish_portal_ad_types_normalize_name
    before insert or update of name, slug
    on publish_portal_ad_types
    for each row
    execute function normalize_publish_portal_ad_type_name();
  `);

  await client.query(`
    do $$
    begin
      if not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'publish_portals'
          and column_name = 'logo_url'
      ) then
        alter table publish_portals add column logo_url text;
      end if;
    end
    $$;
  `);

  await client.query(`
    alter table if exists publish_rules
    add column if not exists publication_priority jsonb not null default '[]'::jsonb;
  `);

  await client.query(`
    alter table if exists publish_rules
    add column if not exists summary_config jsonb;
  `);

  await client.query(`
    alter table if exists publish_rules
    add column if not exists use_ad_limit boolean not null default false,
    add column if not exists ad_limit_type text,
    add column if not exists last_limited_count integer;
  `);

  await client.query(`
    alter table if exists publish_rules
    add column if not exists health_expected_count integer,
    add column if not exists health_published_count integer,
    add column if not exists health_pending_count integer,
    add column if not exists health_unexpected_count integer,
    add column if not exists health_checked_at timestamptz,
    add column if not exists health_error text;
  `);

  await client.query(`
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'publish_portals'::regclass
          and conname = 'publish_portals_slug_format_check'
      ) then
        alter table publish_portals
        add constraint publish_portals_slug_format_check
        check (slug ~ '^[a-z0-9_]+$');
      end if;
    end
    $$;
  `);

  await client.query(`
    create or replace function public.publish_ad_limit_quota(target_portal_id integer, target_ad_limit_type text default 'total')
    returns integer
    language plpgsql
    stable
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
        from publish_portal_ad_types
        where portal_id = target_portal_id;
      else
        select coalesce(max(quantity), 0)::int
        into quota
        from publish_portal_ad_types
        where portal_id = target_portal_id
          and slug = normalized_type;
      end if;

      return coalesce(quota, 0);
    end
    $$;
  `);

  await client.query(`
    do $$
    begin
      if exists (
        select 1
        from pg_attribute
        where attrelid = 'publish_rules'::regclass
          and attname = 'portal_id'
          and attnotnull
      ) then
        alter table publish_rules alter column portal_id drop not null;
      end if;
    end
    $$;
  `);

  await client.query(`
    do $$
    begin
      if exists (
        select 1
        from pg_constraint
        where conrelid = 'publish_rules'::regclass
          and conname = 'publish_rules_portal_id_fkey'
          and (contype <> 'f' or confrelid <> 'publish_portals'::regclass or confdeltype <> 'n')
      ) then
        alter table publish_rules drop constraint publish_rules_portal_id_fkey;
      end if;

      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'publish_rules'::regclass
          and conname = 'publish_rules_portal_id_fkey'
      ) then
        alter table publish_rules
        add constraint publish_rules_portal_id_fkey
        foreign key (portal_id) references publish_portals(id) on delete set null;
      end if;
    end
    $$;
  `);

  await client.query(`
    do $$
    begin
      if exists (
        select 1
        from pg_constraint
        where conrelid = 'publish_rules'::regclass
          and conname = 'publish_rules_portal_id_slug_key'
      ) then
        alter table publish_rules drop constraint publish_rules_portal_id_slug_key;
      end if;
    end
    $$;
  `);

  await installAutomationSchema(client);
}

async function installAutomationSchema(client: PoolClient) {
  await client.query(`
    create table if not exists publish_automations (
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
  `);

  await client.query(`
    alter table if exists publish_automations
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
    on publish_automations(deleted_at);
  `);

  await client.query(
    `
      insert into publish_automations
        (key, name, description, database_name, schema_name, table_name, target_column, run_mode, active, sql_text, trigger_name, function_name)
      values
        ($1, $2, $3, current_database(), 'public', 'base_imoveis', 'publicacao_portais', 'trigger_db', true, $4, $5, $6)
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
          updated_at = now()
    `,
    [
      DEFAULT_AUTOMATION_KEY,
      "Grupo Zap - tipo padrao",
      "Define automaticamente tipo_crm e tipo_slug padrao para publicacoes Grupo Zap sem tipo CRM.",
      DEFAULT_AUTOMATION_SQL,
      DEFAULT_AUTOMATION_TRIGGER,
      DEFAULT_AUTOMATION_FUNCTION
    ]
  );

  await client.query(`
    create or replace function public.${DEFAULT_AUTOMATION_FUNCTION}()
    returns trigger
    language plpgsql
    set search_path = public, pg_catalog
    as $$
    declare
      automation_enabled boolean;
    begin
      select exists (
        select 1
        from public.publish_automations
        where key = '${DEFAULT_AUTOMATION_KEY}'
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
  `);

  await client.query(`
    create or replace function public.publish_apply_automation(target_key text)
    returns table (
      automation_key text,
      affected_count integer,
      ran_at timestamptz
    )
    language plpgsql
    set search_path = public, pg_catalog
    as $$
    declare
      should_run boolean;
    begin
      if target_key <> '${DEFAULT_AUTOMATION_KEY}' then
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
  `);

  await client.query(`
    do $$
    begin
      if exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'base_imoveis'
          and column_name = 'publicacao_portais'
      ) then
        drop trigger if exists ${DEFAULT_AUTOMATION_TRIGGER} on public.base_imoveis;

        create trigger ${DEFAULT_AUTOMATION_TRIGGER}
        before insert or update of publicacao_portais
        on public.base_imoveis
        for each row
        execute function public.${DEFAULT_AUTOMATION_FUNCTION}();
      end if;
    end
    $$;
  `);

  await client.query(`
    do $$
    begin
      if exists (
        select 1
        from public.publish_automations
        where key = '${DEFAULT_AUTOMATION_KEY}'
          and active = true
          and deleted_at is null
          and last_run_at is null
      ) then
        perform *
        from public.publish_apply_automation('${DEFAULT_AUTOMATION_KEY}');
      end if;
    end
    $$;
  `);
}
