// Synthetic fixture: a top-level `export interface` paired with a helper
// union alias whose branches include a TypeReference (`Tag | undefined`).
// The TS parser must NOT misread this as a discriminated-union file — see
// tsIsDiscriminatedUnionFile.

import { Tag } from "./Tag";

export interface MixedAlias {
    label: string;
    tag?: Tag;
}

export type MixedAliasOrEmpty = MixedAlias | undefined;
