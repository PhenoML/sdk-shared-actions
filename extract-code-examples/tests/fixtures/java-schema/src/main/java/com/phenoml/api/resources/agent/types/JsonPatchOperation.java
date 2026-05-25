/**
 * Synthetic fixture: mirrors the real Fern-generated JsonPatchOperation
 * class. The class IS a regular Fern request-class shape (staged
 * builder, @JsonProperty getters) so the list-passthrough item
 * resolution recurses into its field catalog (op, path, value).
 */
package com.phenoml.api.resources.agent.types;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Optional;

public final class JsonPatchOperation {
    private final String op;
    private final String path;
    private final Optional<Object> value;

    private JsonPatchOperation(String op, String path, Optional<Object> value) {
        this.op = op;
        this.path = path;
        this.value = value;
    }

    @JsonProperty("op")
    public String getOp() {
        return op;
    }

    @JsonProperty("path")
    public String getPath() {
        return path;
    }

    @JsonProperty("value")
    public Optional<Object> getValue() {
        return value;
    }

    public static OpStage builder() {
        return new Builder();
    }

    public interface OpStage {
        PathStage op(String op);
    }

    public interface PathStage {
        _FinalStage path(String path);
    }

    public interface _FinalStage {
        _FinalStage value(Object value);

        JsonPatchOperation build();
    }

    private static final class Builder implements OpStage, PathStage, _FinalStage {
        private String op;
        private String path;
        private Optional<Object> value = Optional.empty();

        @Override
        public PathStage op(String op) {
            this.op = op;
            return this;
        }

        @Override
        public _FinalStage path(String path) {
            this.path = path;
            return this;
        }

        @Override
        public _FinalStage value(Object value) {
            this.value = Optional.of(value);
            return this;
        }

        @Override
        public JsonPatchOperation build() {
            return new JsonPatchOperation(op, path, value);
        }
    }
}
