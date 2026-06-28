export interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return isRecord(value);
}

export function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

export function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value) && !Array.isArray(value);
		default:
			return false;
	}
}

/**
 * Union coercion order: numeric types are attempted before boolean so a numeric
 * string ("1"/"0") coerces to a number, not the boolean "1"->true / "0"->false
 * form (preserves e.g. ["boolean","number"] + "1" -> 1). Single-type schemas are
 * unaffected — the boolean "1"/"0" coercion only kicks in when boolean is the
 * sole type.
 */
function coercionTypeRank(type: string): number {
	return type === "number" || type === "integer" ? 0 : 1;
}

export function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			if (value === null) {
				return false;
			}
			if (typeof value === "string") {
				if (value === "true" || value === "1") {
					return true;
				}
				if (value === "false" || value === "0") {
					return false;
				}
			}
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			if (value === null) {
				return "";
			}
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			return value;
	}
}

function isPrimitive(value: unknown): boolean {
	return value === null || typeof value !== "object";
}

type SubSchemaValidator = (schema: JsonSchemaObject) => { Check(value: unknown): boolean } | undefined;

function applySchemaObjectCoercion(
	value: Record<string, unknown>,
	schema: JsonSchemaObject,
	getSubSchemaValidator: SubSchemaValidator,
): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema, getSubSchemaValidator);
		}
	}

	if (schema.additionalProperties && isJsonSchemaObject(schema.additionalProperties)) {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties, getSubSchemaValidator);
		}
	}
}

function applySchemaArrayCoercion(
	value: unknown[],
	schema: JsonSchemaObject,
	getSubSchemaValidator: SubSchemaValidator,
): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema, getSubSchemaValidator);
		}
		return;
	}

	if (isJsonSchemaObject(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items, getSubSchemaValidator);
		}
	}
}

function coerceWithUnionSchema(
	value: unknown,
	schemas: JsonSchemaObject[],
	getSubSchemaValidator: SubSchemaValidator,
): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) {
			return value;
		}
	}
	const cloneSource = isPrimitive(value) ? null : value;
	for (const schema of schemas) {
		const candidate = cloneSource === null ? value : structuredClone(cloneSource);
		const coerced = coerceWithJsonSchema(candidate, schema, getSubSchemaValidator);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

export function coerceWithJsonSchema(
	value: unknown,
	schema: JsonSchemaObject,
	getSubSchemaValidator: SubSchemaValidator,
): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested, getSubSchemaValidator);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf, getSubSchemaValidator);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf, getSubSchemaValidator);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		const ordered =
			schemaTypes.length > 1
				? [...schemaTypes].sort((a, b) => coercionTypeRank(a) - coercionTypeRank(b))
				: schemaTypes;
		for (const schemaType of ordered) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (schemaTypes.includes("object") && isRecord(nextValue) && !Array.isArray(nextValue)) {
		applySchemaObjectCoercion(nextValue, schema, getSubSchemaValidator);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema, getSubSchemaValidator);
	}

	return nextValue;
}

/**
 * True when `schema` (directly, or through a union/intersection branch, or by
 * shape) admits a value of JSON `kind`. Used by stripNullishOptionalArgs so a
 * field that legitimately accepts `null` or `{}` is never mistaken for a
 * misplaced placeholder.
 */
export function schemaAllowsKind(schema: JsonSchemaObject, kind: "null" | "object"): boolean {
	if (getSchemaTypes(schema).includes(kind)) return true;
	if (kind === "object" && (schema.properties !== undefined || schema.additionalProperties !== undefined)) {
		return true;
	}
	if (kind === "null" && (schema as { nullable?: boolean }).nullable === true) return true;
	for (const branch of [schema.anyOf, schema.oneOf, schema.allOf]) {
		if (Array.isArray(branch) && branch.some((s) => isJsonSchemaObject(s) && schemaAllowsKind(s, kind))) {
			return true;
		}
	}
	return false;
}

export function isEmptyPlainObject(value: unknown): boolean {
	return isRecord(value) && !Array.isArray(value) && Object.keys(value).length === 0;
}
