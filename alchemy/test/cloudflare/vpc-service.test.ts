import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import {
  type CloudflareApi,
  createCloudflareApi,
} from "../../src/cloudflare/api.ts";
import { Tunnel } from "../../src/cloudflare/tunnel.ts";
import {
  VpcService,
  getService,
  listServices,
} from "../../src/cloudflare/vpc-service.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";
import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("VpcService Resource", () => {
  const testId = `${BRANCH_PREFIX}-vpc-svc`;

  test("create, update, and delete vpc service", async (scope) => {
    const api = await createCloudflareApi();
    let tunnel: Tunnel | undefined;
    let vpcService: VpcService | undefined;

    try {
      // Create a minimal tunnel for the VPC service
      tunnel = await Tunnel(`${testId}-tunnel`, {
        name: `${testId}-tunnel`,
        ingress: [{ service: "http://localhost:8080" }],
        adopt: true,
      });

      // Create VPC service with hostname host
      vpcService = await VpcService(testId, {
        name: `${testId}-initial`,
        httpPort: 8080,
        host: {
          hostname: "localhost",
          resolverNetwork: {
            tunnel,
          },
        },
        adopt: true,
      });

      // Verify VPC service was created
      expect(vpcService).toMatchObject({
        name: `${testId}-initial`,
        serviceId: expect.any(String),
        serviceType: "http",
        httpPort: 8080,
        host: {
          hostname: "localhost",
          resolverNetwork: {
            tunnelId: tunnel.tunnelId,
          },
        },
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        type: "vpc_service",
      });

      // Verify service exists via API
      const fetchedService = await getService(api, vpcService.serviceId);
      expect(fetchedService).toMatchObject({
        name: `${testId}-initial`,
        service_id: vpcService.serviceId,
        type: "http",
        http_port: 8080,
      });

      // Update the VPC service with new port
      vpcService = await VpcService(testId, {
        name: `${testId}-updated`,
        httpPort: 3000,
        httpsPort: 3001,
        host: {
          hostname: "localhost",
          resolverNetwork: {
            tunnel,
          },
        },
      });

      // Verify VPC service was updated
      expect(vpcService).toMatchObject({
        name: `${testId}-updated`,
        serviceId: expect.any(String),
        httpPort: 3000,
        httpsPort: 3001,
      });

      // Verify update via API
      const updatedService = await getService(api, vpcService.serviceId);
      expect(updatedService).toMatchObject({
        name: `${testId}-updated`,
        http_port: 3000,
        https_port: 3001,
      });
    } catch (err) {
      console.error("Test error:", err);
      throw err;
    } finally {
      await destroy(scope);
      await assertVpcServiceDeleted(api, vpcService?.serviceId);
    }
  });
});

async function assertVpcServiceDeleted(api: CloudflareApi, serviceId?: string) {
  if (serviceId) {
    const services = await listServices(api);
    expect(services.find((s) => s.service_id === serviceId)).toBeUndefined();
  }
}
