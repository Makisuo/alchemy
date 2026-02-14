import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { RailwayApi } from "../../src/railway/api.ts";
import { Project } from "../../src/railway/project.ts";
import { Service } from "../../src/railway/service.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const skipIfNoToken = !process.env.RAILWAY_API_TOKEN;

describe.skipIf(skipIfNoToken)("Railway Service", () => {
  const testId = `${BRANCH_PREFIX}-railway-service`;

  test("create, update, and delete service", async (scope) => {
    let project: Project | undefined;
    try {
      project = await Project(`${testId}-proj`, {
        name: `${testId}-proj`,
      });

      let service = await Service(testId, {
        project,
        name: `${testId}-svc`,
        startCommand: "node index.js",
      });

      expect(service.serviceId).toBeTruthy();
      expect(service.name).toEqual(`${testId}-svc`);
      expect(service.projectId).toEqual(project.projectId);
      expect(service.environmentId).toBeTruthy();
      expect(service.startCommand).toEqual("node index.js");

      // Update
      service = await Service(testId, {
        project,
        name: `${testId}-svc-updated`,
        startCommand: "npm start",
        buildCommand: "npm run build",
      });

      expect(service.name).toEqual(`${testId}-svc-updated`);
      expect(service.startCommand).toEqual("npm start");
      expect(service.buildCommand).toEqual("npm run build");
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
