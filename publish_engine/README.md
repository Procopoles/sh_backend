# Publish Engine

Aplicacao Next.js para gerenciar portais e regras de publicacao de imoveis.

Contexto tecnico permanente: [docs/APP_CONTEXT.md](docs/APP_CONTEXT.md).

## Execucao Local

```bash
npm install
npm run dev
```

Em desenvolvimento local, a aplicacao usa `DATABASE_URL` em `.env.local` para conectar direto no Postgres `base_dados`.

Use o dev server padrao do Next (`npm.cmd run dev` no Windows). Nao inicie com `--turbo`, pois o Turbopack quebra o carregamento de CSS e dos icones Material Symbols neste projeto.

## Modelo

- `publish_portals`: cadastro de portais.
- `publish_portal_ad_types`: tipos/niveis de anuncio por portal e suas cotas.
- `publish_rules`: regras visuais de publicacao, filtros em JSON e referencia da view criada.
- Cada regra cria ou atualiza uma view `public.pc_*` sobre `public.base_imoveis`.
- A opcao "Preservar travados" inclui imoveis com lock vigente em `publish_locks`.
- O total de anuncios de um portal e calculado pela soma das quantidades em `publish_portal_ad_types`.

## Producao Via Gateway PostgREST

Em producao na Vercel, o banco nao deve ser acessado pela porta Postgres. A aplicacao deve chamar o gateway PostgREST, em um modelo parecido com a REST API do Supabase usando service key.

Variaveis da Vercel:

```env
PUBLISH_CONTROL_DATA_API_URL="https://pgapi.shprimenegocios.com.br"
PUBLISH_CONTROL_SERVICE_KEY="<PGRST_JWT_SECRET ou JWT_COM_ROLE_service_role>"
```

`PUBLISH_CONTROL_SERVICE_KEY` pode ser o segredo simples usado em `PGRST_JWT_SECRET` ou um JWT ja pronto com role `service_role`. Quando a variavel recebe o segredo simples, o backend gera automaticamente um JWT assinado em runtime e usa esse token nos headers do PostgREST.

A service key deve ser usada somente no servidor. Nunca exponha `PUBLISH_CONTROL_SERVICE_KEY` em componentes client-side ou no browser.

Headers esperados nas chamadas server-side:

```http
Authorization: Bearer <JWT_service_role_gerado_ou_fornecido>
apikey: <JWT_service_role_gerado_ou_fornecido>
```

O header `apikey` e mantido por compatibilidade conceitual com Supabase. No PostgREST puro, o header realmente necessario para trocar a role e `Authorization`.

Status validado em 2026-05-08:

- DNS `pgapi.shprimenegocios.com.br` resolve para `server-main.shprimenegocios.com.br` / `178.156.131.30`.
- Portas `80` e `443` abertas.
- Raiz HTTPS do gateway responde `200` com `server: postgrest/14.11`.
- Sem service key, leitura em `base_imoveis` retorna `401`, como esperado.
- Com service key `service_role`, leitura em `base_imoveis` retorna `200`.
- Com service key `service_role`, CRUD em `publish_portals` foi validado com `POST` e `DELETE`.

## Roles Do PostgREST

As roles foram configuradas no banco `base_dados`:

- `authenticator`: role com login usada pelo container PostgREST para conectar no Postgres.
- `anon`: role anonima padrao do PostgREST, sem foco de uso pela aplicacao.
- `service_role`: role de servico usada via JWT/service key para acesso amplo ao schema `public`.

Stack do gateway:

```yaml
PGRST_DB_URI: "postgres://authenticator:owbaMiYwgwigoY6PegRZek8OWyST2JEPYPFwDNvXMjr@pgvector:5433/base_dados"
PGRST_DB_SCHEMA: "public"
PGRST_DB_ANON_ROLE: "anon"
PGRST_JWT_SECRET: "owbaMiYwgwigoY6PegRZek8OWyST2JEPYPFwDNvXMjr"
PGRST_SERVER_PROXY_URI: "https://pgapi.shprimenegocios.com.br"
```

O `PGRST_JWT_SECRET` assina a service key JWT. Se `PUBLISH_CONTROL_SERVICE_KEY` receber o segredo simples, a aplicacao gera automaticamente um JWT com:

```json
{
  "role": "service_role"
}
```

## CRUD E Views

CRUD comum usa endpoints REST do PostgREST:

- `/publish_portals`
- `/publish_portal_ad_types`
- `/publish_rules`
- `/base_imoveis`
- `/publish_locks`

CRUD de views nao deve expor SQL livre pela API. Em producao, a aplicacao deve salvar a regra em `publish_rules` e chamar RPCs controladas no Postgres:

- `/rpc/refresh_publish_rule_view`
- `/rpc/drop_publish_rule_view`
- opcional: `/rpc/preview_publish_rule`

Essas RPCs devem criar, atualizar ou remover as views `pc_*` com base nos filtros estruturados salvos em `publish_rules`.

O codigo server-side ja escolhe automaticamente:

- `PUBLISH_CONTROL_DATA_API_URL` + `PUBLISH_CONTROL_SERVICE_KEY`: usa PostgREST.
- Sem essas variaveis: usa `DATABASE_URL` direto.

As RPCs de producao sao instaladas por:

```bash
node scripts/install-postgrest-rpcs.mjs
```

Depois de instalar ou alterar RPCs, reinicie/redeploye o servico `api_gateway` se o PostgREST retornar `PGRST202`, pois isso indica schema cache antigo.

## Testes Do Gateway

Teste de porta:

```powershell
Test-NetConnection pgapi.shprimenegocios.com.br -Port 443
```

Teste com service key:

```powershell
node -e "const https=require('https'); const key=process.env.PUBLISH_CONTROL_SERVICE_KEY; https.get('https://pgapi.shprimenegocios.com.br/base_imoveis?select=id_interno,codigo_crm&limit=1',{headers:{Authorization:'Bearer '+key,apikey:key}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>console.log(res.statusCode,b));});"
```

Em Windows, `curl.exe` pode falhar no TLS via Schannel mesmo quando o gateway esta funcional. Use Node ou outro cliente HTTP se isso acontecer.

Se Node retornar `self-signed certificate`, o Traefik ainda esta servindo certificado invalido/default. A Vercel precisara de certificado publico valido no gateway.

Teste de role no banco:

```sql
select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole
from pg_roles
where rolname in ('anon', 'service_role', 'authenticator')
order by rolname;
```
