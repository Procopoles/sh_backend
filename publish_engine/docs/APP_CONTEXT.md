# Publish Control - Contexto Atual

Ultima atualizacao: 2026-05-08.

## Objetivo

Aplicacao de controle visual de publicacoes de imoveis por portal.

A interface precisa permitir:

- CRUD de portais.
- CRUD de tipos/niveis de anuncio e cotas por portal.
- CRUD de regras de publicacao.
- Preview de quantidade de imoveis por regra.
- Criacao, atualizacao e remocao de views `public.pc_*` que representam os imoveis dentro de cada regra.

## Stack Atual

- Frontend/backend: Next.js App Router.
- Banco: Postgres `base_dados`.
- Desenvolvimento local: conexao direta via `DATABASE_URL`.
- Producao: Vercel chamando gateway PostgREST HTTPS.
- Gateway: `https://pgapi.shprimenegocios.com.br`.

Arquivos principais:

- `app/page.tsx`: interface de CRUD visual.
- `app/api/*`: APIs server-side da aplicacao.
- `lib/repository.ts`: escolhe gateway PostgREST quando configurado e conexao direta como fallback local.
- `lib/data-api.ts`: cliente PostgREST com headers `Authorization` e `apikey`.
- `lib/rules.ts`: montagem controlada dos filtros SQL.
- `scripts/install-postgrest-rpcs.mjs`: instala/atualiza RPCs usadas em producao.

## Contexto Fixo De UI/CSS

Este bloco deve ser consultado antes de qualquer alteracao em `app/page.tsx` ou `app/globals.css`.

Layout atual esperado:

- Menu esquerdo: apenas a aba `Portais`.
- Centro: listagem de todos os portais, com busca, `Adicionar portal` e `Atualizar`.
- Direita: painel lateral de edicao do portal, com informacoes principais, logo, cotas/tipos e regras do portal.
- Em desktop e notebooks largos, o editor do portal deve permanecer na lateral direita, nao abaixo da listagem.
- Em viewport estreita, o layout pode empilhar, mas sem sobreposicao, corte de texto ou controles fora da tela.

Regras de verificacao obrigatorias para mudancas visuais:

- Remover ou atualizar seletores CSS antigos quando o JSX correspondente deixar de existir.
- Evitar seletores globais amplos que afetem controles personalizados sem escopo.
- Rodar `npm.cmd run typecheck` e `npm.cmd run build`.
- Nao rodar `npm.cmd run build` enquanto `npm.cmd run dev` estiver ativo usando a mesma pasta `.next`; isso pode corromper o cache de desenvolvimento e causar 500/tela sem CSS. Para validar build, parar o servidor dev, limpar/reiniciar se necessario, rodar build e depois subir o dev server novamente.
- Fazer busca por classes antigas/sem uso quando alterar layout: `rg -n 'workspace-grid|rules-panel|compact-form|portal-item|rules-row|portal-list|section-title|form-grid|check-row|className="editor-panel"' app`.
- Verificar no navegador local a pagina principal em pelo menos uma largura desktop e uma largura menor antes de considerar UI/CSS concluido.

## Operacao Local No Windows E Cache Do Next

Caminho correto do projeto:

```powershell
C:\Stuffs\Aplicacoes\Score API\publish_control
```

Sempre que houver atualizacoes, limpeza de cache, build ou reinicio do servidor local, confirmar que o comando esta sendo executado nesse caminho. Em comandos automatizados, usar `workdir` igual a `C:\Stuffs\Aplicacoes\Score API\publish_control`.

Servidor local preferencial:

```powershell
npm.cmd run dev -- --hostname 127.0.0.1 --port 3001
```

URL local esperada:

```text
http://127.0.0.1:3001
```

Procedimento usado para redefinir cache quando o Windows nega acesso a arquivos da pasta `.next`:

1. Confirmar que o alvo esta dentro do workspace antes de remover:

```powershell
$workspace = (Resolve-Path '.').Path
$target = (Resolve-Path '.next').Path
if (-not $target.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove outside workspace: $target"
}
```

2. Verificar servidores Next ativos nas portas locais:

```powershell
netstat -ano -p TCP | Select-String ':3000|:3001'
```

3. Parar apenas os PIDs que estiverem escutando `127.0.0.1:3000` ou `127.0.0.1:3001` para este projeto. Exemplo:

```powershell
Stop-Process -Id <PID_3000>,<PID_3001> -Force -ErrorAction SilentlyContinue
```

4. Remover `.next` depois de parar o dev server:

```powershell
Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
```

5. Se o Windows ainda retornar `Acesso negado`, `UnauthorizedAccessException`, `IOException` ou o Next falhar com `spawn EPERM`, repetir a remocao ou o start do dev server com execucao fora do sandbox/elevacao aprovada. Esse foi o contorno necessario para limpar arquivos travados/gerados pelo Next no Windows.

6. Reiniciar o dev server em `127.0.0.1:3001` e confirmar recompilacao limpa pelos logs:

```powershell
npm.cmd run dev -- --hostname 127.0.0.1 --port 3001
```

Sinais esperados nos logs:

```text
Ready
Compiled /
GET / 200
```

Observacao: se o navegador ainda exibir estado antigo apos a limpeza, fazer hard refresh (`Ctrl+F5`).

## Banco E Tabelas

Tabelas base existentes:

- `base_imoveis`: ficha completa dos imoveis.
- `publish_locks`: imoveis com trava para despublicacao ou mudanca de tipo de anuncio.

Tabelas criadas pela aplicacao:

- `publish_portals`: cadastro de portais.
- `publish_portal_ad_types`: tipos/niveis de anuncio por portal, com `name` e `quantity`.
- `publish_rules`: regras, filtros JSON, `view_name`, `last_sql`, `last_count`.

O total de anuncios/cotas de um portal e calculado por `sum(quantity)` em `publish_portal_ad_types`.

Contagens observadas em 2026-05-08:

- `base_imoveis`: aproximadamente 244.815 registros.
- `publish_locks`: aproximadamente 1.231 registros.

## Gateway PostgREST

Modelo escolhido: semelhante a Supabase REST API com service key.

Stack do `api_gateway`:

```yaml
PGRST_DB_URI: "postgres://authenticator:owbaMiYwgwigoY6PegRZek8OWyST2JEPYPFwDNvXMjr@pgvector:5433/base_dados"
PGRST_DB_SCHEMA: "public"
PGRST_DB_ANON_ROLE: "anon"
PGRST_JWT_SECRET: "owbaMiYwgwigoY6PegRZek8OWyST2JEPYPFwDNvXMjr"
PGRST_SERVER_PROXY_URI: "https://pgapi.shprimenegocios.com.br"
```

DNS e conectividade validados:

- `pgapi.shprimenegocios.com.br` aponta para `server-main.shprimenegocios.com.br`.
- IP atual observado: `178.156.131.30`.
- Portas `80` e `443` abertas.
- HTTP `80` redireciona para HTTPS.
- HTTPS responde PostgREST `14.11`.

## Roles Configuradas

Roles criadas no banco `base_dados`:

- `authenticator`: role com login usada pelo PostgREST.
- `anon`: role anonima padrao do PostgREST.
- `service_role`: role via JWT/service key para acesso amplo ao schema `public`.

Estado validado:

- `authenticator` tem `LOGIN`.
- `anon` e `service_role` nao tem `LOGIN`.
- Nenhuma das tres roles e superuser.
- `authenticator` recebeu grants para assumir `anon` e `service_role`.
- `service_role` recebeu privilegios amplos em tabelas, sequences e functions do schema `public`.

Service key:

- A service key e um JWT assinado com `PGRST_JWT_SECRET`.
- Payload minimo:

```json
{
  "role": "service_role"
}
```

Uso pela aplicacao:

```http
Authorization: Bearer <PUBLISH_CONTROL_SERVICE_KEY>
apikey: <PUBLISH_CONTROL_SERVICE_KEY>
```

`PUBLISH_CONTROL_SERVICE_KEY` deve existir apenas em ambiente server-side da Vercel.

## Variaveis De Ambiente

Local:

```env
DATABASE_URL="postgres://postgres:password@host:5433/base_dados"
```

Producao:

```env
PUBLISH_CONTROL_DATA_API_URL="https://pgapi.shprimenegocios.com.br"
PUBLISH_CONTROL_SERVICE_KEY="<JWT_COM_ROLE_service_role>"
```

Nao expor a service key em codigo client-side.

## Fluxo De Dados Desejado

Em producao, o codigo deve preferir o gateway quando `PUBLISH_CONTROL_DATA_API_URL` e `PUBLISH_CONTROL_SERVICE_KEY` estiverem configurados.

CRUD comum via PostgREST:

- `/publish_portals`
- `/publish_portal_ad_types`
- `/publish_rules`
- `/base_imoveis`
- `/publish_locks`

CRUD de views via RPC:

- `/rpc/refresh_publish_rule_view`
- `/rpc/drop_publish_rule_view`
- opcional: `/rpc/preview_publish_rule`

A aplicacao nunca deve enviar SQL livre para o gateway. A interface salva filtros estruturados em `publish_rules` e chama RPCs controladas para criar/remover views.

RPCs instaladas no banco:

- `publish_base_columns()`: metadados das colunas filtraveis de `base_imoveis`.
- `publish_control_counts()`: contagens de `base_imoveis` e `publish_locks`.
- `publish_source_views()`: lista todas as views e materialized views do schema `public` disponiveis como preset inicial.
- `preview_publish_rule(filters, include_locked, active)`: contagem sem criar view.
- `refresh_publish_rule_view(rule_id)`: cria/atualiza a view e atualiza `last_sql`/`last_count`.
- `drop_publish_rule_view(rule_id)`: remove a view `pc_*` e limpa metadados da regra.

## Status Dos Testes

Validado com cliente HTTPS Node:

- `GET /` retornou `200` e OpenAPI do PostgREST.
- `GET /base_imoveis?...` sem service key retornou `401`.
- `GET /base_imoveis?...` com service key retornou `200`.
- `POST /publish_portals` com service key retornou `201`.
- `DELETE /publish_portals?slug=eq.teste_api_gateway` removeu o registro temporario de teste.

Observacao: `curl.exe` no Windows falhou no HTTPS por erro local Schannel `SEC_E_NO_CREDENTIALS`; Node acessou normalmente.

Validado via conexao direta:

- `node scripts/install-postgrest-rpcs.mjs` executou com sucesso.
- A tabela `publish_portal_ad_types` foi criada e recebeu grants para `service_role`.
- `refresh_publish_rule_view` criou uma view temporaria `pc_teste_rpc_regra_rpc_*`.
- `preview_publish_rule` retornou a mesma contagem de `last_count`.
- `drop_publish_rule_view` removeu a view temporaria.

Validado na aplicacao local em `http://127.0.0.1:3001`:

- `/api/health` retornou `mode: direct-db`.
- `/api/metadata` retornou colunas e contagens.
- `/api/rules/preview` retornou `1212` para `status = Disponivel`.
- `/api/portals` criou um portal temporario com tipos `padrao`, `destaque` e `super destaque`.
- O total de cotas foi validado em `8200`, depois editado para `8000`.
- O portal temporario e os tipos foram removidos.

## Pendencias Operacionais

- Reiniciar/redeployar `api_gateway` depois da instalacao das RPCs. O `NOTIFY pgrst, 'reload schema'` foi enviado, mas o gateway ainda retornou `PGRST202`, indicando cache antigo.
- Corrigir o certificado HTTPS do gateway: cliente Node sem `rejectUnauthorized:false` retornou `self-signed certificate`. A Vercel precisara de certificado publico valido.
- Validar fluxo completo na Vercel com `PUBLISH_CONTROL_DATA_API_URL` e `PUBLISH_CONTROL_SERVICE_KEY`.
