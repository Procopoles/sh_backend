import math

from shapely.geometry import Point

from lib.areas_repository import repository
from lib.models import AnalysisRequest, AnalysisResponse, AreaResult

EARTH_RADIUS_M = 6_371_000


def _haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Distancia Haversine entre dois pontos em metros."""
    lat1, lng1, lat2, lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def _nearest_border_distance_meters(
    target_lat: float,
    target_lng: float,
    geometry,
) -> float:
    """
    Encontra o ponto mais proximo na borda do poligono (via Shapely)
    e calcula a distancia real com Haversine.
    """
    target_point = Point(target_lng, target_lat)
    nearest_on_border = geometry.boundary.interpolate(
        geometry.boundary.project(target_point)
    )
    return _haversine(
        target_lat,
        target_lng,
        nearest_on_border.y,
        nearest_on_border.x,
    )


def analyze(request: AnalysisRequest) -> AnalysisResponse:
    target = Point(request.target.lng, request.target.lat)
    results: list[AreaResult] = []
    errors: list[str] = []
    slugs_to_analyze: list[str] = []

    if request.areas:
        slugs_to_analyze.extend(request.areas)

    if request.agencias:
        slugs_to_analyze.extend(repository.find_slugs_by_agencias(request.agencias))

    # Remove duplicados mantendo a ordem de chegada.
    slugs_to_analyze = list(dict.fromkeys(slugs_to_analyze))

    for slug in slugs_to_analyze:
        geometry = repository.get_geometry(slug)

        if geometry is None:
            errors.append(f"Area '{slug}' nao encontrada.")
            continue

        area_data = repository.get_raw(slug) or {}
        is_inside = geometry.contains(target) or geometry.touches(target)

        if is_inside:
            distance_m = 0.0
        else:
            distance_m = round(
                _nearest_border_distance_meters(
                    request.target.lat,
                    request.target.lng,
                    geometry,
                ),
                2,
            )

        results.append(AreaResult(
            slug=slug,
            name=str(area_data.get("name", slug)),
            is_in=is_inside,
            nearest_border_distance_meters=distance_m,
            agencia=str(area_data.get("agencia", "")),
            relevancia=int(area_data.get("relevancia", 1)),
        ))

    return AnalysisResponse(
        results=results,
        errors=errors if errors else None,
    )
