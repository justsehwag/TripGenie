import { describe, it, expect } from "vitest";
import { buildSecurityPlan, roleIsLeastPrivilege } from "@/lib/security";

/** Feature: tripgenie - AWS security controls (least-privilege, KMS, tags, Guardrails). */

describe("Feature: tripgenie, security controls", () => {
  const plan = buildSecurityPlan();

  it("every IAM role is least-privilege (no wildcard, in-scope only)", () => {
    expect(plan.roles.length).toBeGreaterThan(0);
    for (const role of plan.roles) {
      expect(roleIsLeastPrivilege(role)).toBe(true);
    }
  });

  it("a role reaching outside its scope is rejected", () => {
    expect(
      roleIsLeastPrivilege({
        name: "bad",
        scope: ["arn:aws:dynamodb:*:*:table/a"],
        statements: [{ Effect: "Allow", Action: ["dynamodb:*"], Resource: ["*"] }],
      }),
    ).toBe(false);
  });

  it("every provisioned resource carries the mandatory tags", () => {
    expect(plan.resources.length).toBeGreaterThan(0);
    for (const r of plan.resources) {
      expect(r.tags.Name.length).toBeGreaterThan(0);
      expect(r.tags.Purpose.length).toBeGreaterThan(0);
      // Purpose must not reference the reference app.
      expect(r.tags.Purpose.toLowerCase()).not.toContain("tripsaathi");
    }
  });

  it("Profiles/Trips/Memory are encrypted at rest with KMS", () => {
    const mustEncrypt = ["dynamodb-table", "agentcore-memory"];
    const sensitive = plan.resources.filter((r) => mustEncrypt.includes(r.kind));
    expect(sensitive.length).toBeGreaterThanOrEqual(3);
    for (const r of sensitive) expect(r.kmsEncrypted).toBe(true);
  });

  it("Guardrails guard both model input and output, and CloudTrail is on", () => {
    expect(plan.guardrail.appliesToInput).toBe(true);
    expect(plan.guardrail.appliesToOutput).toBe(true);
    expect(plan.cloudTrail.enabled).toBe(true);
    expect(plan.cloudTrail.recordsControlPlane).toBe(true);
    // Supplier credentials resolve from Secrets Manager, not inlined.
    expect(plan.secrets.length).toBeGreaterThan(0);
    for (const s of plan.secrets) expect(s).toContain("secretsmanager");
  });
});
