import { Pool, type PoolClient, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var publishControlPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var publishControlSchemaReady: Promise<void> | undefined;
}

const SCHEMA_LOCK_NAME = "publish_control_schema";

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
    as $$
    begin
      new.name := lower(regexp_replace(btrim(new.name), '[[:space:]]+', ' ', 'g'));
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
}
