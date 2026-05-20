"use client";

import type { InputHTMLAttributes } from "react";
import { useEffect, useState } from "react";
import { formatNumericInput, localizedNumberToNormalized, maskLocalizedNumberInput } from "../_lib/number-format";

type NumericInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "inputMode"> & {
  value: string | number | null | undefined;
  onValueChange: (value: string) => void;
  allowDecimal?: boolean;
  allowNegative?: boolean;
};

export function NumericInput({
  value,
  onValueChange,
  allowDecimal = true,
  allowNegative = true,
  onBlur,
  ...props
}: NumericInputProps) {
  const [displayValue, setDisplayValue] = useState(() => formatNumericInput(value));

  useEffect(() => {
    setDisplayValue(formatNumericInput(value));
  }, [value]);

  return (
    <input
      {...props}
      type="text"
      inputMode={allowDecimal ? "decimal" : "numeric"}
      value={displayValue}
      onChange={(event) => {
        const masked = maskLocalizedNumberInput(event.target.value, { allowDecimal, allowNegative });
        setDisplayValue(masked);
        if (isIncompleteLocalizedNumber(masked, allowDecimal)) {
          if (!masked) onValueChange("");
          return;
        }
        onValueChange(localizedNumberToNormalized(masked));
      }}
      onBlur={(event) => {
        const normalized = localizedNumberToNormalized(displayValue);
        setDisplayValue(formatNumericInput(normalized));
        onValueChange(normalized);
        onBlur?.(event);
      }}
    />
  );
}

function isIncompleteLocalizedNumber(value: string, allowDecimal: boolean) {
  if (!value || value === "-") return true;
  return allowDecimal && value.endsWith(",");
}
