from __future__ import annotations

import copy
import math
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET
from zipfile import ZipFile

KML_NAMESPACE = {"kml": "http://www.opengis.net/kml/2.2"}
DEFAULT_NETWORK_LINK_REFRESH_SECONDS = 300
MIN_NETWORK_LINK_REFRESH_SECONDS = 30
MAX_NETWORK_LINK_DEPTH = 4


@dataclass
class ParsedKmlDocument:
    document_name: Optional[str]
    polygons: list[dict]
    network_link_url: Optional[str]
    network_link_name: Optional[str]
    network_link_refresh_seconds: Optional[int]
    source_file_name: Optional[str]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None

    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_kmz_bytes(file_bytes: bytes, file_name: Optional[str]) -> bool:
    if file_name and file_name.lower().endswith(".kmz"):
        return True
    return file_bytes.startswith(b"PK\x03\x04")


def _extract_xml_bytes(file_bytes: bytes, file_name: Optional[str]) -> tuple[bytes, Optional[str]]:
    if not _is_kmz_bytes(file_bytes, file_name):
        return file_bytes, file_name

    with ZipFile(BytesIO(file_bytes)) as archive:
        kml_names = [entry.filename for entry in archive.infolist() if entry.filename.lower().endswith(".kml")]
        if not kml_names:
            raise ValueError("KMZ invalido: nenhum arquivo .kml encontrado.")

        preferred_name = "doc.kml" if "doc.kml" in kml_names else kml_names[0]
        return archive.read(preferred_name), preferred_name


def _find_text(element: ET.Element, path: str) -> Optional[str]:
    node = element.find(path, KML_NAMESPACE)
    if node is None or node.text is None:
        return None
    value = node.text.strip()
    return value or None


def _parse_coordinate_token(token: str) -> list[float]:
    parts = [part.strip() for part in token.split(",") if part.strip() != ""]
    if len(parts) < 2:
        raise ValueError(f"Coordenada KML invalida: '{token}'.")

    values = [float(parts[0]), float(parts[1])]
    if len(parts) >= 3:
        values.append(float(parts[2]))
    return values


def _parse_coordinates_text(raw_text: Optional[str]) -> list[list[float]]:
    if not raw_text or not raw_text.strip():
        raise ValueError("Polygon KML sem coordenadas.")

    coordinates = [
        _parse_coordinate_token(token)
        for token in raw_text.replace("\r", " ").replace("\n", " ").split()
        if token.strip()
    ]

    if len(coordinates) < 4:
        raise ValueError("Cada anel precisa de ao menos 4 coordenadas.")

    if coordinates[0][:2] != coordinates[-1][:2]:
        coordinates.append(copy.deepcopy(coordinates[0]))

    return coordinates


def _parse_polygon_element(polygon_element: ET.Element) -> dict:
    outer_text = _find_text(
        polygon_element,
        "./kml:outerBoundaryIs/kml:LinearRing/kml:coordinates",
    )
    outer_ring = _parse_coordinates_text(outer_text)

    inner_rings: list[list[list[float]]] = []
    for inner_boundary in polygon_element.findall("./kml:innerBoundaryIs", KML_NAMESPACE):
        ring_text = _find_text(inner_boundary, "./kml:LinearRing/kml:coordinates")
        inner_rings.append(_parse_coordinates_text(ring_text))

    return {
        "type": "Polygon",
        "coordinates": [outer_ring, *inner_rings],
    }


def parse_kml_document(file_bytes: bytes, file_name: Optional[str] = None) -> ParsedKmlDocument:
    xml_bytes, extracted_name = _extract_xml_bytes(file_bytes, file_name)

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ValueError("Nao foi possivel interpretar o arquivo KML/KMZ.") from exc

    polygons = [_parse_polygon_element(node) for node in root.findall(".//kml:Polygon", KML_NAMESPACE)]

    document_name = (
        _find_text(root, "./kml:Document/kml:name")
        or _find_text(root, "./kml:Folder/kml:name")
        or _find_text(root, ".//kml:Placemark/kml:name")
        or (os.path.splitext(file_name or extracted_name or "")[0] or None)
    )

    network_link_element = root.find(".//kml:NetworkLink", KML_NAMESPACE)
    network_link_url = None
    network_link_name = None
    network_link_refresh_seconds = None
    if network_link_element is not None:
        network_link_url = _find_text(network_link_element, "./kml:Link/kml:href") or _find_text(
            network_link_element, "./kml:Url/kml:href"
        )
        network_link_name = _find_text(network_link_element, "./kml:name") or document_name

        refresh_interval_value = _find_text(network_link_element, "./kml:Link/kml:refreshInterval") or _find_text(
            network_link_element, "./kml:Url/kml:refreshInterval"
        )
        if refresh_interval_value:
            try:
                network_link_refresh_seconds = max(
                    MIN_NETWORK_LINK_REFRESH_SECONDS,
                    int(math.ceil(float(refresh_interval_value))),
                )
            except ValueError:
                network_link_refresh_seconds = None

    return ParsedKmlDocument(
        document_name=document_name,
        polygons=polygons,
        network_link_url=network_link_url,
        network_link_name=network_link_name,
        network_link_refresh_seconds=network_link_refresh_seconds,
        source_file_name=extracted_name or file_name,
    )


def _guess_remote_file_name(url: str, content_bytes: bytes) -> str:
    parsed = urlparse(url)
    file_name = os.path.basename(parsed.path or "")
    if file_name:
        return file_name
    return "network-link.kmz" if _is_kmz_bytes(content_bytes, None) else "network-link.kml"


def fetch_remote_kml(url: str) -> tuple[bytes, str]:
    request = Request(
        url,
        headers={
            "User-Agent": "score-api/1.0",
            "Accept": "application/vnd.google-earth.kml+xml, application/vnd.google-earth.kmz, application/xml, text/xml, */*",
        },
    )

    with urlopen(request, timeout=30) as response:
        content = response.read()
        final_url = response.geturl() or url

    if not content:
        raise ValueError("O KML remoto retornou um arquivo vazio.")

    return content, _guess_remote_file_name(final_url, content)


def resolve_network_link_document(url: str, depth: int = 0) -> ParsedKmlDocument:
    if depth >= MAX_NETWORK_LINK_DEPTH:
        raise ValueError("Profundidade maxima de NetworkLink excedida.")

    remote_bytes, remote_file_name = fetch_remote_kml(url)
    parsed = parse_kml_document(remote_bytes, remote_file_name)

    if parsed.polygons:
        return parsed

    if parsed.network_link_url:
        return resolve_network_link_document(parsed.network_link_url, depth + 1)

    raise ValueError("O KML remoto nao contem polygons.")


def build_automatic_area_record(
    *,
    source_kind: str,
    file_bytes: bytes,
    file_name: Optional[str],
    refresh_interval_seconds: Optional[int],
    name: str,
    slug: str,
    agencia: str,
    relevancia: int,
    color: str,
) -> dict:
    preview = preview_automatic_source(
        source_kind=source_kind,
        file_bytes=file_bytes,
        file_name=file_name,
        refresh_interval_seconds=refresh_interval_seconds,
    )

    return {
        "name": name,
        "slug": slug,
        "agencia": agencia,
        "relevancia": relevancia,
        "color": color,
        "polygons": preview["polygons"],
        "mode": "automatic",
        "automatic_source": preview["automatic_source"],
    }


def preview_automatic_source(
    *,
    source_kind: str,
    file_bytes: bytes,
    file_name: Optional[str],
    refresh_interval_seconds: Optional[int],
) -> dict:
    parsed_source = parse_kml_document(file_bytes, file_name)

    if source_kind == "network_link":
        if not parsed_source.network_link_url:
            raise ValueError("O arquivo informado nao contem um NetworkLink valido.")

        resolved_document = resolve_network_link_document(parsed_source.network_link_url)
        effective_refresh_interval = refresh_interval_seconds or parsed_source.network_link_refresh_seconds
        effective_refresh_interval = max(
            MIN_NETWORK_LINK_REFRESH_SECONDS,
            int(effective_refresh_interval or DEFAULT_NETWORK_LINK_REFRESH_SECONDS),
        )

        automatic_source = {
            "type": "network_link",
            "source_file_name": file_name or parsed_source.source_file_name,
            "link_document_name": parsed_source.document_name,
            "link_name": parsed_source.network_link_name or parsed_source.document_name,
            "source_url": parsed_source.network_link_url,
            "resolved_document_name": resolved_document.document_name,
            "refresh_interval_seconds": effective_refresh_interval,
            "last_refresh_attempt_at": _utc_now_iso(),
            "last_refreshed_at": _utc_now_iso(),
            "last_refresh_error": None,
        }
        polygons = resolved_document.polygons
    else:
        if not parsed_source.polygons:
            raise ValueError("O arquivo KML/KMZ nao contem polygons.")

        automatic_source = {
            "type": "kml_upload",
            "source_file_name": file_name or parsed_source.source_file_name,
            "link_document_name": None,
            "link_name": None,
            "source_url": None,
            "resolved_document_name": parsed_source.document_name,
            "refresh_interval_seconds": None,
            "last_refresh_attempt_at": _utc_now_iso(),
            "last_refreshed_at": _utc_now_iso(),
            "last_refresh_error": None,
        }
        polygons = parsed_source.polygons

    return {
        "document_name": (
            automatic_source.get("resolved_document_name")
            or automatic_source.get("link_document_name")
            or parsed_source.document_name
        ),
        "polygons": polygons,
        "automatic_source": automatic_source,
    }


def maybe_refresh_automatic_area(area_data: dict, force: bool = False) -> dict:
    if str(area_data.get("mode", "manual")) != "automatic":
        return area_data

    source = copy.deepcopy(area_data.get("automatic_source") or {})
    if source.get("type") != "network_link":
        return area_data

    source_url = str(source.get("source_url") or "").strip()
    if not source_url:
        return area_data

    refresh_interval_seconds = max(
        MIN_NETWORK_LINK_REFRESH_SECONDS,
        int(source.get("refresh_interval_seconds") or DEFAULT_NETWORK_LINK_REFRESH_SECONDS),
    )

    if not force:
        last_attempt = _parse_iso_datetime(source.get("last_refresh_attempt_at"))
        if last_attempt and datetime.now(timezone.utc) < last_attempt + timedelta(seconds=refresh_interval_seconds):
            return area_data

    updated_area = copy.deepcopy(area_data)
    updated_source = copy.deepcopy(source)
    updated_source["last_refresh_attempt_at"] = _utc_now_iso()

    try:
        resolved_document = resolve_network_link_document(source_url)
        if not resolved_document.polygons:
            raise ValueError("O KML remoto nao contem polygons.")

        updated_area["polygons"] = resolved_document.polygons
        updated_source["resolved_document_name"] = resolved_document.document_name
        updated_source["last_refreshed_at"] = _utc_now_iso()
        updated_source["last_refresh_error"] = None
    except Exception as exc:
        updated_source["last_refresh_error"] = str(exc)

    updated_area["automatic_source"] = updated_source
    return updated_area
