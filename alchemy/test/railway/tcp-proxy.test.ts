import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { RailwayApi } from "../../src/railway/api.ts";
import { Project } from "../../src/railway/project.ts";
import { Service } from "../../src/railway/service.ts";
import { TCPProxy } from "../../src/railway/tcp-proxy.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const skipIfNoToken = !process.env.RAILWAY_API_TOKEN;

describe.skipIf(skipIfNoToken)("Railway TCPProxy", () => {
  const testId = `${BRANCH_PREFIX}-railway-tcp`;

  test("create and delete tcp proxy", async (scope) => {
    let project: Project | undefined;
    try {
      project = await Project(`${testId}-proj`, {
        name: `${testId}-proj`,
      });

      const service = await Service(`${testId}-svc`, {
        project,
        name: `${testId}-svc`,
        source: { image: "redis:latest" },
      });

      const proxy = await TCPProxy(testId, {
        service,
        environment: project.defaultEnvironmentId,
        applicationPort: 6379,
      });

      expect(proxy.proxyId).toBeTruthy();
      expect(proxy.domain).toBeTruthy();
      expect(proxy.proxyPort).toBeGreaterThan(0);
      expect(proxy.applicationPort).toEqual(6379);
      expect(proxy.serviceId).toEqual(service.serviceId);
      expect(proxy.environmentId).toEqual(project.defaultEnvironmentId);
    } finally {
      await destroy(scope);

      if (project?.projectId) {
        const api = new RailwayApi();
        try {
          await api.query(
            `mutation projectDelete($id: String!) {
              projectDelete(id: $id)
            }`,
            { id: project.projectId },
          );
        } catch {
          // OK if already deleted
        }
      }
    }
  });
});
