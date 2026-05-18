// Synthetic fixture for the TS schema extractor. Exercises:
//   - required + optional properties (the `?` suffix)
//   - a string-literal-union enum exposed as a sibling namespace const
//   - a list of scalars (`tools: string[]`)
//   - a list of objects (`categories: Tag[]`) for nested-recursion coverage
//   - a hyphenated header-style key

import { Tag } from "../../types/Tag";

export interface AgentChatRequest {
    /** Optional header — destructured out of `request` by the private __method. */
    "X-Phenoml-On-Behalf-Of"?: string;
    /** Required scalar body field. */
    message: string;
    /** Optional enum-shaped role. */
    role?: AgentChatRequest.Role;
    /** Optional list of tool ids. */
    tools?: string[];
    /** Optional list of tag objects (exercises items.nested). */
    categories?: Tag[];
}

export namespace AgentChatRequest {
    /** Allowed values for `role`. */
    export const Role = {
        Assistant: "assistant",
        Reviewer: "reviewer",
    } as const;
    export type Role = (typeof Role)[keyof typeof Role];
}
