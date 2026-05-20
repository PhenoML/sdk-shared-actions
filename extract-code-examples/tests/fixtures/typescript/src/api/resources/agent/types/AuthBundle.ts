// Synthetic fixture: Fern's discriminated-union shape (`type X = A | B | ...`
// + same-named namespace with variant interfaces). The TS parser must bail
// on this file — see tsIsDiscriminatedUnionFile.

export type AuthBundle =
    | AuthBundle.Jwt
    | AuthBundle.ClientSecret
    | AuthBundle.None;

export namespace AuthBundle {
    export interface Jwt {
        auth_method: "jwt";
        token: string;
    }
    export interface ClientSecret {
        auth_method: "client_secret";
        client_id: string;
        client_secret: string;
    }
    export interface None {
        auth_method: "none";
    }
}
