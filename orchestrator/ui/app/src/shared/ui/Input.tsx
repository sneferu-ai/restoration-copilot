// Input + Label + FieldError primitives. Labels are real <label for>, never
// placeholder-only (DESIGN.md §9 a11y floor). Errors are near the field with
// aria-describedby.

import { InputHTMLAttributes, ReactNode, useId } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
}

export function Input({ label, hint, error, required, id, className, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  const errId = `${inputId}-err`;
  const describedBy = error ? errId : hint ? descId : undefined;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-fg-secondary">
          {label}
          {required && <span className="text-accent" aria-hidden> *</span>}
        </label>
      )}
      <input
        {...rest}
        id={inputId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        className={["input", error && "border-status-failed", className].filter(Boolean).join(" ")}
      />
      {hint && !error && (
        <span id={descId} className="text-xs text-fg-tertiary">
          {hint}
        </span>
      )}
      {error && (
        <span id={errId} role="alert" className="text-xs text-status-failed">
          {error}
        </span>
      )}
    </div>
  );
}
