import { describe, expect, it } from "vitest";
import { loadPublicPolicyMetadata, serializePublicPolicyMetadataScript } from "./public-policy-metadata";

const approvedEnvironment: NodeJS.ProcessEnv = {
  LEGAL_PUBLICATION_APPROVED: "true",
  LEGAL_POLICY_VERSION: "2026-01",
  LEGAL_LAST_UPDATED: "31 August 2026",
  LEGAL_EFFECTIVE_DATE: "1 September 2026",
  LEGAL_OPERATOR_NAME: "Example Operator Private Limited",
  LEGAL_OPERATOR_ENTITY_TYPE: "private limited company",
  LEGAL_OPERATOR_REGISTRATION_ID: "U12345AB2026PTC123456",
  LEGAL_REGISTERED_ADDRESS: "100 Example Road, Bengaluru, Karnataka 560001, India",
  LEGAL_JURISDICTION_CITY: "Bengaluru",
  LEGAL_JURISDICTION_STATE: "Karnataka",
  LEGAL_GRIEVANCE_OFFICER_NAME: "Example Officer",
  LEGAL_GRIEVANCE_OFFICER_ADDRESS: "100 Example Road, Bengaluru, Karnataka 560001, India",
  LEGAL_SUPPORT_EMAIL: "support@trinitymatrix.com",
  LEGAL_PRIVACY_EMAIL: "privacy@trinitymatrix.com",
  LEGAL_GRIEVANCE_EMAIL: "grievance@trinitymatrix.com",
  LEGAL_SECURITY_EMAIL: "security@trinitymatrix.com",
  LEGAL_BUSINESS_EMAIL: "business@trinitymatrix.com"
};

describe("public policy metadata", () => {
  it("keeps unapproved environments visibly in draft", () => {
    const metadata = loadPublicPolicyMetadata({ LEGAL_PUBLICATION_APPROVED: "false" });

    expect(metadata.publicationApproved).toBe(false);
    expect(metadata.operatorLegalName).toMatch(/required before launch/i);
    expect(() => loadPublicPolicyMetadata({ LEGAL_PUBLICATION_APPROVED: "yes" })).toThrow();
  });

  it("accepts only complete approved production facts", () => {
    const metadata = loadPublicPolicyMetadata(approvedEnvironment);

    expect(metadata.publicationApproved).toBe(true);
    expect(metadata.grievanceEmail).toBe("grievance@trinitymatrix.com");
  });

  it("rejects missing, placeholder and invalid approved contacts", () => {
    expect(() => loadPublicPolicyMetadata({ ...approvedEnvironment, LEGAL_OPERATOR_NAME: "[REPLACE ME]" }))
      .toThrow(/placeholders/i);
    expect(() => loadPublicPolicyMetadata({ ...approvedEnvironment, LEGAL_PRIVACY_EMAIL: undefined }))
      .toThrow(/LEGAL_PRIVACY_EMAIL/);
    expect(() => loadPublicPolicyMetadata({ ...approvedEnvironment, LEGAL_PRIVACY_EMAIL: "not-an-email" }))
      .toThrow(/email/i);
    expect(() => loadPublicPolicyMetadata({ ...approvedEnvironment, LEGAL_PRIVACY_EMAIL: "support@trinitymatrix.com" }))
      .not.toThrow();
  });

  it("escapes markup-breaking characters in the same-origin JavaScript response", () => {
    const metadata = loadPublicPolicyMetadata({
      ...approvedEnvironment,
      LEGAL_OPERATOR_NAME: "Example <script> Operator Private Limited"
    });
    const script = serializePublicPolicyMetadataScript(metadata);

    expect(script).not.toContain("<script>");
    expect(script).toContain("\\u003cscript>");
  });
});
