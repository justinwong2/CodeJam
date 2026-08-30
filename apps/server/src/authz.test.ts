import { describe, expect, it } from "vitest";
import { can } from "./authz.js";
import { ROLE_TOOLS } from "./types.js";
import type { Principal, Role, ToolName } from "./types.js";

const TOOLS: ToolName[] = ["model", "docs", "search", "payments"];
const ROLES: Role[] = ["admin", "basic", "suspended"];

const OWNER_OF: Record<Role, string> = {
  admin: "user-a",
  basic: "user-b",
  suspended: "user-c",
};

const principal = (role: Role): Principal => ({
  humanId: OWNER_OF[role],
  ownerId: OWNER_OF[role],
  agentId: "agent-1",
  runId: "run-1",
  role,
});

describe("can()", () => {
  // The matrix below derives its expected outcomes from ROLE_TOOLS, so the
  // seeded grants must be pinned here independently — without this, editing
  // the table (say, granting basic payments) would shift the matrix's
  // expectations along with the behavior and every cell would stay green.
  it("seeds exactly the frozen role→tool table", () => {
    expect(ROLE_TOOLS).toEqual({
      admin: ["model", "docs", "search", "payments"],
      basic: ["model", "docs", "search"],
      suspended: [],
    });
  });

  // Suspension is total by construction: an empty grant list means every tool,
  // the model included, is refused without `can()` learning a new rule.
  it("denies a suspended owner every tool, model included, with a reason", () => {
    const suspended = principal("suspended");
    for (const tool of TOOLS) {
      const decision = can(suspended, tool);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain("suspended");
      expect(decision.reason).toContain(tool);
    }
    // Owning the resource does not rescue it: the role is checked first.
    const owned = can(suspended, "docs", { ownerId: suspended.ownerId });
    expect(owned.allow).toBe(false);
    expect(owned.reason.length).toBeGreaterThan(0);
  });

  // The frozen contract in one table: allow iff the role grants the tool and,
  // when a resource is named, the principal owns it.
  for (const role of ROLES) {
    for (const tool of TOOLS) {
      const acting = principal(role);
      const roleGrants = ROLE_TOOLS[role].includes(tool);
      const owned = { ownerId: acting.ownerId };
      const foreign = { ownerId: "someone-else" };

      it(`${role} + ${tool} + no resource → ${roleGrants ? "allow" : "deny"}`, () => {
        const decision = can(acting, tool);
        expect(decision.allow).toBe(roleGrants);
        expect(decision.reason.length).toBeGreaterThan(0);
      });

      it(`${role} + ${tool} + owned resource → ${roleGrants ? "allow" : "deny"}`, () => {
        const decision = can(acting, tool, owned);
        expect(decision.allow).toBe(roleGrants);
        expect(decision.reason.length).toBeGreaterThan(0);
      });

      it(`${role} + ${tool} + another owner's resource → deny`, () => {
        const decision = can(acting, tool, foreign);
        expect(decision.allow).toBe(false);
        expect(decision.reason.length).toBeGreaterThan(0);
      });
    }
  }

  it("names the role in a tool denial and the owner in an ownership denial", () => {
    const basic = principal("basic");
    const roleDenial = can(basic, "payments");
    expect(roleDenial.allow).toBe(false);
    expect(roleDenial.reason).toContain("basic");
    expect(roleDenial.reason).toContain("payments");

    const ownershipDenial = can(basic, "docs", { ownerId: "user-a" });
    expect(ownershipDenial.allow).toBe(false);
    expect(ownershipDenial.reason).toContain("user-a");
    expect(ownershipDenial.reason).toContain(basic.ownerId);
  });

  it("checks the role before ownership, so a denial says what was wrong first", () => {
    // A basic principal reaching for someone else's payments resource is
    // denied for the tool it may never use, not for the ownership it lacks.
    const decision = can(principal("basic"), "payments", { ownerId: "user-a" });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("payments");
  });

  it("compares owners exactly, not case-insensitively or by prefix", () => {
    const admin = principal("admin");
    expect(can(admin, "docs", { ownerId: "USER-A" }).allow).toBe(false);
    expect(can(admin, "docs", { ownerId: "user-a2" }).allow).toBe(false);
    expect(can(admin, "docs", { ownerId: "user-a" }).allow).toBe(true);
  });

  it("denies a role the seeded table does not know", () => {
    const rogue = { ...principal("admin"), role: "superuser" as Role };
    const decision = can(rogue, "model");
    expect(decision.allow).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
