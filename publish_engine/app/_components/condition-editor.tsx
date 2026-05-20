import type { ColumnMetadata, RuleCondition, RuleOperator } from "@/lib/types";
import { formatOptionalNumber } from "../_lib/number-format";
import { ColumnPicker } from "./column-picker";
import { MaterialIcon } from "./material-icon";
import { NumericInput } from "./numeric-input";
import {
  columnForCondition,
  conditionFieldKey,
  createConditionFromColumn,
  fieldKey,
  fieldLabel,
  OPERATOR_LABEL,
  operatorsFor
} from "../_lib/rule-filter-utils";

type ConditionEditorProps = {
  columns: ColumnMetadata[];
  condition: RuleCondition;
  onChange: (condition: RuleCondition) => void;
  onRemove: () => void;
  onAddConditionAfter: () => void;
  onAddGroupAfter: () => void;
  onDuplicate?: () => void;
  readOnly?: boolean;
};

export function ConditionEditor({
  columns,
  condition,
  onChange,
  onRemove,
  onAddConditionAfter,
  onAddGroupAfter,
  onDuplicate,
  readOnly = false
}: ConditionEditorProps) {
  const column = columnForCondition(columns, condition);
  const selectableColumns = column && !columns.some((item) => fieldKey(item) === fieldKey(column)) ? [...columns, column] : columns;
  const operators = operatorsFor(column);
  const operator = operators.includes(condition.operator) ? condition.operator : operators[0];
  const needsValue = !["is_null", "is_not_null", "is_true", "is_false"].includes(operator);
  const isNumberFilter = column?.filter_kind === "number";
  const isTextFilter = column?.filter_kind === "text" && ["equals", "not_equals", "contains", "starts_with", "in"].includes(operator);
  const caseInsensitive = isTextFilter ? condition.caseInsensitive !== false : false;
  const listValues = operator === "in" ? parseListValues(condition.value) : [];
  const valueLabel = conditionValueLabel({ ...condition, operator }, isNumberFilter);

  if (readOnly) {
    return (
      <div className="condition-item read-only">
        <div className="condition-row condition-view-row">
          <span>
            <strong>{column ? fieldLabel(column) : condition.column}</strong>
            <small>Campo</small>
          </span>
          <span>
            <strong>{OPERATOR_LABEL[operator]}</strong>
            <small>{isTextFilter && caseInsensitive ? "Sem diferenciar maiusculas" : "Operador"}</small>
          </span>
          <span>
            <strong>{valueLabel || "sem valor"}</strong>
            <small>Valor</small>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="condition-item">
      <div className="condition-row">
        <ColumnPicker
          columns={selectableColumns}
          value={conditionFieldKey(condition)}
          onSelect={(nextColumn) => {
            onChange(createConditionFromColumn(nextColumn));
          }}
        />
        <select value={operator} onChange={(event) => onChange({ ...condition, operator: event.target.value as RuleOperator })}>
          {operators.map((currentOperator) => (
            <option key={currentOperator} value={currentOperator}>
              {OPERATOR_LABEL[currentOperator]}
            </option>
          ))}
        </select>
        {needsValue && operator === "in" ? (
          <div className="list-filter-input">
            <textarea
              value={String(condition.value ?? "")}
              onChange={(event) => onChange({ ...condition, operator, value: event.target.value })}
              placeholder="Ex.: Centro, Jardins, Vila Mariana"
              rows={2}
            />
            <small>Separe os valores por virgula.</small>
          </div>
        ) : needsValue && isNumberFilter ? (
          <NumericInput
            value={typeof condition.value === "boolean" ? "" : condition.value}
            onValueChange={(value) => onChange({ ...condition, operator, value })}
            placeholder="Valor"
          />
        ) : needsValue ? (
          <input value={String(condition.value ?? "")} onChange={(event) => onChange({ ...condition, operator, value: event.target.value })} placeholder="Valor" />
        ) : (
          <span className="readonly-cell">sem valor</span>
        )}
        {operator === "between" && (
          isNumberFilter ? (
            <NumericInput
              value={condition.secondaryValue}
              onValueChange={(value) => onChange({ ...condition, operator, secondaryValue: value })}
              placeholder="Valor final"
            />
          ) : (
            <input
              value={String(condition.secondaryValue ?? "")}
              onChange={(event) => onChange({ ...condition, operator, secondaryValue: event.target.value })}
              placeholder="Valor final"
            />
          )
        )}
        {isTextFilter && (
          <label className="condition-option-check">
            <input
              type="checkbox"
              checked={caseInsensitive}
              onChange={(event) => onChange({ ...condition, operator, caseInsensitive: event.target.checked })}
            />
            <span>Nao diferenciar maiusculas</span>
          </label>
        )}
        {operator === "in" && listValues.length > 0 && (
          <div className="list-filter-preview" aria-label="Valores da lista">
            {listValues.map((value, index) => (
              <span className="list-filter-chip" key={`${value}-${index}`}>
                {value}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="condition-remove-dock">
        <button className="secondary-button compact-button add-filter-button row-action-button" type="button" onClick={onAddConditionAfter} disabled={!columns[0]}>
          <MaterialIcon name="add_circle" size={17} />
          + Filtro
        </button>
        <button className="secondary-button compact-button add-group-button row-action-button" type="button" onClick={onAddGroupAfter} disabled={!columns[0]}>
          <MaterialIcon name="stacks" size={17} />
          Grupo
        </button>
        {onDuplicate && (
          <button className="secondary-button compact-button duplicate-filter-button row-action-button" type="button" onClick={onDuplicate}>
            <MaterialIcon name="content_copy" size={16} />
            Duplicar
          </button>
        )}
        <button className="filter-remove-button condition-remove-button" type="button" title="Remover filtro" onClick={onRemove}>
          <MaterialIcon name="delete" size={16} />
          Remover filtro
        </button>
      </div>
    </div>
  );
}

function conditionValueLabel(condition: RuleCondition, formatAsNumber: boolean) {
  if (["is_null", "is_not_null", "is_true", "is_false"].includes(condition.operator)) return "";
  if (condition.operator === "between") {
    const firstValue = formatAsNumber ? formatOptionalNumber(condition.value) : String(condition.value ?? "");
    const secondValue = formatAsNumber ? formatOptionalNumber(condition.secondaryValue) : String(condition.secondaryValue ?? "");
    return `${firstValue} e ${secondValue}`.trim();
  }

  return formatAsNumber ? formatOptionalNumber(condition.value) : String(condition.value ?? "");
}

function parseListValues(value: RuleCondition["value"]) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}
