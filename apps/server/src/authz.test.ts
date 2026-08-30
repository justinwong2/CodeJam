import { describe, expect, it } from "vitest";
import { can, visibleTo } from "./authz.js";
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
    const owned = can(suspended, "docs", {
      ownerId: suspended.ownerId,
      visibility: "private",
    });
    expect(owned.allow).toBe(false);
    expect(owned.reason.length).toBeGreaterThan(0);
    // Neither does a public one, for the same reason.
    const shared = can(suspended, "docs", {
      ownerId: "user-a",
      visibility: "public",
    });
    expect(shared.allow).toBe(false);
    expect(shared.reason).toContain("suspended");
  });

  // The predicate the gateway and the tool service both import. It has exactly
  // one home: a second copy is how search starts leaking rows the direct-fetch
  // path hides.
  describe("visibleTo()", () => {
    it("shows a human their own document, public or private", () => {
      expect(
        visibleTo({ ownerId: "user-a", visibility: "private" }, "user-a"),
      ).toBe(true);
      expect(
        visibleTo({ ownerId: "user-a", visibility: "public" }, "user-a"),
      ).toBe(true);
    });

    it("shows anybody a public document", () => {
      expect(
        visibleTo({ ownerId: "user-a", visibility: "public" }, "user-b"),
      ).toBe(true);
    });

    it("hides another human's private document", () => {
      expect(
        visibleTo({ ownerId: "user-a", visibility: "private" }, "user-b"),
      ).toBe(false);
    });

    it("compares owners exactly, and treats nothing else as public", () => {
      expect(
        visibleTo({ ownerId: "user-a", visibility: "private" }, "USER-A"),
      ).toBe(false);
      expect(visibleTo({ ownerId: "user-a", visibility: "private" }, "")).toBe(
        false,
      );
    });
  });

  // The amended contract in one table: allow iff the role grants the tool and,
  // when a resource is named, the principal may see it — owned, or public.
  for (const role of ROLES) {
    for (const tool of TOOLS) {
      const acting = principal(role);
      const roleGrants = ROLE_TOOLS[role].includes(tool);
      const owned = { ownerId: acting.ownerId, visibility: "private" as const };
      const foreign = {
        ownerId: "someone-else",
        visibility: "private" as const,
      };
      const shared = { ownerId: "someone-else", visibility: "public" as const };

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

      it(`${role} + ${tool} + another owner's private resource → deny`, () => {
        const decision = can(acting, tool, foreign);
        expect(decision.allow).toBe(false);
        expect(decision.reason.length).toBeGreaterThan(0);
      });

      it(`${role} + ${tool} + another owner's public resource → ${roleGrants ? "allow" : "deny"}`, () => {
        // Public widens who may read, never who owns: the role still has to
        // grant the tool, and a role that grants nothing still gets nothing.
        const decision = can(acting, tool, shared);
        expect(decision.allow).toBe(roleGrants);
        expect(decision.reason.length).toBeGreaterThan(0);
      });
    }
  }

  it("never lets public transfer ownership", () => {
    const basic = principal("basic");
    const shared = { ownerId: "user-a", visibility: "public" as const };
    // Readable, and still someone else's: the allow reason says so, and the
    // resource's owner is unchanged by anybody having read it.
    const decision = can(basic, "docs", shared);
    expect(decision.allow).toBe(true);
    expect(decision.reason).not.toContain("owns this resource");
    expect(shared.ownerId).toBe("user-a");
  });

  it("names the role in a tool denial and the owner in an ownership denial", () => {
    const basic = principal("basic");
    const roleDenial = can(basic, "payments");
    expect(roleDenial.allow).toBe(false);
    expect(roleDenial.reason).toContain("basic");
    expect(roleDenial.reason).toContain("payments");

    const ownershipDenial = can(basic, "docs", {
      ownerId: "user-a",
      visibility: "private",
    });
    expect(ownershipDenial.allow).toBe(false);
    expect(ownershipDenial.reason).toContain("user-a");
    expect(ownershipDenial.reason).toContain(basic.ownerId);
  });

  it("checks the role before ownership, so a denial says what was wrong first", () => {
    // A basic principal reaching for someone else's payments resource is
    // denied for the tool it may never use, not for the ownership it lacks.
    const decision = can(principal("basic"), "payments", {
      ownerId: "user-a",
      visibility: "private",
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("payments");
  });

  it("compares owners exactly, not case-insensitively or by prefix", () => {
    const admin = principal("admin");
    const privately = (ownerId: string) =>
      can(admin, "docs", { ownerId, visibility: "private" as const }).allow;
    expect(privately("USER-A")).toBe(false);
    expect(privately("user-a2")).toBe(false);
    expect(privately("user-a")).toBe(true);
  });

  it("denies a role the seeded table does not know", () => {
    const rogue = { ...principal("admin"), role: "superuser" as Role };
    const decision = can(rogue, "model");
    expect(decision.allow).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
