// Synthetic fixture: Fern's forward-compatible enum shape (`public final class`,
// no `builder()`, variants exposed as `public static final` constants).
package com.phenoml.api.resources.agent.types;

public final class JsonPatchOperationOp {
    public static final JsonPatchOperationOp ADD = new JsonPatchOperationOp(Value.ADD, "add");

    public static final JsonPatchOperationOp REMOVE = new JsonPatchOperationOp(Value.REMOVE, "remove");

    public static final JsonPatchOperationOp REPLACE = new JsonPatchOperationOp(Value.REPLACE, "replace");

    private final Value value;

    private final String string;

    JsonPatchOperationOp(Value value, String string) {
        this.value = value;
        this.string = string;
    }

    public static JsonPatchOperationOp valueOf(String value) {
        switch (value) {
            case "add": return ADD;
            case "remove": return REMOVE;
            case "replace": return REPLACE;
            default: return new JsonPatchOperationOp(Value.UNKNOWN, value);
        }
    }

    public enum Value {
        ADD, REMOVE, REPLACE, UNKNOWN
    }
}
