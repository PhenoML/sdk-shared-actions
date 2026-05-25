// Synthetic fixture: mirrors the real Fern-generated FhirClient.patch
// method. The raw client destructures `body: _body` (without a rest
// binding) so the wire body is just the JSON Patch array — the
// `X-Phenoml-*` keys are forwarded as headers. Exercises the
// passthroughBody detection.

import * as core from "../../../../core/index.js";
import { handleNonStatusCodeError } from "../../../../errors/handleNonStatusCodeError.js";
import * as phenoml from "../../../index.js";

export class FhirClient {
    public patch(
        fhir_provider_id: string,
        fhir_path: string,
        request: phenoml.fhir.FhirPatchRequest,
    ): core.HttpResponsePromise<unknown> {
        return core.HttpResponsePromise.fromPromise(this.__patch(fhir_provider_id, fhir_path, request));
    }

    private async __patch(
        fhir_provider_id: string,
        fhir_path: string,
        request: phenoml.fhir.FhirPatchRequest,
    ): Promise<core.WithRawResponse<unknown>> {
        const {
            "X-Phenoml-On-Behalf-Of": phenomlOnBehalfOf,
            "X-Phenoml-Fhir-Provider": phenomlFhirProvider,
            body: _body,
        } = request;
        const _response = await core.fetcher({
            url: `https://example/fhir-provider/${fhir_provider_id}/fhir/${fhir_path}`,
            method: "PATCH",
            body: _body,
        });
        if (_response.ok) return { data: _response.body, rawResponse: _response.rawResponse };
        return handleNonStatusCodeError(
            _response.error,
            _response.rawResponse,
            "PATCH",
            "/fhir-provider/{fhir_provider_id}/fhir/{fhir_path}",
        );
    }
}
