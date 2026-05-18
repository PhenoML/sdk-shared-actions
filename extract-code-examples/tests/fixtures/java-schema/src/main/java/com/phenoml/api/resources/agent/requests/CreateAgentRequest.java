/**
 * Synthetic request-class fixture covering the cases the schema extractor
 * has to handle: required + optional fields, Optional<> wrapping, a list
 * field, an enum reference, and a @JsonIgnore'd header field.
 */
package com.phenoml.api.resources.agent.requests;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.phenoml.api.resources.agent.types.AgentRole;
import java.util.List;
import java.util.Optional;
import org.jetbrains.annotations.NotNull;

@JsonInclude(JsonInclude.Include.NON_ABSENT)
public final class CreateAgentRequest {
    private final Optional<String> phenomlOnBehalfOf;

    private final String name;

    private final AgentRole role;

    private final Optional<List<String>> tools;

    private final Optional<String> description;

    private CreateAgentRequest(
            Optional<String> phenomlOnBehalfOf,
            String name,
            AgentRole role,
            Optional<List<String>> tools,
            Optional<String> description) {
        this.phenomlOnBehalfOf = phenomlOnBehalfOf;
        this.name = name;
        this.role = role;
        this.tools = tools;
        this.description = description;
    }

    @JsonIgnore
    public Optional<String> getPhenomlOnBehalfOf() {
        return phenomlOnBehalfOf;
    }

    @JsonProperty("name")
    public String getName() {
        return name;
    }

    @JsonProperty("role")
    public AgentRole getRole() {
        return role;
    }

    @JsonProperty("tools")
    public Optional<List<String>> getTools() {
        return tools;
    }

    @JsonProperty("description")
    public Optional<String> getDescription() {
        return description;
    }

    public static NameStage builder() {
        return new Builder();
    }

    public interface NameStage {
        RoleStage name(@NotNull String name);
    }

    public interface RoleStage {
        _FinalStage role(@NotNull AgentRole role);
    }

    public interface _FinalStage {
        CreateAgentRequest build();
        _FinalStage tools(Optional<List<String>> tools);
        _FinalStage tools(List<String> tools);
        _FinalStage description(Optional<String> description);
        _FinalStage description(String description);
        _FinalStage phenomlOnBehalfOf(Optional<String> phenomlOnBehalfOf);
        _FinalStage phenomlOnBehalfOf(String phenomlOnBehalfOf);
    }

    public static final class Builder implements NameStage, RoleStage, _FinalStage {
        private String name;
        private AgentRole role;
        private Optional<List<String>> tools = Optional.empty();
        private Optional<String> description = Optional.empty();
        private Optional<String> phenomlOnBehalfOf = Optional.empty();

        private Builder() {}

        public RoleStage name(@NotNull String name) { this.name = name; return this; }
        public _FinalStage role(@NotNull AgentRole role) { this.role = role; return this; }
        public _FinalStage tools(List<String> tools) { this.tools = Optional.ofNullable(tools); return this; }
        public _FinalStage tools(Optional<List<String>> tools) { this.tools = tools; return this; }
        public _FinalStage description(String description) { this.description = Optional.ofNullable(description); return this; }
        public _FinalStage description(Optional<String> description) { this.description = description; return this; }
        public _FinalStage phenomlOnBehalfOf(String value) { this.phenomlOnBehalfOf = Optional.ofNullable(value); return this; }
        public _FinalStage phenomlOnBehalfOf(Optional<String> value) { this.phenomlOnBehalfOf = value; return this; }

        public CreateAgentRequest build() {
            return new CreateAgentRequest(phenomlOnBehalfOf, name, role, tools, description);
        }
    }
}
