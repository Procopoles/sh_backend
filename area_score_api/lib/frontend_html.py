FRONTEND_HTML = """
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Score API - Gestao Manual de Areas</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <style>
    :root {
      --bg: #eef4f7;
      --panel: #ffffff;
      --panel-alt: #f7fbfc;
      --text: #10243d;
      --subtle: #5b7088;
      --border: #d7e1ea;
      --primary: #0b7285;
      --primary-strong: #0f5c73;
      --accent: #ff9f1c;
      --danger: #b42318;
      --success: #12703d;
      --shadow: 0 16px 38px rgba(16, 36, 61, 0.08);
      --radius: 18px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "Segoe UI", Tahoma, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(11, 114, 133, 0.12), transparent 28%),
        radial-gradient(circle at right bottom, rgba(255, 159, 28, 0.12), transparent 22%),
        linear-gradient(180deg, #f8fbfd 0%, var(--bg) 100%);
    }
    .container {
      max-width: 1380px;
      margin: 0 auto;
      padding: 20px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(320px, 0.8fr) minmax(460px, 1.2fr);
      gap: 16px;
      margin-bottom: 16px;
      align-items: stretch;
      transition: grid-template-columns 0.28s ease;
    }
    .hero-card {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 100%;
      background: linear-gradient(135deg, rgba(11, 114, 133, 0.08), rgba(255, 255, 255, 0.95));
    }
    .title-line {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .nav-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 999px;
      background: rgba(11, 114, 133, 0.12);
      color: var(--primary-strong);
      font-size: 14px;
      font-weight: 700;
      flex: 0 0 auto;
    }
    h1, h2, h3 { margin: 0; }
    .muted { color: var(--subtle); }
    .hero-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .metric {
      min-width: 140px;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.88);
      border: 1px solid rgba(11, 114, 133, 0.1);
    }
    .metric strong {
      display: block;
      font-size: 22px;
      margin-top: 4px;
    }
    .hero-note {
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.9);
      border: 1px dashed rgba(11, 114, 133, 0.24);
      font-size: 14px;
      color: var(--subtle);
    }
    .map-panel {
      transition: transform 0.24s ease, box-shadow 0.24s ease;
    }
    .map-toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .map-expanded .hero {
      grid-template-columns: 1fr;
    }
    .map-expanded .map-panel {
      grid-column: 1 / -1;
    }
    #map {
      width: 100%;
      height: 62vh;
      min-height: 420px;
      border-radius: 16px;
      border: 1px solid var(--border);
      overflow: hidden;
      transition: height 0.32s ease, min-height 0.32s ease;
    }
    .map-expanded #map {
      height: min(78vh, 860px);
      min-height: 560px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 16px;
    }
    .list-head,
    .editor-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      font-size: 12px;
      color: var(--subtle);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(11, 114, 133, 0.09);
      color: var(--primary-strong);
    }
    .badge.manual {
      background: rgba(255, 159, 28, 0.14);
      color: #965a00;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 12px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th { color: var(--subtle); font-weight: 600; }
    tr.agency-group-row td {
      padding: 16px 8px 8px;
      border-bottom: 0;
    }
    .agency-group {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      background: linear-gradient(135deg, rgba(11, 114, 133, 0.08), rgba(255, 255, 255, 0.96));
      border: 1px solid rgba(11, 114, 133, 0.12);
    }
    .agency-group strong {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }
    .agency-count {
      font-size: 12px;
      color: var(--subtle);
      white-space: nowrap;
    }
    .name-cell {
      display: grid;
      gap: 4px;
    }
    .mini {
      font-size: 12px;
      color: var(--subtle);
    }
    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 9px 12px;
      cursor: pointer;
      background: #e9eff4;
      font-size: 13px;
      color: var(--text);
      transition: transform 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 20px rgba(16, 36, 61, 0.09);
    }
    button.primary {
      background: linear-gradient(135deg, var(--primary), var(--primary-strong));
      color: #fff;
    }
    button.warning {
      background: #fff4df;
      color: #8a5600;
    }
    button.danger {
      background: var(--danger);
      color: #fff;
    }
    button.ghost {
      background: #fff;
      border: 1px solid var(--border);
    }
    .form-panel {
      display: none;
      gap: 12px;
    }
    .form-panel.active {
      display: grid;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .form-grid.triple {
      grid-template-columns: 1fr 1fr 120px;
    }
    .form-grid.identity {
      grid-template-columns: minmax(0, 1.25fr) minmax(180px, 0.75fr);
    }
    .form-grid.meta {
      grid-template-columns: minmax(0, 1fr) 148px 86px;
      align-items: end;
    }
    .form-grid.full {
      grid-template-columns: 1fr;
    }
    .form-section {
      display: grid;
      gap: 10px;
      padding: 14px 0;
      border-top: 1px solid var(--border);
    }
    .form-section:first-child {
      padding-top: 0;
      border-top: 0;
    }
    .form-section-head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .form-section-head strong {
      display: block;
      font-size: 14px;
    }
    .field-hint {
      margin-top: 5px;
      font-size: 12px;
      color: var(--subtle);
    }
    label {
      display: block;
      margin-bottom: 5px;
      font-size: 12px;
      color: var(--subtle);
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      background: #fff;
      color: var(--text);
    }
    .icon-input {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 0 10px;
      background: #fff;
    }
    .icon-input span {
      color: var(--accent);
      font-size: 15px;
      flex: 0 0 auto;
    }
    .icon-input input {
      border: 0;
      border-radius: 0;
      padding: 9px 0;
      text-align: center;
      background: transparent;
    }
    .icon-input input:focus {
      outline: 0;
    }
    .color-field {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }
    .color-picker {
      width: 52px;
      min-width: 52px;
      height: 42px;
      padding: 4px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: #fff;
      cursor: pointer;
      overflow: hidden;
    }
    .color-picker::-webkit-color-swatch-wrapper {
      padding: 0;
    }
    .color-picker::-webkit-color-swatch {
      border: 0;
      border-radius: 999px;
    }
    .color-picker::-moz-color-swatch {
      border: 0;
      border-radius: 999px;
    }
    .area-name-line {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .color-dot {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 1px solid rgba(16, 36, 61, 0.12);
      flex: 0 0 auto;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
    }
    .status {
      min-height: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .note-box {
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      font-size: 13px;
      color: var(--subtle);
      line-height: 1.45;
    }
    pre {
      margin: 10px 0 0;
      padding: 14px;
      border-radius: 16px;
      background: #0f172a;
      color: #dbeafe;
      max-height: 260px;
      overflow: auto;
      font-size: 12px;
    }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 6px;
    }
    .hidden {
      display: none !important;
    }
    @media (max-width: 1080px) {
      .hero,
      .grid {
        grid-template-columns: 1fr;
      }
      #map {
        height: 50vh;
        min-height: 360px;
      }
      .map-expanded #map {
        height: 68vh;
        min-height: 460px;
      }
    }
    @media (max-width: 740px) {
      .container { padding: 14px; }
      .form-grid,
      .form-grid.identity,
      .form-grid.meta {
        grid-template-columns: 1fr;
      }
      .list-head,
      .editor-head {
        flex-direction: column;
      }
      .hero-metrics {
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .map-toolbar {
        justify-content: flex-start;
      }
      .row-actions button {
        flex: 1 1 120px;
      }
    }
  </style>
</head>
<body>
  <div class="container" id="app-shell">
    <section class="hero">
      <div class="panel hero-card">
        <div>
          <div class="title-line">
            <span class="nav-icon">⌖</span>
            <h1>Gestao de Areas</h1>
          </div>
          <p class="muted" style="margin:8px 0 0;">
            Organize, revise e atualize manualmente as areas do mapa em um unico painel.
          </p>
        </div>
        <div class="hero-metrics">
          <div class="metric">
            <span class="mini">Areas no mapa</span>
            <strong id="metric-visible">0</strong>
          </div>
          <div class="metric">
            <span class="mini">Total manual</span>
            <strong id="metric-total">0</strong>
          </div>
          <div class="metric">
            <span class="mini">Agencias</span>
            <strong id="metric-agencies">0</strong>
          </div>
        </div>
        <div class="hero-note" id="mode-note">
          Fluxo focado em cadastro manual: preencha os metadados, revise o desenho no mapa e salve.
        </div>
      </div>
      <div class="panel map-panel">
        <div class="list-head" style="margin-bottom:12px;">
          <div>
            <div class="title-line">
              <span class="nav-icon">⌖</span>
              <h2>Mapa</h2>
            </div>
            <div class="muted" id="map-meta">Carregando areas...</div>
          </div>
          <div class="map-toolbar">
            <span class="pill" id="visible-filter-pill">Manual</span>
            <button class="ghost" id="map-expand-btn" type="button" aria-expanded="false" aria-label="Expandir visualizacao do mapa">⛶ Expandir</button>
          </div>
        </div>
        <div id="map"></div>
      </div>
    </section>

    <section class="grid">
      <div class="panel">
        <div class="list-head">
          <div>
            <div class="title-line">
              <span class="nav-icon">▦</span>
              <h2>Areas cadastradas</h2>
            </div>
            <div class="muted" id="list-meta">Carregando...</div>
          </div>
          <span class="pill">Cadastro manual</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Agencia</th>
              <th>Relevancia</th>
              <th>Pontos</th>
              <th>Acoes</th>
            </tr>
          </thead>
          <tbody id="areas-body"></tbody>
        </table>
      </div>

      <div class="panel">
        <div class="editor-head">
          <div>
            <div class="title-line">
              <span class="nav-icon">✎</span>
              <h2 id="editor-title">Cadastro manual</h2>
            </div>
            <div class="muted" id="editor-subtitle">Preencha em etapas e confirme a visualizacao antes de salvar.</div>
          </div>
          <span class="pill" id="editor-pill">Manual</span>
        </div>

        <div class="form-panel active" id="manual-panel">
          <form id="manual-form">
            <div class="form-section">
              <div class="form-section-head">
                <span class="nav-icon">ID</span>
                <div>
                  <strong>Identificacao</strong>
                  <div class="mini">Nome publico e identificador tecnico da area.</div>
                </div>
              </div>
              <div class="form-grid identity">
                <div>
                  <label for="manual-name">Nome</label>
                  <input id="manual-name" required />
                </div>
                <div>
                  <label for="manual-slug">Slug</label>
                  <input id="manual-slug" required pattern="^[a-z0-9_]+$" />
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-head">
                <span class="nav-icon">★</span>
                <div>
                  <strong>Classificacao</strong>
                  <div class="mini">Agencia responsavel, prioridade visual e cor no mapa.</div>
                </div>
              </div>
              <div class="form-grid meta">
                <div>
                  <label for="manual-agencia">Agencia</label>
                  <input id="manual-agencia" required />
                </div>
                <div>
                  <label for="manual-relevancia">Relevancia</label>
                  <div class="icon-input">
                    <span>★</span>
                    <input id="manual-relevancia" type="number" min="1" max="10" required />
                  </div>
                </div>
                <div class="color-field">
                  <label for="manual-color">Cor</label>
                  <input id="manual-color" class="color-picker" type="color" value="#0b7285" />
                </div>
              </div>
            </div>

            <div class="form-section">
              <div class="form-section-head">
                <span class="nav-icon">⌖</span>
                <div>
                  <strong>Geometria</strong>
                  <div class="mini">Cole um array de polygons ou uma FeatureCollection GeoJSON.</div>
                </div>
              </div>
              <div class="form-grid full">
                <div>
                  <label for="manual-polygons">Area do mapa</label>
                  <textarea id="manual-polygons" required>[{"type":"Polygon","coordinates":[[[-46.64,-23.55],[-46.62,-23.55],[-46.62,-23.56],[-46.64,-23.56],[-46.64,-23.55]]]}]</textarea>
                  <div class="field-hint">Use "Ver no mapa" para validar a geometria antes de salvar.</div>
                </div>
              </div>
            </div>
            <div class="row-actions" style="margin-top:10px;">
              <button class="primary" type="submit">✦ Salvar manual</button>
              <button type="button" id="manual-preview-btn">⌖ Ver no mapa</button>
              <button type="button" id="manual-reset-btn">↺ Limpar</button>
            </div>
          </form>
        </div>

        <div class="status" id="status"></div>

        <div class="section-title">
          <div class="title-line">
            <span class="nav-icon">◌</span>
            <h3>Detalhes da area</h3>
          </div>
          <span class="pill" id="selection-pill">Nenhuma area selecionada</span>
        </div>
        <pre id="area-json">Selecione uma area para visualizar os detalhes.</pre>
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
    const state = {
      activeMode: "manual",
      editingSlug: null,
      editingMode: null,
      selectedSlug: null,
      areas: [],
      previewLayer: null,
      mapRenderToken: 0,
      mapExpanded: false,
    };

    const DEFAULT_MANUAL_POLYGONS = '[{"type":"Polygon","coordinates":[[[-46.64,-23.55],[-46.62,-23.55],[-46.62,-23.56],[-46.64,-23.56],[-46.64,-23.55]]]}]';

    const map = L.map("map", { zoomControl: true }).setView([-23.55, -46.63], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const areaLayerGroup = L.featureGroup().addTo(map);
    const areaLayersBySlug = new Map();

    const els = {
      appShell: document.getElementById("app-shell"),
      body: document.getElementById("areas-body"),
      listMeta: document.getElementById("list-meta"),
      mapMeta: document.getElementById("map-meta"),
      modeNote: document.getElementById("mode-note"),
      visibleFilterPill: document.getElementById("visible-filter-pill"),
      metricVisible: document.getElementById("metric-visible"),
      metricTotal: document.getElementById("metric-total"),
      metricAgencies: document.getElementById("metric-agencies"),
      mapExpandBtn: document.getElementById("map-expand-btn"),
      editorTitle: document.getElementById("editor-title"),
      editorSubtitle: document.getElementById("editor-subtitle"),
      editorPill: document.getElementById("editor-pill"),
      manualPanel: document.getElementById("manual-panel"),
      status: document.getElementById("status"),
      areaJson: document.getElementById("area-json"),
      selectionPill: document.getElementById("selection-pill"),
      manualForm: document.getElementById("manual-form"),
      manualName: document.getElementById("manual-name"),
      manualSlug: document.getElementById("manual-slug"),
      manualAgencia: document.getElementById("manual-agencia"),
      manualRelevancia: document.getElementById("manual-relevancia"),
      manualColor: document.getElementById("manual-color"),
      manualPolygons: document.getElementById("manual-polygons"),
      manualPreviewBtn: document.getElementById("manual-preview-btn"),
      manualResetBtn: document.getElementById("manual-reset-btn"),
    };

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function setStatus(message, isError = false) {
      els.status.textContent = message;
      els.status.style.color = isError ? "#b42318" : "#12703d";
    }

    function slugify(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_{2,}/g, "_");
    }

    function modeLabel(mode) {
      return "Manual";
    }

    function humanDate(value) {
      if (!value) return "-";
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return value;
      return parsed.toLocaleString("pt-BR");
    }

    function getVisibleAreas() {
      return state.areas.filter((area) => (area.mode || "manual") === "manual");
    }

    function groupAreasByAgency(areas) {
      const groups = new Map();
      areas.forEach((area) => {
        const agency = String(area.agencia || "Sem agencia").trim() || "Sem agencia";
        if (!groups.has(agency)) groups.set(agency, []);
        groups.get(agency).push(area);
      });

      return [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))
        .map(([agency, agencyAreas]) => ({
          agency,
          areas: [...agencyAreas].sort((a, b) => String(a.name || a.slug).localeCompare(String(b.name || b.slug), "pt-BR")),
        }));
    }

    function updateMetrics() {
      const visibleAreas = getVisibleAreas();
      const agencyCount = new Set(
        visibleAreas.map((area) => String(area.agencia || "").trim()).filter(Boolean)
      ).size;
      els.metricVisible.textContent = String(visibleAreas.length);
      els.metricTotal.textContent = String(visibleAreas.length);
      els.metricAgencies.textContent = String(agencyCount);
      els.visibleFilterPill.textContent = "Modo manual";
      els.editorPill.textContent = "Manual";
      els.mapMeta.textContent = `${visibleAreas.length} area(s) manuais visiveis no mapa.`;
      els.modeNote.textContent = "Crie, revise e ajuste areas manualmente com visualizacao imediata no mapa.";
      els.editorTitle.textContent = "Cadastro manual";
      els.editorSubtitle.textContent = "Preencha em etapas e confirme a visualizacao antes de salvar.";
    }

    function colorFromSlug(slug) {
      let hash = 0;
      for (let i = 0; i < slug.length; i++) hash = slug.charCodeAt(i) + ((hash << 5) - hash);
      const hue = Math.abs(hash) % 360;
      return hslToHex(hue, 70, 42);
    }

    function hslToHex(hue, saturation, lightness) {
      const s = saturation / 100;
      const l = lightness / 100;
      const chroma = (1 - Math.abs(2 * l - 1)) * s;
      const hueSection = (hue / 60) % 6;
      const x = chroma * (1 - Math.abs((hueSection % 2) - 1));
      let r1 = 0;
      let g1 = 0;
      let b1 = 0;

      if (hueSection >= 0 && hueSection < 1) [r1, g1, b1] = [chroma, x, 0];
      else if (hueSection < 2) [r1, g1, b1] = [x, chroma, 0];
      else if (hueSection < 3) [r1, g1, b1] = [0, chroma, x];
      else if (hueSection < 4) [r1, g1, b1] = [0, x, chroma];
      else if (hueSection < 5) [r1, g1, b1] = [x, 0, chroma];
      else [r1, g1, b1] = [chroma, 0, x];

      const match = l - chroma / 2;
      const toHex = (value) => Math.round((value + match) * 255).toString(16).padStart(2, "0");
      return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
    }

    function normalizeColor(value, slug = "") {
      const normalized = String(value || "").trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized;
      return colorFromSlug(slug || "area");
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
            polygons.push({ type: "Polygon", coordinates: geometry.coordinates });
          }
          if (geometry.type === "MultiPolygon") {
            for (const coordinates of geometry.coordinates) {
              polygons.push({ type: "Polygon", coordinates });
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
            throw new Error(`Polygon ${polyIndex + 1}, anel ${ringIndex + 1} precisa de ao menos 4 pontos.`);
          }
        });
      });
    }

    function parseManualPolygonsFromInput(isPreview = false) {
      let parsed;
      try {
        parsed = JSON.parse(els.manualPolygons.value);
      } catch (error) {
        throw new Error(isPreview ? "JSON invalido para preview." : "JSON de polygons invalido.");
      }
      const polygons = normalizePolygonsInput(parsed);
      validatePolygonsForApi(polygons);
      return polygons;
    }

    function extractApiErrorMessage(err) {
      if (!err || !err.detail) return "Falha ao processar a requisicao.";
      if (typeof err.detail === "string") return err.detail;
      if (Array.isArray(err.detail)) {
        return err.detail
          .map((item) => {
            const loc = Array.isArray(item?.loc) ? item.loc.join(".") : "";
            const msg = item?.msg || "";
            return loc ? `${loc}: ${msg}` : msg;
          })
          .filter(Boolean)
          .join(" | ");
      }
      return "Falha ao processar a requisicao.";
    }

    async function apiGet(url) {
      return fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
      });
    }

    function removePreviewLayer() {
      if (state.previewLayer) {
        map.removeLayer(state.previewLayer);
        state.previewLayer = null;
      }
    }

    function highlightSelectedArea() {
      areaLayersBySlug.forEach((entry, slug) => {
        const baseColor = entry.color;
        const isSelected = slug === state.selectedSlug;
        entry.layer.setStyle({
          color: baseColor,
          weight: isSelected ? 4 : 2,
          fillOpacity: isSelected ? 0.36 : 0.18,
        });
        if (isSelected) entry.layer.bringToFront();
      });
    }

    function drawPreviewPolygons(polygons, message, color = "#38bdf8") {
      removePreviewLayer();
      const latLngPolygons = polygonsToLeafletLatLngs(polygons);
      const layers = latLngPolygons.map((latLngRings) =>
        L.polygon(latLngRings, {
          color: "#0f172a",
          weight: 2,
          fillColor: color,
          fillOpacity: 0.22,
          dashArray: "7 5",
        })
      );
      state.previewLayer = L.featureGroup(layers).addTo(map);
      const bounds = state.previewLayer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      setStatus(message || "Preview aplicado no mapa.");
    }

    function drawAreaOnMap(area) {
      const color = normalizeColor(area.color, area.slug);
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
      layer.bindPopup(`<strong>${escapeHtml(area.name)}</strong><br/>${escapeHtml(area.slug)}<br/>Manual`);
      layer.on("click", () => {
        state.selectedSlug = area.slug;
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

    function renderModeTabs() {
      state.activeMode = "manual";
      els.manualPanel.classList.add("active");
      updateMetrics();
    }

    function resetManualForm() {
      if (state.editingMode === "manual") {
        state.editingSlug = null;
        state.editingMode = null;
      }
      els.manualForm.reset();
      els.manualRelevancia.value = 1;
      els.manualColor.value = "#0b7285";
      els.manualPolygons.value = DEFAULT_MANUAL_POLYGONS;
      removePreviewLayer();
      if (state.activeMode === "manual") {
        setStatus("");
      }
    }

    function resetSelectionIfHidden() {
      const selectedSummary = state.areas.find((area) => area.slug === state.selectedSlug);
      if (!selectedSummary || (selectedSummary.mode || "manual") !== "manual") {
        state.selectedSlug = null;
        els.selectionPill.textContent = "Nenhuma area selecionada";
        els.areaJson.textContent = "Selecione uma area para visualizar os detalhes.";
      }
    }

    async function getAreaDetails(slug) {
      const res = await apiGet(`${apiBase}/${slug}`);
      if (!res.ok) throw new Error(`Falha ao carregar area ${slug}.`);
      return res.json();
    }

    async function renderMapForActiveMode() {
      const visibleAreas = getVisibleAreas();
      const renderToken = ++state.mapRenderToken;

      areaLayerGroup.clearLayers();
      areaLayersBySlug.clear();

      if (!visibleAreas.length) return;

      const detailedAreas = await Promise.all(
        visibleAreas.map((area) => getAreaDetails(area.slug).catch(() => null))
      );
      if (renderToken !== state.mapRenderToken) return;

      detailedAreas.filter(Boolean).forEach(drawAreaOnMap);
      highlightSelectedArea();

      if (state.selectedSlug && areaLayersBySlug.has(state.selectedSlug)) {
        const entry = areaLayersBySlug.get(state.selectedSlug);
        const bounds = entry.layer.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
        return;
      }

      await fitMapToAllAreas();
    }

    function renderAreaList() {
      const visibleAreas = getVisibleAreas();
      els.listMeta.textContent = `${visibleAreas.length} area(s) manuais cadastradas.`;

      if (!visibleAreas.length) {
        els.body.innerHTML = '<tr><td colspan="5" class="muted">Nenhuma area manual cadastrada.</td></tr>';
        return;
      }

      const groupedAreas = groupAreasByAgency(visibleAreas);
      els.body.innerHTML = groupedAreas.map((group) => {
        const groupRows = group.areas.map((area) => {
        const color = normalizeColor(area.color, area.slug);

        return `
          <tr>
            <td>
              <div class="name-cell">
                <div class="area-name-line">
                  <span class="color-dot" style="background:${escapeHtml(color)};"></span>
                  <strong>${escapeHtml(area.name)}</strong>
                </div>
                <span class="mini"><code>${escapeHtml(area.slug)}</code></span>
              </div>
            </td>
            <td>
              <div class="name-cell">
                <span>${escapeHtml(area.agencia || "-")}</span>
                <span class="mini">${escapeHtml(color)}</span>
              </div>
            </td>
            <td><span class="badge manual">★ ${escapeHtml(area.relevancia ?? "-")}</span></td>
            <td>
              <div class="name-cell">
                <span>${escapeHtml(area.total_points)}</span>
                <span class="mini">${escapeHtml(area.polygon_count)} polygon(s)</span>
              </div>
            </td>
            <td>
              <div class="row-actions">
                <button onclick="viewArea('${area.slug}')">◉ Ver</button>
                <button onclick="focusAreaOnMap('${area.slug}')">⌖ Mapa</button>
                <button onclick="editArea('${area.slug}')">✎ Editar</button>
                <button class="danger" onclick="deleteArea('${area.slug}')">× Excluir</button>
              </div>
            </td>
          </tr>
        `;
        }).join("");

        return `
          <tr class="agency-group-row">
            <td colspan="5">
              <div class="agency-group">
                <strong><span class="nav-icon">⌂</span>${escapeHtml(group.agency)}</strong>
                <span class="agency-count">${group.areas.length} area(s)</span>
              </div>
            </td>
          </tr>
          ${groupRows}
        `;
      }).join("");
    }

    async function loadAreas(options = {}) {
      const { silent = false, preserveStatus = false } = options;

      try {
        const res = await apiGet(apiBase);
        if (!res.ok) throw new Error("Falha ao carregar areas.");
        state.areas = await res.json();
        resetSelectionIfHidden();
        renderModeTabs();
        renderAreaList();
        await renderMapForActiveMode();

        if (state.selectedSlug) {
          await viewArea(state.selectedSlug, true);
        }

        if (!silent && !preserveStatus && !els.status.textContent) {
          setStatus("");
        }
      } catch (error) {
        els.listMeta.textContent = "Erro ao carregar.";
        setStatus(error.message || "Erro inesperado.", true);
      }
    }

    async function viewArea(slug, preserveStatus = false) {
      try {
        const data = await getAreaDetails(slug);
        if ((data.mode || "manual") !== "manual") {
          setStatus("Esta interface exibe apenas areas manuais.", true);
          return;
        }
        state.selectedSlug = slug;
        els.areaJson.textContent = JSON.stringify(data, null, 2);
        els.selectionPill.textContent = `${data.name} (Manual)`;
        highlightSelectedArea();

        const layerEntry = areaLayersBySlug.get(slug);
        if (layerEntry) {
          const bounds = layerEntry.layer.getBounds();
          if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
        }

        if (!preserveStatus) {
          setStatus(`Area '${slug}' carregada.`);
        }
      } catch (error) {
        setStatus(error.message || "Nao foi possivel carregar a area.", true);
      }
    }

    async function focusAreaOnMap(slug) {
      const summary = state.areas.find((area) => area.slug === slug);
      if (!summary) return;

      if ((summary.mode || "manual") !== "manual") {
        setStatus("Esta interface exibe apenas areas manuais.", true);
        return;
      }

      state.selectedSlug = slug;
      highlightSelectedArea();
      const entry = areaLayersBySlug.get(slug);
      if (!entry) return;
      const bounds = entry.layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      entry.layer.openPopup();
      await viewArea(slug, true);
    }

    async function editArea(slug) {
      try {
        const data = await getAreaDetails(slug);
        if ((data.mode || "manual") !== "manual") {
          setStatus("Esta interface permite editar apenas areas manuais.", true);
          return;
        }
        state.editingSlug = slug;
        state.editingMode = "manual";
        state.selectedSlug = slug;
        els.areaJson.textContent = JSON.stringify(data, null, 2);
        els.selectionPill.textContent = `${data.name} (Manual)`;
        state.activeMode = "manual";
        renderModeTabs();
        els.manualName.value = data.name || "";
        els.manualSlug.value = data.slug || "";
        els.manualAgencia.value = data.agencia || "";
        els.manualRelevancia.value = data.relevancia || 1;
        els.manualColor.value = normalizeColor(data.color, data.slug || slug);
        els.manualPolygons.value = JSON.stringify(data.polygons || [], null, 2);
        setStatus("Modo edicao manual ativado.");

        renderAreaList();
        await renderMapForActiveMode();
        highlightSelectedArea();
      } catch (error) {
        setStatus(error.message || "Nao foi possivel carregar a area para edicao.", true);
      }
    }

    async function deleteArea(slug) {
      const ok = confirm(`Excluir a area '${slug}'?`);
      if (!ok) return;

      const res = await fetch(`${apiBase}/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(extractApiErrorMessage(err), true);
        return;
      }

      if (state.editingSlug === slug) {
        state.editingMode = null;
        resetManualForm();
      }
      if (state.selectedSlug === slug) {
        state.selectedSlug = null;
        els.selectionPill.textContent = "Nenhuma area selecionada";
        els.areaJson.textContent = "Selecione uma area para visualizar os polygons.";
      }

      setStatus(`Area '${slug}' removida.`);
      await loadAreas({ silent: true, preserveStatus: true });
    }

    function previewManualPolygons() {
      try {
        const polygons = parseManualPolygonsFromInput(true);
        drawPreviewPolygons(
          polygons,
          "Preview manual aplicado no mapa.",
          normalizeColor(els.manualColor.value, els.manualSlug.value.trim())
        );
      } catch (error) {
        setStatus(error.message || "Falha no preview dos polygons.", true);
      }
    }

    async function saveManualArea(event) {
      event.preventDefault();
      removePreviewLayer();

      let polygons;
      try {
        polygons = parseManualPolygonsFromInput(false);
      } catch (error) {
        setStatus(error.message || "Falha ao ler polygons.", true);
        return;
      }

      const payload = {
        name: els.manualName.value.trim(),
        slug: els.manualSlug.value.trim(),
        agencia: els.manualAgencia.value.trim(),
        relevancia: Number(els.manualRelevancia.value),
        color: normalizeColor(els.manualColor.value, els.manualSlug.value.trim()),
        polygons,
        mode: "manual",
      };

      const isEditing = state.editingMode === "manual" && !!state.editingSlug;
      const method = isEditing ? "PATCH" : "POST";
      const url = isEditing ? `${apiBase}/${state.editingSlug}` : apiBase;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus(extractApiErrorMessage(err), true);
        return;
      }

      state.editingSlug = payload.slug;
      state.editingMode = "manual";
      state.selectedSlug = payload.slug;
      setStatus(isEditing ? "Area manual atualizada com sucesso." : "Area manual salva com sucesso.");
      await loadAreas({ silent: true, preserveStatus: true });
      await viewArea(payload.slug, true);
    }

    async function refitVisibleMap() {
      if (state.selectedSlug && areaLayersBySlug.has(state.selectedSlug)) {
        const entry = areaLayersBySlug.get(state.selectedSlug);
        const bounds = entry.layer.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
        return;
      }
      await fitMapToAllAreas();
    }

    function toggleMapExpanded() {
      state.mapExpanded = !state.mapExpanded;
      els.appShell.classList.toggle("map-expanded", state.mapExpanded);
      els.mapExpandBtn.setAttribute("aria-expanded", String(state.mapExpanded));
      els.mapExpandBtn.textContent = state.mapExpanded ? "↙ Recolher" : "⛶ Expandir";
      window.setTimeout(() => {
        map.invalidateSize();
        refitVisibleMap();
      }, 340);
    }

    function wireAutoSlug(inputEl, slugEl) {
      inputEl.addEventListener("input", () => {
        if (!slugEl.value.trim() || slugEl.dataset.autofill === "true") {
          slugEl.value = slugify(inputEl.value);
          slugEl.dataset.autofill = "true";
        }
      });
      slugEl.addEventListener("input", () => {
        slugEl.dataset.autofill = "false";
      });
    }

    els.manualForm.addEventListener("submit", saveManualArea);
    els.manualPreviewBtn.addEventListener("click", previewManualPolygons);
    els.manualResetBtn.addEventListener("click", resetManualForm);
    els.mapExpandBtn.addEventListener("click", toggleMapExpanded);

    wireAutoSlug(els.manualName, els.manualSlug);

    resetManualForm();
    renderModeTabs();
    loadAreas();
    setInterval(() => {
      loadAreas({ silent: true, preserveStatus: true });
    }, 60000);

    window.viewArea = viewArea;
    window.focusAreaOnMap = focusAreaOnMap;
    window.editArea = editArea;
    window.deleteArea = deleteArea;
  </script>
</body>
</html>
"""
