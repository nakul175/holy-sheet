"use client";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const GovernanceTarget = createContext<HTMLDivElement | null | undefined>(undefined);

export function GovernanceControls({ children }: { children: ReactNode }) {
  const target = useContext(GovernanceTarget);
  if (target === undefined) return children;
  if (!target) return null;
  return createPortal(<div className="governance-controls" onClick={() => {
    const menu = target.closest("details");
    menu?.removeAttribute("open");
    menu?.querySelector("summary")?.focus();
  }}>{children}</div>, target);
}
