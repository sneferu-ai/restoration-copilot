// Card primitive — flat technical plane, 1px hairline border preferred over
// shadow on dark surfaces (DESIGN.md §6, §9). Hover variant uses translateY.
// Interactive cards render as a native <button> for semantic accessibility
// (WCAG 2.2 AA — no div-with-role-button when a button element is viable).
// When interactive, aria-label is REQUIRED — enforced by the discriminated
// union so a missing accessible name is a compile error, not a runtime guess.

import { ButtonHTMLAttributes, HTMLAttributes, MouseEventHandler, ReactNode } from "react";

type CommonProps = {
  hover?: boolean;
  className?: string;
  children: ReactNode;
};

export type CardProps =
  | (CommonProps & { interactive?: false } & HTMLAttributes<HTMLDivElement>)
  | (CommonProps & {
      interactive: true;
      onClick: MouseEventHandler<HTMLButtonElement>;
      "aria-label": string;
    } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "onClick">);

export function Card(props: CardProps) {
  const { hover = false, interactive = false, className, children, ...rest } = props as CommonProps & {
    interactive?: boolean;
  } & HTMLAttributes<HTMLElement>;
  const cls = ["card", hover && "card-hover", className].filter(Boolean).join(" ");

  if (interactive) {
    const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label"?: string };
    const { onClick, "aria-label": ariaLabel, ...buttonRest } = buttonProps;
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        {...buttonRest}
        onClick={onClick}
        className={cls}
      >
        {children}
      </button>
    );
  }

  return (
    <div {...rest} className={cls}>
      {children}
    </div>
  );
}
