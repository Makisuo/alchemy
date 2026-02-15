import { describe, expect, vi } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { RailwayApi } from "../../src/railway/api.ts";
import { Domain } from "../../src/railway/domain.ts";
import "../../src/test/vitest.ts";
import { BRANCH_PREFIX } from "../util.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Railway Domain Replace", () => {
  test("replacing a generated domain with a custom domain creates the custom domain", async (scope) => {
    process.env.RAILWAY_API_TOKEN = "test-token";

    const querySpy = vi
      .spyOn(RailwayApi.prototype, "query")
      .mockImplementation(async (query: string) => {
        if (query.includes("serviceDomainCreate")) {
          return {
            serviceDomainCreate: {
              id: "svc-domain-old",
              domain: "api-production-1234.up.railway.app",
            },
          } as never;
        }

        if (query.includes("customDomainCreate")) {
          return {
            customDomainCreate: {
              id: "custom-domain-new",
              domain: "api.example.com",
            },
          } as never;
        }

        if (query.includes("serviceDomainDelete") || query.includes("customDomainDelete")) {
          return {} as never;
        }

        if (query.includes("serviceInstanceUpdate")) {
          return { serviceInstanceUpdate: true } as never;
        }

        throw new Error(`Unexpected Railway API query in test: ${query}`);
      });

    try {
      const domainResourceId = `api-domain-${Date.now()}`;

      const generated = await Domain(domainResourceId, {
        service: "service-id",
        environment: "environment-id",
      });

      expect(generated.domain).toBe("api-production-1234.up.railway.app");

      const custom = await Domain(domainResourceId, {
        service: "service-id",
        environment: "environment-id",
        projectId: "project-id",
        domain: "api.example.com",
      });

      expect(custom.domain).toBe("api.example.com");
      expect(
        querySpy.mock.calls.some(([query]) => query.includes("customDomainCreate")),
      ).toBe(true);
    } finally {
      await scope.finalize();
      vi.restoreAllMocks();
      delete process.env.RAILWAY_API_TOKEN;
    }
  });
});
