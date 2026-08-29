import { ROLE_TOOLS } from "./types.js";
import type { Principal, ToolName } from "./types.js";

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
 * named, the principal owns it. The role is checked first so a denial names
 * the coarser failure: a principal who may not use a tool at all is denied
 * for the tool, not for the ownership it also lacks.
 */
export function can(
  principal: Principal,
  tool: ToolName,
  resource?: { ownerId: string },
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
  if (resource && resource.ownerId !== principal.ownerId) {
    return {
      allow: false,
      reason: `${principal.ownerId} may not use the ${tool} tool on a resource owned by ${resource.ownerId}`,
    };
  }
  return {
    allow: true,
    reason: resource
      ? `Role "${principal.role}" grants the ${tool} tool and ${principal.ownerId} owns this resource`
      : `Role "${principal.role}" grants the ${tool} tool`,
  };
}
