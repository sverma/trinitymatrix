import { z } from "zod";

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

const placeholderPattern = /(?:replace|placeholder|required before launch|example\.com|todo|tbd|\[|\])/i;
const operationalEmail = z.string().trim().email().refine(
  (value) => value === value.toLowerCase(),
  "must be a lower-case email address"
);
const indianPostalAddress = z.string().trim().min(20).refine(
  (value) => /\bindia\b/i.test(value),
  "must be a complete Indian postal address that includes India"
);

const approvedEnvironmentSchema = z.object({
  LEGAL_POLICY_VERSION: z.string().trim().min(3),
  LEGAL_LAST_UPDATED: z.string().trim().min(8),
  LEGAL_EFFECTIVE_DATE: z.string().trim().min(8),
  LEGAL_OPERATOR_NAME: z.string().trim().min(3),
  LEGAL_OPERATOR_ENTITY_TYPE: z.string().trim().min(3),
  LEGAL_OPERATOR_REGISTRATION_ID: z.string().trim().min(3),
  LEGAL_REGISTERED_ADDRESS: indianPostalAddress,
  LEGAL_JURISDICTION_CITY: z.string().trim().min(2),
  LEGAL_JURISDICTION_STATE: z.string().trim().min(2),
  LEGAL_GRIEVANCE_OFFICER_NAME: z.string().trim().min(3),
  LEGAL_GRIEVANCE_OFFICER_ADDRESS: indianPostalAddress,
  LEGAL_SUPPORT_EMAIL: operationalEmail,
  LEGAL_PRIVACY_EMAIL: operationalEmail,
  LEGAL_GRIEVANCE_EMAIL: operationalEmail,
  LEGAL_SECURITY_EMAIL: operationalEmail,
  LEGAL_BUSINESS_EMAIL: operationalEmail
}).strict().superRefine((value, context) => {
  const serialized = JSON.stringify(value);
  if (placeholderPattern.test(serialized)) {
    context.addIssue({
      code: "custom",
      message: "approved policy metadata cannot contain placeholders"
    });
  }
});

const draftMetadata: PublicPolicyMetadata = Object.freeze({
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

export function loadPublicPolicyMetadata(environment: NodeJS.ProcessEnv): PublicPolicyMetadata {
  const publicationApproved = z.enum(["true", "false"])
    .default("false")
    .parse(environment.LEGAL_PUBLICATION_APPROVED);
  if (publicationApproved === "false") return draftMetadata;

  const candidate = Object.fromEntries(
    Object.keys(approvedEnvironmentSchema.shape).map((key) => [key, environment[key]])
  );
  const parsed = approvedEnvironmentSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid approved public policy metadata: ${details}`);
  }
  const value = parsed.data;
  return Object.freeze({
    publicationApproved: true,
    policyVersion: value.LEGAL_POLICY_VERSION,
    lastUpdated: value.LEGAL_LAST_UPDATED,
    effectiveDate: value.LEGAL_EFFECTIVE_DATE,
    operatorLegalName: value.LEGAL_OPERATOR_NAME,
    operatorEntityType: value.LEGAL_OPERATOR_ENTITY_TYPE,
    operatorRegistrationIdentifier: value.LEGAL_OPERATOR_REGISTRATION_ID,
    registeredAddress: value.LEGAL_REGISTERED_ADDRESS,
    jurisdictionCity: value.LEGAL_JURISDICTION_CITY,
    jurisdictionState: value.LEGAL_JURISDICTION_STATE,
    grievanceOfficerName: value.LEGAL_GRIEVANCE_OFFICER_NAME,
    grievanceOfficerAddress: value.LEGAL_GRIEVANCE_OFFICER_ADDRESS,
    supportEmail: value.LEGAL_SUPPORT_EMAIL,
    privacyEmail: value.LEGAL_PRIVACY_EMAIL,
    grievanceEmail: value.LEGAL_GRIEVANCE_EMAIL,
    securityEmail: value.LEGAL_SECURITY_EMAIL,
    businessEmail: value.LEGAL_BUSINESS_EMAIL
  });
}

export function serializePublicPolicyMetadataScript(metadata: PublicPolicyMetadata): string {
  const json = JSON.stringify(metadata)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `window.__TRINITYMATRIX_POLICY__=Object.freeze(${json});\n`;
}
