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

loadLocalEnv();

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const columns = await client.query(`
    select table_name, column_name, data_type, udt_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('base_imoveis', 'publish_locks')
    order by table_name, ordinal_position
  `);

  const samples = await client.query(`
    select
      (select count(*)::int from base_imoveis) as base_imoveis_count,
      (select count(*)::int from publish_locks) as publish_locks_count
  `);

  console.log(JSON.stringify({ columns: columns.rows, samples: samples.rows[0] }, null, 2));
} finally {
  await client.end();
}
