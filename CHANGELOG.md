# Changelog

## [1.1.1](https://github.com/PhenoML/sdk-shared-actions/compare/1.1.0...1.1.1) (2026-07-10)


### Bug Fixes

* **sdk-release-finalize:** preserve Fern generation commits ([#40](https://github.com/PhenoML/sdk-shared-actions/issues/40)) ([2fead8d](https://github.com/PhenoML/sdk-shared-actions/commit/2fead8d6c70d116e0e73ead8097ee5a5fde5f64c))

## [1.1.0](https://github.com/PhenoML/sdk-shared-actions/compare/1.0.3...1.1.0) (2026-07-10)


### Features

* **sdk-release-workflows:** add shared SDK release flow ([#38](https://github.com/PhenoML/sdk-shared-actions/issues/38)) ([8f8f7e6](https://github.com/PhenoML/sdk-shared-actions/commit/8f8f7e6680b489a2518149d95cfa78c304a9bd89))

## [1.0.3](https://github.com/PhenoML/sdk-shared-actions/compare/1.0.2...1.0.3) (2026-06-25)


### Bug Fixes

* **bundle-openapi-spec:** fetch specs from public bucket ([#35](https://github.com/PhenoML/sdk-shared-actions/issues/35)) ([84e6d11](https://github.com/PhenoML/sdk-shared-actions/commit/84e6d11fc5317e3996fd818dd26ed6b6b52275f4))

## [1.0.2](https://github.com/PhenoML/sdk-shared-actions/compare/1.0.1...1.0.2) (2026-06-15)


### Bug Fixes

* **release-please:** use client-id for create-github-app-token ([#32](https://github.com/PhenoML/sdk-shared-actions/issues/32)) ([7b9605a](https://github.com/PhenoML/sdk-shared-actions/commit/7b9605a49008ae4a7d325f2cd6b5eaf872a0c2e8))

## [1.0.1](https://github.com/PhenoML/sdk-shared-actions/compare/1.0.0...1.0.1) (2026-06-15)


### Bug Fixes

* **release-please:** use GitHub App token so the release PR can bump workflow pins ([#30](https://github.com/PhenoML/sdk-shared-actions/issues/30)) ([f7a5f50](https://github.com/PhenoML/sdk-shared-actions/commit/f7a5f50cfc50d6f8337a9b4f86ab09b948e068b8))
* **sync-fern-artifacts:** suppress approval-gated commit-back re-run ([#29](https://github.com/PhenoML/sdk-shared-actions/issues/29)) ([9621454](https://github.com/PhenoML/sdk-shared-actions/commit/9621454f36455ce2304d65cf392758198b956c77))

## 1.0.0 (2026-06-02)


### Features

* add extract-code-examples composite action ([#1](https://github.com/PhenoML/sdk-shared-actions/issues/1)) ([6f75653](https://github.com/PhenoML/sdk-shared-actions/commit/6f75653a329d2094c70b9db5ca9d103dd33bf4a9))
* **extract-code-examples:** dynamic-render schema for SDK call examples ([#15](https://github.com/PhenoML/sdk-shared-actions/issues/15)) ([dcd8279](https://github.com/PhenoML/sdk-shared-actions/commit/dcd82798ff6beabbb1b28d6765fe5f0ab079f1d8))


### Bug Fixes

* **extract-code-examples:** anchor Python f-string path regex to a word boundary ([#24](https://github.com/PhenoML/sdk-shared-actions/issues/24)) ([045e9e8](https://github.com/PhenoML/sdk-shared-actions/commit/045e9e8b17ed05671da21db3984ce71b6b323459))
* **extract-code-examples:** flag SSE endpoints so the manifest doesn't surface mock placeholder bodies ([#8](https://github.com/PhenoML/sdk-shared-actions/issues/8)) ([8637878](https://github.com/PhenoML/sdk-shared-actions/commit/8637878d68bcc3b0348f257f941f471d3ab472a5))
* **extract-code-examples:** Java extractor — capture full SDK call snippets for deeply-nested builders ([#11](https://github.com/PhenoML/sdk-shared-actions/issues/11)) ([ab726a9](https://github.com/PhenoML/sdk-shared-actions/commit/ab726a937574eea43780fadcb428437ea1725c71))
* **extract-code-examples:** Java parser — classify Fern forward-compatible enums as enum, not builder class ([#20](https://github.com/PhenoML/sdk-shared-actions/issues/20)) ([ec4d32f](https://github.com/PhenoML/sdk-shared-actions/commit/ec4d32ffe2d1080bdbf4ee0938624bc8067c32d1))
* **extract-code-examples:** Java parser — don't drop endpoints whose signature spans 3+ lines ([#13](https://github.com/PhenoML/sdk-shared-actions/issues/13)) ([2266c3d](https://github.com/PhenoML/sdk-shared-actions/commit/2266c3d28af1b776511576270c3a68bcb4995d4a))
* **extract-code-examples:** nest TS request body under Fern's body wrapper key ([#25](https://github.com/PhenoML/sdk-shared-actions/issues/25)) ([2bf850c](https://github.com/PhenoML/sdk-shared-actions/commit/2bf850c9713283f8401c191eb6fbd64990f4b70f))
* **extract-code-examples:** Python parser — multi-line verify_request_count calls ([#10](https://github.com/PhenoML/sdk-shared-actions/issues/10)) ([06dedf0](https://github.com/PhenoML/sdk-shared-actions/commit/06dedf025f8fd0292f48ea92d46411eee5819d41))
* **extract-code-examples:** Python parser — PATCH passthrough bodies and inline literal fields ([#7](https://github.com/PhenoML/sdk-shared-actions/issues/7)) ([3571897](https://github.com/PhenoML/sdk-shared-actions/commit/3571897596c8ec47b87099c950d2147d0341575e))
* **extract-code-examples:** Python parser — rewrite Pydantic-model constructor calls as JSON objects ([#12](https://github.com/PhenoML/sdk-shared-actions/issues/12)) ([37870c7](https://github.com/PhenoML/sdk-shared-actions/commit/37870c78d7b8b700a64bc97db20bb1fa34646580))
* **extract-code-examples:** source Python SDK identifiers from SDK source, fixing 3 Python rendering bugs ([#23](https://github.com/PhenoML/sdk-shared-actions/issues/23)) ([822a950](https://github.com/PhenoML/sdk-shared-actions/commit/822a9508fe78c0ee14ac54daef1ac0d8b1b4a7e0))
* **extract-code-examples:** synthesize passthrough body for type-alias, list, and discriminated-union request types (TS + Java) ([#19](https://github.com/PhenoML/sdk-shared-actions/issues/19)) ([887e7aa](https://github.com/PhenoML/sdk-shared-actions/commit/887e7aa2dac9d13501393fbc495c74197ab21d87))
* **extract-code-examples:** three Python parser fixes (streaming wrapper, path-param wrapper, request body extraction) ([#5](https://github.com/PhenoML/sdk-shared-actions/issues/5)) ([5c80a33](https://github.com/PhenoML/sdk-shared-actions/commit/5c80a3312f4448f9526c4ae97a833da3f6f3604d))
* **extract-code-examples:** TS parser — bail on discriminated-union request fields ([#17](https://github.com/PhenoML/sdk-shared-actions/issues/17)) ([87cb097](https://github.com/PhenoML/sdk-shared-actions/commit/87cb097f631b8cdc540e3a04b4bf752938e6a63d))
* **extract-code-examples:** TS parser — flag SSE endpoints so SSE wire bodies don't leak into manifest ([#14](https://github.com/PhenoML/sdk-shared-actions/issues/14)) ([222e731](https://github.com/PhenoML/sdk-shared-actions/commit/222e73145c44a8c36ffe904fd17a690875a6e027))
* Java extractor — camelCase accessor chains and TestResources fixtures ([#4](https://github.com/PhenoML/sdk-shared-actions/issues/4)) ([159bfab](https://github.com/PhenoML/sdk-shared-actions/commit/159bfabbc382fcf3236788c93efc331db82e85b9))
* Java extractor — keep URL path when streaming endpoints call .newBuilder() twice ([#6](https://github.com/PhenoML/sdk-shared-actions/issues/6)) ([620b5cf](https://github.com/PhenoML/sdk-shared-actions/commit/620b5cf0dbfee4dd305766e105aedf139da88125))
* retry push on non-fast-forward to absorb concurrent-workflow races ([#16](https://github.com/PhenoML/sdk-shared-actions/issues/16)) ([8098019](https://github.com/PhenoML/sdk-shared-actions/commit/80980199c0f1e8b75250cded8cb97b52da63237b))


### Continuous Integration

* add release-please with lockstep action-pin bumping ([0148230](https://github.com/PhenoML/sdk-shared-actions/commit/0148230cf3203855fec7ae165f7c848f8ffe6c70))
