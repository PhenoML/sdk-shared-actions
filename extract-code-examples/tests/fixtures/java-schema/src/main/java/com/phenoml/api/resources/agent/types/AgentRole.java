/**
 * Synthetic enum fixture mirroring Fern's emitted shape (constructor takes
 * the wire-side value, @JsonValue exposes it back).
 */
package com.phenoml.api.resources.agent.types;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

public enum AgentRole {
    ASSISTANT("assistant"),
    REVIEWER("reviewer"),
    CUSTOM("custom");

    private final String value;

    AgentRole(String value) {
        this.value = value;
    }

    @JsonValue
    public String getValue() {
        return value;
    }

    @JsonCreator
    public static AgentRole fromString(String value) {
        for (AgentRole r : values()) {
            if (r.value.equals(value)) return r;
        }
        throw new IllegalArgumentException(value);
    }
}
