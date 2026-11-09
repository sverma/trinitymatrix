import { afterEach, describe, expect, it } from "vitest";
import { getPublicPolicyMetadata, type PublicPolicyMetadata } from "./policy-metadata";

const completeMetadata: PublicPolicyMetadata = {
  publicationApproved: true,
  policyVersion: "2026-01",
  lastUpdated: "31 August 2026",
  effectiveDate: "1 September 2026",
  operatorLegalName: "Example Operator Private Limited",
  operatorEntityType: "private limited company",
  operatorRegistrationIdentifier: "U12345AB2026PTC123456",
  registeredAddress: "100 Example Road, Bengaluru, Karnataka 560001, India",
  jurisdictionCity: "Bengaluru",
  jurisdictionState: "Karnataka",
  grievanceOfficerName: "Example Officer",
  grievanceOfficerAddress: "100 Example Road, Bengaluru, Karnataka 560001, India",
  supportEmail: "support@trinitymatrix.com",
  privacyEmail: "privacy@trinitymatrix.com",
  grievanceEmail: "grievance@trinitymatrix.com",
  securityEmail: "security@trinitymatrix.com",
  businessEmail: "business@trinitymatrix.com"
};

afterEach(() => {
  delete window.__TRINITYMATRIX_POLICY__;
});

describe("public policy metadata", () => {
  it("uses conspicuous draft values when the runtime script is absent or malformed", () => {
    window.__TRINITYMATRIX_POLICY__ = { publicationApproved: true };

    const metadata = getPublicPolicyMetadata();

    expect(metadata.publicationApproved).toBe(false);
    expect(metadata.operatorLegalName).toMatch(/required before launch/i);
  });

  it("accepts a complete same-origin runtime metadata object", () => {
    window.__TRINITYMATRIX_POLICY__ = completeMetadata;

    expect(getPublicPolicyMetadata()).toEqual(completeMetadata);
  });
});
