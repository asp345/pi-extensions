const SCHEMA_FIELDS = new Set([
	"type",
	"format",
	"title",
	"description",
	"nullable",
	"enum",
	"maxItems",
	"minItems",
	"properties",
	"required",
	"minProperties",
	"maxProperties",
	"minLength",
	"maxLength",
	"pattern",
	"example",
	"anyOf",
	"propertyOrdering",
	"default",
	"items",
	"minimum",
	"maximum",
]);

export function toGeminiSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const input = schema as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	const propertyNames = new Set<string>();
	if (input.properties && typeof input.properties === "object") {
		for (const name of Object.keys(input.properties as object)) propertyNames.add(name);
	}
	for (const [key, value] of Object.entries(input)) {
		if (!SCHEMA_FIELDS.has(key)) continue;
		if (key === "type" && typeof value === "string") {
			result[key] = value.toUpperCase();
		} else if (key === "properties" && value && typeof value === "object") {
			const props: Record<string, unknown> = {};
			for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
				props[name] = toGeminiSchema(prop);
			}
			result[key] = props;
		} else if (key === "items" && value && typeof value === "object") {
			result[key] = toGeminiSchema(value);
		} else if (key === "anyOf" && Array.isArray(value)) {
			result[key] = value.map((item) => toGeminiSchema(item));
		} else if (key === "required" && Array.isArray(value)) {
			const validRequired = value.filter((prop) => typeof prop === "string" && propertyNames.has(prop));
			if (validRequired.length > 0) result[key] = validRequired;
		} else {
			result[key] = value;
		}
	}
	if (result.type === "ARRAY" && !result.items) {
		result.items = { type: "STRING" };
	}
	return result;
}
