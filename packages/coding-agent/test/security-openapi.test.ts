import { describe, expect, it } from "vitest";
import { buildOpenApiInventory } from "../src/core/security/openapi-inventory.js";

describe("native OpenAPI surface inventory", () => {
	it("builds deterministic OpenAPI 3 endpoint and request templates", async () => {
		const document = `
openapi: 3.0.3
info: { title: Example, version: 1.0.0 }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
paths:
  /users/{id}:
    get:
      operationId: getUser
      security: [{ bearerAuth: [] }]
      parameters:
        - { in: path, name: id, required: true, schema: { type: string } }
        - { in: query, name: verbose, schema: { type: boolean } }
      responses:
        '200': { description: ok }
`;
		const first = await buildOpenApiInventory(document);
		const second = await buildOpenApiInventory(document);

		expect(first).toEqual(second);
		expect(first.version).toBe("3.0.3");
		expect(first.endpoints).toEqual([
			expect.objectContaining({
				method: "GET",
				path: "/users/{id}",
				operationId: "getUser",
				security: ["bearerAuth"],
				request: expect.objectContaining({ pathParameters: { id: "{{id}}" }, query: { verbose: "{{verbose}}" } }),
			}),
		]);
	});

	it("supports Swagger 2 request inventories", async () => {
		const document = JSON.stringify({
			swagger: "2.0",
			info: { title: "Legacy", version: "1" },
			basePath: "/v1",
			consumes: ["application/x-www-form-urlencoded"],
			paths: {
				"/login": {
					post: {
						operationId: "login",
						parameters: [{ in: "formData", name: "username", required: true, type: "string" }],
						responses: { 200: { description: "ok" } },
					},
				},
			},
		});
		const inventory = await buildOpenApiInventory(document);
		expect(inventory.version).toBe("2.0");
		expect(inventory.endpoints[0]).toMatchObject({
			method: "POST",
			path: "/v1/login",
			contentTypes: ["application/x-www-form-urlencoded"],
			request: { body: { username: "{{username}}" } },
		});
	});
});
