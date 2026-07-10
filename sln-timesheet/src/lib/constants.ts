// Workcode taxonomy — from the firm's real Prohukum data.
export const WORKCODES = [
  "Meeting",
  "Coordination",
  "Review",
  "Drafting",
  "Discussion",
  "Court",
  "Correspondence",
  "Preparation",
  "Finalize",
] as const;

export type Workcode = (typeof WORKCODES)[number];

export const FEE_TYPE_LABEL: Record<string, string> = {
  hourly: "Hourly",
  lump_sum: "Lump Sum",
  retainer: "Retainer",
  success_fee: "Success Fee",
  internal: "Internal",
};
