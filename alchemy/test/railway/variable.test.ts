import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { RailwayApi } from "../../src/railway/api.ts";
import { Project } from "../../src/railway/project.ts";
import { Service } from "../../src/railway/service.ts";
import { Variable } from "../../src/railway/variable.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const skipIfNoToken = !process.env.RAILWAY_API_TOKEN;

describe.skipIf(skipIfNoToken)("Railway Variable", () => {
  const testId = `${BRANCH_PREFIX}-railway-var`;

  test("create, update, and delete variables", async (scope) => {
    let project: Project | undefined;
    try {
      project = await Project(`${testId}-proj`, {
        name: `${testId}-proj`,
      });

      const service = await Service(`${testId}-svc`, {
        project,
        name: `${testId}-svc`,
      });

      // Create
      let vars = await Variable(testId, {
        project,
        environment: project.defaultEnvironmentId,
        service,
        variables: {
          NODE_ENV: "production",
          PORT: "3000",
        },
      });

      expect(vars.keys).toContain("NODE_ENV");
      expect(vars.keys).toContain("PORT");
      expect(vars.projectId).toEqual(project.projectId);
      expect(vars.environmentId).toEqual(project.defaultEnvironmentId);

      // Update — add a var, remove PORT
      vars = await Variable(testId, {
        project,
        environment: project.defaultEnvironmentId,
        service,
        variables: {
          NODE_ENV: "production",
          APP_NAME: "test-app",
        },
      });

      expect(vars.keys).toContain("NODE_ENV");
      expect(vars.keys).toContain("APP_NAME");
      expect(vars.keys).not.toContain("PORT");
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
