# Geo Analysis API

API REST para verificar se um ponto geografico esta dentro de areas poligonais
e calcular a distancia ate a borda mais proxima.

## Deploy na Vercel

```bash
# 1. Instale a Vercel CLI
npm i -g vercel

# 2. Na raiz do projeto
vercel
```

## Variaveis de Ambiente (Vercel)

Configure estas variaveis no projeto:

- `MINIO_ENDPOINT=https://minioconsole.shprimenegocios.com.br`
- `MINIO_BUCKET=assets`
- `MINIO_OBJECT_KEY=areas/areas.json`
- `MINIO_ACCESS_KEY=<sua-chave>`
- `MINIO_SECRET_KEY=<seu-segredo>`
- `MINIO_REGION=us-east-1` (opcional)

## Dev Local

```bash
pip install -r requirements.txt
pip install uvicorn

uvicorn api.index:app --reload
```

Docs: `http://localhost:8000/docs`

## Endpoints

- `POST /api/v1/analyze`
- `GET /api/v1/areas`
- `GET /api/v1/areas/{slug}`
- `POST /api/v1/areas`
- `POST /api/v1/areas/automatic/preview`
- `POST /api/v1/areas/automatic`
- `POST /api/v1/areas/{slug}/refresh`
- `PATCH /api/v1/areas/{slug}`
- `DELETE /api/v1/areas/{slug}`

## Exemplo de Analyze

Request:

```json
{
  "target": { "lat": -23.555, "lng": -46.630 },
  "areas": ["area_principal"],
  "agencias": ["SH Perdizes"]
}
```

Response:

```json
{
  "results": [
    {
      "slug": "area_principal",
      "name": "Area Principal",
      "is_in": true,
      "nearest_border_distance_meters": 0,
      "agencia": "SH Perdizes",
      "relevancia": 8
    }
  ],
  "errors": null
}
```

## Persistencia

As areas sao lidas/escritas no MinIO (objeto configurado por `MINIO_OBJECT_KEY`).

O arquivo e carregado uma vez por instancia (cache em memoria) e reutilizado entre
requests. Se o cache estiver vazio, a API tenta recarregar do MinIO.

Operacoes de escrita (`POST`, `PATCH`, `DELETE`) atualizam o cache e enviam o JSON
atualizado para o MinIO.

## Modos da aplicacao

- `Manual`: mesmo fluxo atual, com polygons em JSON/GeoJSON.
- `Automatico`: upload de `KML`/`KMZ` para converter polygons automaticamente.
- `Automatico` com `NetworkLink`: a API salva a URL remota extraida do arquivo e
  tenta atualizar o mapa/polygons antes de listar, detalhar ou analisar uma area,
  persistindo o ultimo estado valido no mesmo JSON do object store.
