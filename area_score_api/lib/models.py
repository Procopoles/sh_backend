from typing import Literal, Optional

import re

from pydantic import BaseModel, Field, field_validator, model_validator

AreaMode = Literal["manual", "automatic"]
AutomaticSourceType = Literal["kml_upload", "network_link"]
HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


class PointInput(BaseModel):
    lat: float = Field(..., description="Latitude do ponto alvo", ge=-90, le=90)
    lng: float = Field(..., description="Longitude do ponto alvo", ge=-180, le=180)


class AnalysisRequest(BaseModel):
    target: PointInput
    areas: Optional[list[str]] = Field(
        default=None,
        description="Slugs das areas a analisar",
        min_length=1,
    )
    agencias: Optional[list[str]] = Field(
        default=None,
        description="Nomes de agencias para buscar areas (case-insensitive)",
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_target_filters(self):
        if not self.areas and not self.agencias:
            raise ValueError("Informe ao menos um filtro: areas ou agencias.")
        return self

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "target": {"lat": -23.555, "lng": -46.630},
                    "areas": ["area_principal", "area_completa"],
                    "agencias": ["SH Perdizes"],
                }
            ]
        }
    }


class AreaResult(BaseModel):
    slug: str = Field(..., description="Slug da area")
    name: str = Field(..., description="Nome da area")
    is_in: bool = Field(..., description="Ponto esta dentro da area?")
    nearest_border_distance_meters: float = Field(
        ...,
        description="Distancia em metros ate a borda mais proxima (0 se dentro)",
    )
    agencia: str = Field(..., description="Nome da agencia da area")
    relevancia: int = Field(..., description="Nivel de relevancia da area (1 a 10)")


class AnalysisResponse(BaseModel):
    results: list[AreaResult]
    errors: Optional[list[str]] = None

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "results": [
                        {
                            "slug": "area_principal",
                            "name": "Area Principal",
                            "is_in": False,
                            "nearest_border_distance_meters": 1028.43,
                            "agencia": "SH Perdizes",
                            "relevancia": 8,
                        },
                        {
                            "slug": "area_completa",
                            "name": "Area Completa",
                            "is_in": True,
                            "nearest_border_distance_meters": 0,
                            "agencia": "SH Jardins",
                            "relevancia": 9,
                        },
                    ],
                    "errors": None,
                }
            ]
        }
    }


class PolygonInput(BaseModel):
    """
    GeoJSON Polygon:
    - type = "Polygon"
    - coordinates = [ [ [lng, lat, alt?], ... ] , ... ]
    """

    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[list[float]]] = Field(
        ...,
        min_length=1,
        description="Aneis GeoJSON no formato [lng, lat, alt?]. O primeiro anel e o externo.",
    )

    @field_validator("coordinates")
    @classmethod
    def validate_coordinates(
        cls,
        coordinates: list[list[list[float]]],
    ) -> list[list[list[float]]]:
        for ring in coordinates:
            if len(ring) < 4:
                raise ValueError("Cada anel do Polygon deve ter ao menos 4 posicoes.")

            for position in ring:
                if len(position) < 2:
                    raise ValueError("Cada posicao deve conter ao menos [lng, lat].")

                lng = position[0]
                lat = position[1]
                if not (-180 <= lng <= 180):
                    raise ValueError("Longitude fora do intervalo valido (-180 a 180).")
                if not (-90 <= lat <= 90):
                    raise ValueError("Latitude fora do intervalo valido (-90 a 90).")

        return coordinates


class AutomaticSourceInput(BaseModel):
    type: AutomaticSourceType
    source_file_name: Optional[str] = Field(default=None, description="Nome do arquivo KML/KMZ enviado")
    link_document_name: Optional[str] = Field(
        default=None,
        description="Nome do documento que contem o NetworkLink",
    )
    link_name: Optional[str] = Field(default=None, description="Nome do NetworkLink encontrado no arquivo")
    source_url: Optional[str] = Field(default=None, description="URL remota usada no refresh automatico")
    resolved_document_name: Optional[str] = Field(
        default=None,
        description="Nome do documento que originou os polygons efetivos",
    )
    refresh_interval_seconds: Optional[int] = Field(
        default=None,
        ge=30,
        description="Intervalo de refresh para NetworkLink em segundos",
    )
    last_refresh_attempt_at: Optional[str] = Field(
        default=None,
        description="Data/hora ISO da ultima tentativa de refresh",
    )
    last_refreshed_at: Optional[str] = Field(
        default=None,
        description="Data/hora ISO do ultimo refresh com sucesso",
    )
    last_refresh_error: Optional[str] = Field(
        default=None,
        description="Ultimo erro de refresh, se houver",
    )


def _validate_hex_color(value: str) -> str:
    normalized = (value or "").strip()
    if not HEX_COLOR_PATTERN.fullmatch(normalized):
        raise ValueError("Cor invalida. Use o formato hexadecimal #RRGGBB.")
    return normalized.lower()


class AreaInput(BaseModel):
    """
    Area geografica. Aceita multiplos polygons (ilhas separadas).
    """

    name: str = Field(..., description="Nome legivel (ex: 'Area Principal')")
    slug: str = Field(
        ...,
        description="Identificador unico (ex: 'area_principal')",
        pattern=r"^[a-z0-9_]+$",
    )
    agencia: str = Field(..., description="Nome da agencia/unidade da imobiliaria (ex: SH Perdizes)")
    relevancia: int = Field(..., description="Nivel de relevancia da area (1 a 10)", ge=1, le=10)
    color: str = Field(..., description="Cor da area no mapa no formato hexadecimal #RRGGBB")
    polygons: list[PolygonInput] = Field(..., min_length=1)
    mode: AreaMode = Field(default="manual", description="Modo de manutencao da area")
    automatic_source: Optional[AutomaticSourceInput] = Field(
        default=None,
        description="Metadados da origem automatica da area",
    )

    @model_validator(mode="after")
    def validate_mode_fields(self):
        if self.mode == "automatic" and self.automatic_source is None:
            raise ValueError("Areas automaticas precisam informar automatic_source.")
        if self.mode == "manual":
            self.automatic_source = None
        return self

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        return _validate_hex_color(value)

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "name": "Area Principal",
                    "slug": "area_principal",
                    "agencia": "SH Perdizes",
                    "relevancia": 8,
                    "color": "#0b7285",
                    "polygons": [
                        {
                            "type": "Polygon",
                            "coordinates": [
                                [
                                    [-46.640, -23.550, 0],
                                    [-46.620, -23.550, 0],
                                    [-46.620, -23.560, 0],
                                    [-46.640, -23.560, 0],
                                    [-46.640, -23.550, 0]
                                ]
                            ]
                        }
                    ],
                    "mode": "manual",
                    "automatic_source": None,
                }
            ]
        }
    }


class AreaPatchInput(BaseModel):
    name: Optional[str] = Field(default=None, description="Novo nome da area")
    slug: Optional[str] = Field(
        default=None,
        description="Novo identificador unico",
        pattern=r"^[a-z0-9_]+$",
    )
    agencia: Optional[str] = Field(
        default=None,
        description="Novo nome da agencia/unidade da imobiliaria",
    )
    relevancia: Optional[int] = Field(
        default=None,
        description="Novo nivel de relevancia da area (1 a 10)",
        ge=1,
        le=10,
    )
    color: Optional[str] = Field(
        default=None,
        description="Nova cor da area no formato hexadecimal #RRGGBB",
    )
    polygons: Optional[list[PolygonInput]] = Field(
        default=None,
        min_length=1,
        description="Novo conjunto de polygons GeoJSON",
    )
    mode: Optional[AreaMode] = Field(default=None, description="Novo modo da area")
    automatic_source: Optional[AutomaticSourceInput] = Field(
        default=None,
        description="Nova configuracao de origem automatica",
    )

    @model_validator(mode="after")
    def validate_at_least_one_field(self):
        if (
            self.name is None
            and self.slug is None
            and self.agencia is None
            and self.relevancia is None
            and self.color is None
            and self.polygons is None
            and self.mode is None
            and self.automatic_source is None
        ):
            raise ValueError(
                "Informe ao menos um campo para atualizar: name, slug, agencia, relevancia, color, polygons, mode ou automatic_source."
            )
        if self.mode == "automatic" and self.automatic_source is None:
            raise ValueError("Atualizacoes para modo automatico precisam informar automatic_source.")
        if self.mode == "manual" and self.automatic_source is not None:
            raise ValueError("Nao informe automatic_source quando o modo for manual.")
        return self

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        return _validate_hex_color(value)


class AreaSummary(BaseModel):
    name: str
    slug: str
    agencia: str
    relevancia: int
    color: str
    polygon_count: int
    total_points: int
    mode: AreaMode = "manual"
    automatic_source_type: Optional[AutomaticSourceType] = None
    last_refreshed_at: Optional[str] = None
    last_refresh_attempt_at: Optional[str] = None
    last_refresh_error: Optional[str] = None
