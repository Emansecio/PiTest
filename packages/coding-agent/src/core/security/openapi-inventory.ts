import { validate } from "@scalar/openapi-parser";

type UnknownRecord = Record<string, unknown>;

export interface OpenApiRequestTemplate {
	pathParameters?: Record<string, string>;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: unknown;
}

export interface OpenApiEndpointInventory {
	method: string;
	path: string;
	operationId?: string;
	security: string[];
	contentTypes: string[];
	request: OpenApiRequestTemplate;
}

export interface OpenApiInventory {
	title: string;
	version: string;
	endpoints: OpenApiEndpointInventory[];
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function record(value: unknown): UnknownRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
	return array(value).filter((entry): entry is string => typeof entry === "string");
}

function securityNames(value: unknown): string[] {
	return [...new Set(array(value).flatMap((entry) => Object.keys(record(entry))))].sort();
}

function sampleForSchema(value: unknown, depth = 0): unknown {
	const schema = record(value);
	if (schema.example !== undefined) return schema.example;
	if (schema.default !== undefined) return schema.default;
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
	if (depth >= 4) return "{{value}}";
	if (schema.type === "array") return [sampleForSchema(schema.items, depth + 1)];
	if (schema.type === "object" || schema.properties) {
		return Object.fromEntries(
			Object.entries(record(schema.properties))
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, child]) => [name, sampleForSchema(child, depth + 1)]),
		);
	}
	if (schema.type === "boolean") return false;
	if (schema.type === "integer" || schema.type === "number") return 0;
	return "{{value}}";
}

function joinBasePath(basePath: string, path: string): string {
	const base = basePath === "/" ? "" : basePath.replace(/\/$/, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}` || "/";
}

export async function buildOpenApiInventory(source: string | UnknownRecord): Promise<OpenApiInventory> {
	const result = await validate(source);
	if (!result.valid) {
		const message = result.errors.map((error) => error.message).join("; ") || "invalid OpenAPI document";
		throw new Error(`OpenAPI parse failed: ${message}`);
	}
	const specification = record(result.specification);
	const info = record(specification.info);
	const version =
		typeof specification.openapi === "string" ? specification.openapi : String(specification.swagger ?? "unknown");
	const swaggerTwo = specification.swagger === "2.0";
	const basePath = swaggerTwo && typeof specification.basePath === "string" ? specification.basePath : "";
	const rootSecurity = specification.security;
	const rootConsumes = strings(specification.consumes);
	const endpoints: OpenApiEndpointInventory[] = [];

	for (const [rawPath, rawPathItem] of Object.entries(record(specification.paths))) {
		const pathItem = record(rawPathItem);
		const sharedParameters = array(pathItem.parameters);
		for (const [method, rawOperation] of Object.entries(pathItem)) {
			if (!HTTP_METHODS.has(method.toLowerCase())) continue;
			const operation = record(rawOperation);
			const parameters = [...sharedParameters, ...array(operation.parameters)].map(record);
			const request: OpenApiRequestTemplate = {};
			const pathParameters: Record<string, string> = {};
			const query: Record<string, string> = {};
			const headers: Record<string, string> = {};
			const formBody: Record<string, string> = {};
			let body: unknown;
			for (const parameter of parameters) {
				if (typeof parameter.name !== "string" || typeof parameter.in !== "string") continue;
				const placeholder = `{{${parameter.name}}}`;
				if (parameter.in === "path") pathParameters[parameter.name] = placeholder;
				else if (parameter.in === "query") query[parameter.name] = placeholder;
				else if (parameter.in === "header") headers[parameter.name] = placeholder;
				else if (parameter.in === "formData") formBody[parameter.name] = placeholder;
				else if (parameter.in === "body") body = sampleForSchema(parameter.schema);
			}
			const requestBody = record(operation.requestBody);
			const content = record(requestBody.content);
			const contentTypes = swaggerTwo ? strings(operation.consumes ?? rootConsumes) : Object.keys(content).sort();
			if (!swaggerTwo && contentTypes.length > 0) body = sampleForSchema(record(content[contentTypes[0]]).schema);
			if (Object.keys(formBody).length > 0) body = formBody;
			if (Object.keys(pathParameters).length > 0) request.pathParameters = pathParameters;
			if (Object.keys(query).length > 0) request.query = query;
			if (Object.keys(headers).length > 0) request.headers = headers;
			if (body !== undefined) request.body = body;
			endpoints.push({
				method: method.toUpperCase(),
				path: joinBasePath(basePath, rawPath),
				...(typeof operation.operationId === "string" ? { operationId: operation.operationId } : {}),
				security: securityNames(operation.security ?? rootSecurity),
				contentTypes,
				request,
			});
		}
	}
	endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
	return {
		title: typeof info.title === "string" ? info.title : "Untitled API",
		version,
		endpoints,
	};
}
