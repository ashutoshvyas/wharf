import { clsx, type ClassValue } from "clsx";

/** Class name combiner — thin re-export of clsx for the UI kit. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
