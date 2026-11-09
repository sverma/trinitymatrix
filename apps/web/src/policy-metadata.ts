export type PublicPolicyMetadata = Readonly<{
  publicationApproved: boolean;
  policyVersion: string;
  lastUpdated: string;
  effectiveDate: string;
  operatorLegalName: string;
  operatorEntityType: string;
  operatorRegistrationIdentifier: string;
  registeredAddress: string;
  jurisdictionCity: string;
  jurisdictionState: string;
  grievanceOfficerName: string;
  grievanceOfficerAddress: string;
  supportEmail: string;
  privacyEmail: string;
  grievanceEmail: string;
  securityEmail: string;
  businessEmail: string;
}>;

declare global {
  interface Window {
    __TRINITYMATRIX_POLICY__?: unknown;
  }
}

const requiredStringKeys = [
  "policyVersion",
  "lastUpdated",
  "effectiveDate",
  "operatorLegalName",
  "operatorEntityType",
  "operatorRegistrationIdentifier",
  "registeredAddress",
  "jurisdictionCity",
  "jurisdictionState",
  "grievanceOfficerName",
  "grievanceOfficerAddress",
  "supportEmail",
  "privacyEmail",
  "grievanceEmail",
  "securityEmail",
  "businessEmail"
] as const satisfies readonly (keyof PublicPolicyMetadata)[];

const draftPolicyMetadata: PublicPolicyMetadata = Object.freeze({
  publicationApproved: false,
  policyVersion: "DRAFT",
  lastUpdated: "29 August 2026",
  effectiveDate: "[EFFECTIVE DATE — REQUIRED BEFORE LAUNCH]",
  operatorLegalName: "[LEGAL ENTITY NAME — REQUIRED BEFORE LAUNCH]",
  operatorEntityType: "[ENTITY TYPE — REQUIRED BEFORE LAUNCH]",
  operatorRegistrationIdentifier: "[REGISTRATION IDENTIFIER — REQUIRED BEFORE LAUNCH]",
  registeredAddress: "[FULL REGISTERED POSTAL ADDRESS IN INDIA — REQUIRED BEFORE LAUNCH]",
  jurisdictionCity: "[CITY — REQUIRED BEFORE LAUNCH]",
  jurisdictionState: "[STATE — REQUIRED BEFORE LAUNCH]",
  grievanceOfficerName: "[GRIEVANCE OFFICER NAME — REQUIRED BEFORE LAUNCH]",
  grievanceOfficerAddress: "[GRIEVANCE OFFICER POSTAL ADDRESS IN INDIA — REQUIRED BEFORE LAUNCH]",
  supportEmail: "[SUPPORT EMAIL ADDRESS — REQUIRED BEFORE LAUNCH]",
  privacyEmail: "[PRIVACY EMAIL ADDRESS — REQUIRED BEFORE LAUNCH]",
  grievanceEmail: "[GRIEVANCE EMAIL ADDRESS — REQUIRED BEFORE LAUNCH]",
  securityEmail: "[SECURITY EMAIL ADDRESS — REQUIRED BEFORE LAUNCH]",
  businessEmail: "[BUSINESS EMAIL ADDRESS — REQUIRED BEFORE LAUNCH]"
});

function isPublicPolicyMetadata(candidate: unknown): candidate is PublicPolicyMetadata {
  if (!candidate || typeof candidate !== "object") return false;
  const record = candidate as Record<string, unknown>;
  return typeof record.publicationApproved === "boolean"
    && requiredStringKeys.every((key) => typeof record[key] === "string" && (record[key] as string).trim().length > 0);
}

/**
 * Production supplies this object from a same-origin, no-store script before
 * the application bundle runs. A missing or malformed script deliberately
 * falls back to conspicuous draft values; the UI can never silently present
 * an incomplete policy as approved.
 */
export function getPublicPolicyMetadata(): PublicPolicyMetadata {
  const candidate = typeof window === "undefined" ? undefined : window.__TRINITYMATRIX_POLICY__;
  return isPublicPolicyMetadata(candidate) ? Object.freeze({ ...candidate }) : draftPolicyMetadata;
}
