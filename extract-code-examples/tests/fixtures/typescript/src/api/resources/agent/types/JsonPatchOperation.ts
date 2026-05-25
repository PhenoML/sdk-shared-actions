// Synthetic fixture: mirrors `JsonPatchOperation` — the item type the
// `JsonPatch` array alias resolves to. The schema builder walks here to
// build the items SchemaField for the synthetic passthrough list field.

export interface JsonPatchOperation {
    op: JsonPatchOperation.Op;
    path: string;
    value?: unknown;
    from?: string;
}

export namespace JsonPatchOperation {
    export const Op = {
        Add: "add",
        Remove: "remove",
        Replace: "replace",
    } as const;
    export type Op = (typeof Op)[keyof typeof Op];
}
