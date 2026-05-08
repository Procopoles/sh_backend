"""
Entrypoint Vercel - expoe a variavel `app` (FastAPI/ASGI).
"""

from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

from lib.frontend_html import FRONTEND_HTML as FRONTEND_HTML_V2
from lib.models import (
    AnalysisRequest,
    AnalysisResponse,
    AreaInput,
    AreaPatchInput,
    AreaSummary,
)
from lib.geo_service import analyze
from lib.areas_repository import repository
from lib.kml_service import build_automatic_area_record, preview_automatic_source

app = FastAPI(
    title="Geo Analysis API",
    description=(
        "Verifica se um ponto esta dentro de areas geograficas "
        "e calcula a distancia ate a borda mais proxima."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_HTML = """
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Score API - Areas no Mapa</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <style>
    :root {
      --bg: #f3f4f6;
      --panel: #ffffff;
      --text: #0f172a;
      --subtle: #475569;
      --border: #dbe3ed;
      --primary: #006d77;
      --danger: #b42318;
      --radius: 12px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "Segoe UI", Tahoma, sans-serif;
      background: radial-gradient(circle at 0 0, #ecf8ff 0, #f8fafc 45%, var(--bg) 100%);
    }
    .container {
      max-width: 1300px;
      margin: 0 auto;
      padding: 16px;
    }
    h1, h2, h3 { margin: 0 0 10px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
    }
    .muted { color: var(--subtle); font-size: 13px; }
    .hero {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      margin-bottom: 14px;
    }
    #map {
      width: 100%;
      height: 55vh;
      min-height: 360px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .grid {
      display: grid;
      grid-template-columns: 1.3fr 1fr;
      gap: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th { color: var(--subtle); font-weight: 600; }
    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      background: #e8edf2;
      font-size: 13px;
      color: #111827;
    }
    button.primary { background: var(--primary); color: #fff; }
    button.danger { background: var(--danger); color: #fff; }
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    .form-row.full { grid-template-columns: 1fr; }
    label {
      font-size: 12px;
      color: var(--subtle);
      margin-bottom: 4px;
      display: block;
    }
    input, textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 10px;
      font-size: 14px;
      font-family: inherit;
    }
    textarea {
      min-height: 170px;
      resize: vertical;
    }
    .status {
      margin-top: 8px;
      min-height: 18px;
      font-size: 13px;
    }
    pre {
      background: #0f172a;
      color: #dbeafe;
      border-radius: 8px;
      padding: 12px;
      overflow: auto;
      max-height: 240px;
      font-size: 12px;
      margin: 8px 0 0;
    }
    @media (max-width: 980px) {
      #map { height: 45vh; min-height: 320px; }
      .grid { grid-template-columns: 1fr; }
      .form-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <section class="hero">
      <div class="panel">
        <h1>Gestao de Areas</h1>
        <p class="muted">Visualizacao estilo mapa e CRUD simplificado.</p>
        <div id="map"></div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Areas cadastradas</h2>
        <div class="muted" id="list-meta">Carregando...</div>
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Slug</th>
              <th>Polygons</th>
              <th>Pontos</th>
              <th>Acoes</th>
            </tr>
          </thead>
          <tbody id="areas-body"></tbody>
        </table>
      </div>

      <div class="panel">
        <h2 id="form-title">Nova area</h2>
        <form id="area-form">
          <div class="form-row">
            <div>
              <label for="name">Nome</label>
              <input id="name" required />
            </div>
            <div>
              <label for="slug">Slug</label>
              <input id="slug" required pattern="^[a-z0-9_]+$" />
            </div>
          </div>
          <div class="form-row">
            <div>
              <label for="agencia">Agencia</label>
              <input id="agencia" required />
            </div>
            <div>
              <label for="relevancia">Relevancia (1-10)</label>
              <input id="relevancia" type="number" min="1" max="10" required />
            </div>
          </div>
          <div class="form-row full">
            <div>
              <label for="polygons">Polygons (JSON array ou GeoJSON FeatureCollection)</label>
              <textarea id="polygons" required>[{"type":"Polygon","coordinates":[[[-46.64,-23.55],[-46.62,-23.55],[-46.62,-23.56],[-46.64,-23.56],[-46.64,-23.55]]]}]</textarea>
            </div>
          </div>
          <div class="row-actions">
            <button class="primary" type="submit">Salvar</button>
            <button type="button" id="preview-btn">Preview no mapa</button>
            <button type="button" id="reset-btn">Limpar</button>
          </div>
        </form>
        <div class="status" id="status"></div>

        <h3 style="margin-top:14px;">Area selecionada (JSON)</h3>
        <pre id="area-json">Selecione uma area para visualizar os polygons.</pre>
      </div>
    </section>
  </div>

  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>
  <script>
    const apiBase = "/api/v1/areas";
    let editingSlug = null;
    let selectedSlug = null;
    let previewLayer = null;

    const map = L.map("map", { zoomControl: true }).setView([-23.55, -46.63], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const areaLayerGroup = L.featureGroup().addTo(map);
    const areaLayersBySlug = new Map();

    const els = {
      body: document.getElementById("areas-body"),
      listMeta: document.getElementById("list-meta"),
      formTitle: document.getElementById("form-title"),
      form: document.getElementById("area-form"),
      name: document.getElementById("name"),
      slug: document.getElementById("slug"),
      agencia: document.getElementById("agencia"),
      relevancia: document.getElementById("relevancia"),
      polygons: document.getElementById("polygons"),
      status: document.getElementById("status"),
      areaJson: document.getElementById("area-json"),
      previewBtn: document.getElementById("preview-btn"),
      resetBtn: document.getElementById("reset-btn"),
    };

    function setStatus(message, isError = false) {
      els.status.textContent = message;
      els.status.style.color = isError ? "#b42318" : "#12703d";
    }

    function colorFromSlug(slug) {
      let hash = 0;
      for (let i = 0; i < slug.length; i++) hash = slug.charCodeAt(i) + ((hash << 5) - hash);
      const hue = Math.abs(hash) % 360;
      return `hsl(${hue}, 72%, 42%)`;
    }

    function polygonsToLeafletLatLngs(polygons) {
      if (!Array.isArray(polygons)) {
        throw new Error("Formato invalido para polygons: esperado array.");
      }
      return polygons.map((polygon) => {
        const rings = polygon.coordinates || [];
        return rings.map((ring) => ring.map((coord) => [coord[1], coord[0]]));
      });
    }

    function normalizePolygonsInput(rawInput) {
      if (Array.isArray(rawInput)) return rawInput;

      if (rawInput && Array.isArray(rawInput.polygons)) {
        return rawInput.polygons;
      }

      if (rawInput && rawInput.type === "Polygon" && Array.isArray(rawInput.coordinates)) {
        return [{
          type: "Polygon",
          coordinates: rawInput.coordinates,
        }];
      }

      if (rawInput && rawInput.type === "MultiPolygon" && Array.isArray(rawInput.coordinates)) {
        return rawInput.coordinates.map((coordinates) => ({
          type: "Polygon",
          coordinates,
        }));
      }

      if (rawInput && rawInput.type === "Feature") {
        return normalizePolygonsInput({
          type: "FeatureCollection",
          features: [rawInput],
        });
      }

      if (rawInput && rawInput.type === "FeatureCollection" && Array.isArray(rawInput.features)) {
        const polygons = [];

        for (const feature of rawInput.features) {
          const geometry = feature && feature.geometry;
          if (!geometry || !geometry.type || !geometry.coordinates) continue;

          if (geometry.type === "Polygon") {
            polygons.push({
              type: "Polygon",
              coordinates: geometry.coordinates,
            });
          }

          if (geometry.type === "MultiPolygon") {
            for (const coordinates of geometry.coordinates) {
              polygons.push({
                type: "Polygon",
                coordinates,
              });
            }
          }
        }

        if (!polygons.length) {
          throw new Error("GeoJSON sem geometrias do tipo Polygon/MultiPolygon.");
        }

        return polygons;
      }

      throw new Error("Formato invalido. Use JSON array de polygons ou FeatureCollection GeoJSON.");
    }

    function validatePolygonsForApi(polygons) {
      if (!Array.isArray(polygons) || !polygons.length) {
        throw new Error("Informe ao menos um Polygon valido.");
      }

      polygons.forEach((polygon, polyIndex) => {
        if (!polygon || polygon.type !== "Polygon" || !Array.isArray(polygon.coordinates)) {
          throw new Error(`Polygon ${polyIndex + 1} invalido.`);
        }

        if (!polygon.coordinates.length) {
          throw new Error(`Polygon ${polyIndex + 1} sem aneis.`);
        }

        polygon.coordinates.forEach((ring, ringIndex) => {
          if (!Array.isArray(ring) || ring.length < 4) {
            throw new Error(
              `Polygon ${polyIndex + 1}, anel ${ringIndex + 1} precisa de ao menos 4 pontos.`
            );
          }
        });
      });
    }

    function parsePolygonsFromInput(isPreview = false) {
      let parsed;
      try {
        parsed = JSON.parse(els.polygons.value);
      } catch (error) {
        throw new Error(isPreview ? "JSON invalido para preview." : "JSON de polygons invalido.");
      }
      const polygons = normalizePolygonsInput(parsed);
      validatePolygonsForApi(polygons);
      return polygons;
    }

    function extractApiErrorMessage(err) {
      if (!err || !err.detail) return "Falha ao salvar area.";
      if (typeof err.detail === "string") return err.detail;
      if (Array.isArray(err.detail)) {
        return err.detail
          .map((item) => {
            if (!item) return "";
            const loc = Array.isArray(item.loc) ? item.loc.join(".") : "";
            const msg = item.msg || "";
            return loc ? `${loc}: ${msg}` : msg;
          })
          .filter(Boolean)
          .join(" | ");
      }
      return "Falha ao salvar area.";
    }

    function removePreviewLayer() {
      if (previewLayer) {
        map.removeLayer(previewLayer);
        previewLayer = null;
      }
    }

    function highlightSelectedArea() {
      areaLayersBySlug.forEach((entry, slug) => {
        const baseColor = entry.color;
        const isSelected = slug === selectedSlug;
        entry.layer.setStyle({
          color: baseColor,
          weight: isSelected ? 4 : 2,
          fillOpacity: isSelected ? 0.35 : 0.18,
        });
        if (isSelected) entry.layer.bringToFront();
      });
    }

    function drawAreaOnMap(area) {
      const color = colorFromSlug(area.slug);
      let latLngPolygons;
      try {
        latLngPolygons = polygonsToLeafletLatLngs(area.polygons || []);
      } catch (error) {
        return;
      }
      const layers = latLngPolygons.map((latLngRings) =>
        L.polygon(latLngRings, {
          color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.18,
        })
      );
      const layer = L.featureGroup(layers);
      layer.bindPopup(`<strong>${area.name}</strong><br/>${area.slug}`);
      layer.on("click", () => {
        selectedSlug = area.slug;
        highlightSelectedArea();
        viewArea(area.slug);
      });
      areaLayerGroup.addLayer(layer);
      areaLayersBySlug.set(area.slug, { layer, color });
    }

    async function fitMapToAllAreas() {
      if (!areaLayerGroup.getLayers().length) return;
      const bounds = areaLayerGroup.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));
    }

    function resetForm() {
      editingSlug = null;
      els.formTitle.textContent = "Nova area";
      els.form.reset();
      els.relevancia.value = 1;
      els.polygons.value = '[{"type":"Polygon","coordinates":[[[-46.64,-23.55],[-46.62,-23.55],[-46.62,-23.56],[-46.64,-23.56],[-46.64,-23.55]]]}]';
      els.areaJson.textContent = "Selecione uma area para visualizar os polygons.";
      selectedSlug = null;
      highlightSelectedArea();
      removePreviewLayer();
      setStatus("");
    }

    async function getAreaDetails(slug) {
      const res = await fetch(`${apiBase}/${slug}`);
      if (!res.ok) throw new Error(`Falha ao carregar area ${slug}.`);
      return res.json();
    }

    async function loadAreas() {
      const res = await fetch(apiBase);
      if (!res.ok) throw new Error("Falha ao carregar areas.");
      const summaries = await res.json();
      els.listMeta.textContent = summaries.length + " area(s)";

      if (!summaries.length) {
        els.body.innerHTML = '<tr><td colspan="5" class="muted">Nenhuma area cadastrada.</td></tr>';
        areaLayerGroup.clearLayers();
        areaLayersBySlug.clear();
        return;
      }

      els.body.innerHTML = summaries.map((area) => `
        <tr>
          <td>${area.name}</td>
          <td><code>${area.slug}</code></td>
          <td>${area.polygon_count}</td>
          <td>${area.total_points}</td>
          <td>
            <div class="row-actions">
              <button onclick="viewArea('${area.slug}')">Ver</button>
              <button onclick="focusAreaOnMap('${area.slug}')">Mapa</button>
              <button onclick="editArea('${area.slug}')">Editar</button>
              <button class="danger" onclick="deleteArea('${area.slug}')">Excluir</button>
            </div>
          </td>
        </tr>
      `).join("");

      areaLayerGroup.clearLayers();
      areaLayersBySlug.clear();
      const detailedAreas = await Promise.all(summaries.map((area) => getAreaDetails(area.slug)));
      detailedAreas.forEach(drawAreaOnMap);
      highlightSelectedArea();
      await fitMapToAllAreas();
    }

    async function viewArea(slug) {
      const data = await getAreaDetails(slug);
      selectedSlug = slug;
      els.areaJson.textContent = JSON.stringify(data, null, 2);
      highlightSelectedArea();
      const layerEntry = areaLayersBySlug.get(slug);
      if (layerEntry) {
        const bounds = layerEntry.layer.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      }
    }

    function focusAreaOnMap(slug) {
      selectedSlug = slug;
      highlightSelectedArea();
      const layerEntry = areaLayersBySlug.get(slug);
      if (!layerEntry) return;
      const bounds = layerEntry.layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      layerEntry.layer.openPopup();
    }

    async function editArea(slug) {
      const data = await getAreaDetails(slug).catch(() => null);
      if (!data) {
        setStatus("Nao foi possivel carregar area para edicao.", true);
        return;
      }
      editingSlug = slug;
      els.formTitle.textContent = `Editando: ${slug}`;
      els.name.value = data.name || "";
      els.slug.value = data.slug || "";
      els.agencia.value = data.agencia || "";
      els.relevancia.value = data.relevancia || 1;
      els.polygons.value = JSON.stringify(data.polygons || [], null, 2);
      selectedSlug = slug;
      els.areaJson.textContent = JSON.stringify(data, null, 2);
      highlightSelectedArea();
      setStatus("Modo edicao ativado.");
    }

    async function deleteArea(slug) {
      const ok = confirm(`Excluir a area '${slug}'?`);
      if (!ok) return;
      const res = await fetch(`${apiBase}/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(err.detail || "Erro ao excluir area.", true);
        return;
      }
      setStatus(`Area '${slug}' removida.`);
      if (editingSlug === slug) resetForm();
      if (selectedSlug === slug) selectedSlug = null;
      await loadAreas();
    }

    function previewPolygons() {
      removePreviewLayer();
      let polygonsParsed;
      let latLngPolygons;
      try {
        polygonsParsed = parsePolygonsFromInput(true);
        latLngPolygons = polygonsToLeafletLatLngs(polygonsParsed);
      } catch (error) {
        setStatus(error.message || "Falha no preview dos polygons.", true);
        return;
      }
      const layers = latLngPolygons.map((latLngRings) =>
        L.polygon(latLngRings, {
          color: "#111827",
          weight: 2,
          fillColor: "#60a5fa",
          fillOpacity: 0.2,
          dashArray: "6 5",
        })
      );
      previewLayer = L.featureGroup(layers).addTo(map);
      const bounds = previewLayer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      setStatus("Preview aplicado no mapa.");
    }

    async function saveArea(event) {
      event.preventDefault();
      removePreviewLayer();

      let polygonsParsed;
      try {
        polygonsParsed = parsePolygonsFromInput(false);
      } catch (error) {
        setStatus(error.message || "Falha ao ler polygons.", true);
        return;
      }

      const payload = {
        name: els.name.value.trim(),
        slug: els.slug.value.trim(),
        agencia: els.agencia.value.trim(),
        relevancia: Number(els.relevancia.value),
        polygons: polygonsParsed,
      };

      const isEditing = !!editingSlug;
      const method = isEditing ? "PATCH" : "POST";
      const url = isEditing ? `${apiBase}/${editingSlug}` : apiBase;
      const body = isEditing
        ? JSON.stringify({
            name: payload.name,
            slug: payload.slug,
            agencia: payload.agencia,
            relevancia: payload.relevancia,
            polygons: payload.polygons,
          })
        : JSON.stringify(payload);

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(extractApiErrorMessage(err), true);
        return;
      }

      const targetSlug = payload.slug;
      setStatus(isEditing ? "Area atualizada com sucesso." : "Area salva com sucesso.");
      editingSlug = targetSlug;
      selectedSlug = targetSlug;
      await loadAreas();
      await viewArea(targetSlug);
    }

    els.form.addEventListener("submit", saveArea);
    els.previewBtn.addEventListener("click", previewPolygons);
    els.resetBtn.addEventListener("click", resetForm);

    resetForm();
    loadAreas().catch((err) => {
      els.listMeta.textContent = "Erro ao carregar.";
      setStatus(err.message || "Erro inesperado.", true);
    });

    window.viewArea = viewArea;
    window.focusAreaOnMap = focusAreaOnMap;
    window.editArea = editArea;
    window.deleteArea = deleteArea;
  </script>
</body>
</html>
"""


FRONTEND_HTML = FRONTEND_HTML_V2


def _normalize_source_kind(source_kind: str) -> str:
    normalized = (source_kind or "").strip().lower()
    if normalized not in {"kml_upload", "network_link"}:
        raise HTTPException(400, "source_kind deve ser 'kml_upload' ou 'network_link'.")
    return normalized


async def _read_upload(file: UploadFile) -> tuple[bytes, str]:
    file_name = (file.filename or "arquivo.kml").strip() or "arquivo.kml"
    content = await file.read()
    if not content:
        raise HTTPException(400, "O arquivo enviado esta vazio.")
    return content, file_name


def _set_no_store_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def frontend(response: Response):
    _set_no_store_headers(response)
    return FRONTEND_HTML


@app.post(
    "/api/v1/analyze",
    response_model=AnalysisResponse,
    summary="Analisa se um ponto esta dentro das areas solicitadas",
    tags=["Analise"],
)
def post_analyze(request: AnalysisRequest):
    return analyze(request)


@app.get(
    "/api/v1/areas",
    response_model=list[AreaSummary],
    summary="Lista todas as areas cadastradas",
    tags=["Areas"],
)
def list_areas(response: Response):
    _set_no_store_headers(response)
    return repository.list_all()


@app.get(
    "/api/v1/areas/{slug}",
    summary="Retorna detalhes de uma area",
    tags=["Areas"],
)
def get_area(slug: str, response: Response):
    _set_no_store_headers(response)
    data = repository.get_raw(slug)
    if data is None:
        raise HTTPException(404, f"Area '{slug}' nao encontrada.")
    return data


@app.post(
    "/api/v1/areas",
    status_code=201,
    summary="Cria ou atualiza uma area manual",
    tags=["Areas"],
)
def upsert_area(area: AreaInput):
    repository.upsert(area)
    return {"message": f"Area '{area.slug}' salva com sucesso."}


@app.post(
    "/api/v1/areas/automatic/preview",
    summary="Interpreta um arquivo KML/KMZ para preview no modo automatico",
    tags=["Areas"],
)
async def preview_automatic_area(
    source_kind: str = Form(...),
    refresh_interval_seconds: Optional[int] = Form(default=None),
    file: UploadFile = File(...),
):
    normalized_source_kind = _normalize_source_kind(source_kind)
    file_bytes, file_name = await _read_upload(file)

    try:
        preview = preview_automatic_source(
            source_kind=normalized_source_kind,
            file_bytes=file_bytes,
            file_name=file_name,
            refresh_interval_seconds=refresh_interval_seconds,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    return {
        "document_name": preview.get("document_name"),
        "polygons": preview["polygons"],
        "polygon_count": len(preview["polygons"]),
        "automatic_source": preview["automatic_source"],
    }


@app.post(
    "/api/v1/areas/automatic",
    status_code=201,
    summary="Cria ou atualiza uma area automatica a partir de um KML/KMZ",
    tags=["Areas"],
)
async def save_automatic_area(
    name: str = Form(...),
    slug: str = Form(...),
    agencia: str = Form(...),
    relevancia: int = Form(...),
    color: str = Form(...),
    source_kind: str = Form(...),
    refresh_interval_seconds: Optional[int] = Form(default=None),
    editing_slug: Optional[str] = Form(default=None),
    file: UploadFile = File(...),
):
    normalized_source_kind = _normalize_source_kind(source_kind)
    file_bytes, file_name = await _read_upload(file)

    if editing_slug and not repository.exists(editing_slug):
        raise HTTPException(404, f"Area '{editing_slug}' nao encontrada.")

    if editing_slug and editing_slug != slug and repository.exists(slug):
        raise HTTPException(409, f"Area '{slug}' ja existe.")

    try:
        area_record = build_automatic_area_record(
            source_kind=normalized_source_kind,
            file_bytes=file_bytes,
            file_name=file_name,
            refresh_interval_seconds=refresh_interval_seconds,
            name=name,
            slug=slug,
            agencia=agencia,
            relevancia=relevancia,
            color=color,
        )
        area = AreaInput.model_validate(area_record)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    repository.upsert(area)

    if editing_slug and editing_slug != slug:
        repository.delete(editing_slug)

    return {
        "message": f"Area automatica '{slug}' salva com sucesso.",
        "area": repository.get_raw(slug),
    }


@app.patch(
    "/api/v1/areas/{slug}",
    summary="Atualiza parcialmente uma area existente",
    tags=["Areas"],
)
def patch_area(slug: str, patch: AreaPatchInput):
    if not repository.exists(slug):
        raise HTTPException(404, f"Area '{slug}' nao encontrada.")

    patch_dict = patch.model_dump(exclude_none=True)
    new_slug = patch_dict.get("slug")

    if new_slug and new_slug != slug and repository.exists(new_slug):
        raise HTTPException(409, f"Area '{new_slug}' ja existe.")

    updated = repository.patch(slug, patch_dict)
    if updated is None:
        raise HTTPException(404, f"Area '{slug}' nao encontrada.")

    return {
        "message": f"Area '{slug}' atualizada com sucesso.",
        "area": updated,
    }


@app.post(
    "/api/v1/areas/{slug}/refresh",
    summary="Forca o refresh de uma area automatica",
    tags=["Areas"],
)
def refresh_area(slug: str):
    if not repository.exists(slug):
        raise HTTPException(404, f"Area '{slug}' nao encontrada.")

    current = repository.get_raw(slug)
    if current is None:
        raise HTTPException(404, f"Area '{slug}' nao encontrada.")

    if current.get("mode") != "automatic":
        raise HTTPException(400, "Apenas areas automaticas suportam refresh.")
    if (current.get("automatic_source") or {}).get("type") != "network_link":
        raise HTTPException(400, "Refresh manual so esta disponivel para areas com NetworkLink.")

    refreshed = repository.refresh_area(slug, force=True)
    return {
        "message": f"Refresh executado para '{slug}'.",
        "area": refreshed,
    }


@app.delete(
    "/api/v1/areas/{slug}",
    summary="Remove uma area",
    tags=["Areas"],
)
def delete_area(slug: str):
    if not repository.delete(slug):
        raise HTTPException(404, f"Area '{slug}' nao encontrada.")
    return {"message": f"Area '{slug}' removida."}
