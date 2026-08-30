import { ROLE_TOOLS } from "./types.js";
import type { Principal, ToolName, Visibility } from "./types.js";

/**
 * A resource as an authorization question sees it: who owns it and who else may
 * read it. Never its content — nothing here decides anything about a payload.
 */
export interface OwnedResource {
  ownerId: string;
  visibility: Visibility;
}

/**
 * "Owned OR public", and the only implementation of it. Both callers import
 * this one function — the gateway for a direct fetch, the mock tool service for
 * a scoped search — because two copies is how search starts returning rows the
 * direct-fetch path hides.
 *
 * Public widens who may read; it never transfers ownership. A public document
 * still has exactly one owner, and this predicate does not change who that is.
 */
export function visibleTo(resource: OwnedResource, ownerId: string): boolean {
  return resource.visibility === "public" || resource.ownerId === ownerId;
}

/**
 * The outcome of one authorization question. `reason` is always populated:
 * a denial's reason is what the operator reads in the evidence trail, so it
 * has to say why in words, not in a code.
 */
export interface AuthorizationDecision {
  allow: boolean;
  reason: string;
}

/**
 * The single authorization entry point — pure and synchronous so it can be
 * exhaustively tested without a server, a store, or a clock.
 *
 * Allow iff the principal's role grants `tool` **and**, when a resource is
 * named, the principal may see it — owns it, or it is public. The role is
 * checked first so a denial names the coarser failure: a principal who may not
 * use a tool at all is denied for the tool, not for the ownership it also
 * lacks.
 *
 * A denial's reason is the truth about why, and stays the truth even where the
 * caller is deliberately told something blander: the gateway answers an
 * ownership denial on a document with a "not found", and files this reason.
 */
export function can(
  principal: Principal,
  tool: ToolName,
  resource?: OwnedResource,
): AuthorizationDecision {
  const granted = ROLE_TOOLS[principal.role];
  if (!granted) {
    return {
      allow: false,
      reason: `Unknown role "${principal.role}" grants no tools`,
    };
  }
  if (!granted.includes(tool)) {
    return {
      allow: false,
      reason: `Role "${principal.role}" may not use the ${tool} tool`,
    };
  }
  if (resource && !visibleTo(resource, principal.ownerId)) {
    return {
      allow: false,
      reason: `${principal.ownerId} may not use the ${tool} tool on a resource owned by ${resource.ownerId}`,
    };
  }
  if (!resource) {
    return {
      allow: true,
      reason: `Role "${principal.role}" grants the ${tool} tool`,
    };
  }
  return {
    allow: true,
    reason:
      resource.ownerId === principal.ownerId
        ? `Role "${principal.role}" grants the ${tool} tool and ${principal.ownerId} owns this resource`
        : `Role "${principal.role}" grants the ${tool} tool and this resource is public`,
  };
}
