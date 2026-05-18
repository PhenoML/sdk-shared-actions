/**
 * Synthetic nested-type fixture: exercised by CreateAgentRequest's
 * `categories: List<Tag>` field to verify list-of-object recursion.
 */
package com.phenoml.api.resources.agent.types;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Objects;
import java.util.Optional;
import org.jetbrains.annotations.NotNull;

public final class Tag {
    private final String name;

    private final Optional<String> color;

    private Tag(String name, Optional<String> color) {
        this.name = name;
        this.color = color;
    }

    @JsonProperty("name")
    public String getName() {
        return name;
    }

    @JsonProperty("color")
    public Optional<String> getColor() {
        return color;
    }

    public static NameStage builder() {
        return new Builder();
    }

    public interface NameStage {
        _FinalStage name(@NotNull String name);
    }

    public interface _FinalStage {
        Tag build();
        _FinalStage color(Optional<String> color);
        _FinalStage color(String color);
    }

    public static final class Builder implements NameStage, _FinalStage {
        private String name;
        private Optional<String> color = Optional.empty();

        private Builder() {}

        public _FinalStage name(@NotNull String name) { this.name = Objects.requireNonNull(name); return this; }
        public _FinalStage color(String color) { this.color = Optional.ofNullable(color); return this; }
        public _FinalStage color(Optional<String> color) { this.color = color; return this; }

        public Tag build() { return new Tag(name, color); }
    }
}
