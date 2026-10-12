import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * The row a voice command picked on a list page that has no detail page of
 * its own ("otevři fakturu 2026-014" → /invoices?invoice=…). It is scrolled
 * into view once the rows are there and marked with the class `picked-row`.
 */
/** The element id of a row that can be picked: `pickedRowId("invoice", id)`. */
export function pickedRowId(parameter: string, id: string) {
  return [parameter, id].join("-");
}

export function usePickedRow(parameter: string, rowsLoaded: unknown): string | null {
  const [searchParams] = useSearchParams();
  const picked = searchParams.get(parameter);
  useEffect(() => {
    if (!picked) return;
    document.getElementById(pickedRowId(parameter, picked))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [parameter, picked, rowsLoaded]);
  return picked;
}
