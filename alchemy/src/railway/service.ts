import type { Context } from "../context.ts";
import { Resource, ResourceKind } from "../resource.ts";
import { RailwayApi, type RailwayApiOptions } from "./api.ts";
import type { Environment } from "./environment.ts";
import type { Project } from "./project.ts";

/**
 * Source configuration for a Railway service
 */
export interface ServiceSource {
  /**
   * GitHub repository URL (e.g. "owner/repo")
   */
  repo?: string;

  /**
   * Docker image to deploy
   */
  image?: string;
}

/**
 * Properties for creating or updating a Railway Service
 */
export interface ServiceProps extends RailwayApiOptions {
  /**
   * The project this service belongs to
   */
  project: string | Project;

  /**
   * Name of the service
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;

  /**
   * Source configuration (repo or image)
   */
  source?: ServiceSource;

  /**
   * Build command for the service
   */
  buildCommand?: string;

  /**
   * Start command for the service
   */
  startCommand?: string;

  /**
   * Healthcheck path
   */
  healthcheckPath?: string;

  /**
   * Number of replicas
   */
  numReplicas?: number;

  /**
   * Cron schedule expression
   */
  cronSchedule?: string;

  /**
   * Region for the service instance
   */
  region?: string;

  /**
   * The environment to configure the service instance in.
   * If not provided, uses the project's default production environment.
   */
  environment?: string | Environment;

  /**
   * Whether to adopt an existing service if one with the same name is found
   * @default false
   */
  adopt?: boolean;
}

/**
 * Output type for a Railway Service
 */
export type Service = Omit<
  ServiceProps,
  "adopt" | "project" | "environment" | "source"
> & {
  /**
   * The Railway service ID
   */
  serviceId: string;

  /**
   * The project ID this service belongs to
   */
  projectId: string;

  /**
   * The environment ID used for instance config
   */
  environmentId: string;

  /**
   * Name of the service
   */
  name: string;

  /**
   * Time the service was created
   */
  createdAt: string;

  /**
   * Time the service was last updated
   */
  updatedAt: string;
};

/**
 * Type guard for Railway Service
 */
export function isService(resource: any): resource is Service {
  return resource?.[ResourceKind] === "railway::Service";
}

/**
 * Creates and manages a Railway service within a project.
 *
 * @example
 * ## Create a service from a Docker image
 *
 * Deploy a service using a Docker image.
 *
 * ```ts
 * const project = await Project("my-project", { name: "My App" });
 * const service = await Service("api", {
 *   project,
 *   name: "api-service",
 *   source: { image: "nginx:latest" },
 * });
 * ```
 *
 * @example
 * ## Create a service with build and start commands
 *
 * Configure a service with custom commands.
 *
 * ```ts
 * const service = await Service("web", {
 *   project: "project-id",
 *   name: "web-app",
 *   source: { repo: "myorg/myrepo" },
 *   buildCommand: "npm run build",
 *   startCommand: "npm start",
 *   healthcheckPath: "/health",
 *   numReplicas: 2,
 * });
 * ```
 */
export const Service = Resource(
  "railway::Service",
  async function (
    this: Context<Service>,
    id: string,
    props: ServiceProps,
  ): Promise<Service> {
    const api = new RailwayApi(props);
    const projectId =
      typeof props.project === "string"
        ? props.project
        : props.project.projectId;
    const name =
      props.name ?? this.output?.name ?? this.scope.createPhysicalName(id);

    // Resolve environment ID
    let environmentId: string;
    if (props.environment) {
      environmentId =
        typeof props.environment === "string"
          ? props.environment
          : props.environment.environmentId;
    } else if (this.output?.environmentId) {
      environmentId = this.output.environmentId;
    } else {
      // Get the default production environment
      environmentId = await getDefaultEnvironmentId(api, projectId);
    }

    if (this.phase === "delete") {
      if (this.output?.serviceId) {
        try {
          await api.query(
            `mutation serviceDelete($id: String!) {
              serviceDelete(id: $id)
            }`,
            { id: this.output.serviceId },
          );
        } catch (error: any) {
          if (!error.message?.includes("not found")) {
            throw error;
          }
        }
      }
      return this.destroy();
    }

    const serviceId = this.output?.serviceId;

    if (serviceId && this.output) {
      // Update service name
      await api.query(
        `mutation serviceUpdate($id: String!, $input: ServiceUpdateInput!) {
          serviceUpdate(id: $id, input: $input) {
            id
          }
        }`,
        {
          id: serviceId,
          input: { name },
        },
      );

      // Update service instance config
      await updateServiceInstance(api, serviceId, environmentId, props);

      return {
        serviceId: this.output.serviceId,
        projectId: this.output.projectId,
        environmentId: this.output.environmentId,
        createdAt: this.output.createdAt,
        updatedAt: this.output.updatedAt,
        name,
        buildCommand: props.buildCommand,
        startCommand: props.startCommand,
        healthcheckPath: props.healthcheckPath,
        numReplicas: props.numReplicas,
        cronSchedule: props.cronSchedule,
        region: props.region,
      };
    }

    // Create
    const adopt = props.adopt ?? this.scope.adopt;
    if (adopt) {
      const existing = await findServiceByName(api, projectId, name);
      if (existing) {
        // Update instance config on adopt
        await updateServiceInstance(
          api,
          existing.serviceId,
          environmentId,
          props,
        );
        return {
          ...existing,
          environmentId,
          buildCommand: props.buildCommand,
          startCommand: props.startCommand,
          healthcheckPath: props.healthcheckPath,
          numReplicas: props.numReplicas,
          cronSchedule: props.cronSchedule,
          region: props.region,
        };
      }
    }

    const input: Record<string, any> = {
      name,
      projectId,
    };

    if (props.source?.repo) {
      input.source = { repo: props.source.repo };
    } else if (props.source?.image) {
      input.source = { image: props.source.image };
    }

    const data = await api.query<{
      serviceCreate: {
        id: string;
        name: string;
        createdAt: string;
        updatedAt: string;
      };
    }>(
      `mutation serviceCreate($input: ServiceCreateInput!) {
        serviceCreate(input: $input) {
          id
          name
          createdAt
          updatedAt
        }
      }`,
      { input },
    );

    const service = data.serviceCreate;

    // Configure service instance
    await updateServiceInstance(api, service.id, environmentId, props);

    return {
      serviceId: service.id,
      projectId,
      environmentId,
      name: service.name,
      buildCommand: props.buildCommand,
      startCommand: props.startCommand,
      healthcheckPath: props.healthcheckPath,
      numReplicas: props.numReplicas,
      cronSchedule: props.cronSchedule,
      region: props.region,
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
    };
  },
);

async function updateServiceInstance(
  api: RailwayApi,
  serviceId: string,
  environmentId: string,
  props: ServiceProps,
): Promise<void> {
  const input: Record<string, any> = {};
  if (props.buildCommand !== undefined) input.buildCommand = props.buildCommand;
  if (props.startCommand !== undefined) input.startCommand = props.startCommand;
  if (props.healthcheckPath !== undefined)
    input.healthcheckPath = props.healthcheckPath;
  if (props.numReplicas !== undefined) input.numReplicas = props.numReplicas;
  if (props.cronSchedule !== undefined) input.cronSchedule = props.cronSchedule;
  if (props.region !== undefined) input.region = props.region;

  if (Object.keys(input).length === 0) return;

  await api.query(
    `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
    { serviceId, environmentId, input },
  );
}

async function getDefaultEnvironmentId(
  api: RailwayApi,
  projectId: string,
): Promise<string> {
  const data = await api.query<{
    environments: {
      edges: Array<{ node: { id: string; name: string } }>;
    };
  }>(
    `query environments($projectId: String!) {
      environments(projectId: $projectId) {
        edges {
          node {
            id
            name
          }
        }
      }
    }`,
    { projectId },
  );

  const production = data.environments.edges.find(
    (e) => e.node.name === "production",
  );
  if (production) return production.node.id;

  if (data.environments.edges.length > 0) {
    return data.environments.edges[0].node.id;
  }

  throw new Error(
    `No environments found for project ${projectId}. Create an environment first.`,
  );
}

async function findServiceByName(
  api: RailwayApi,
  projectId: string,
  name: string,
): Promise<
  | Pick<
      Service,
      "serviceId" | "projectId" | "name" | "createdAt" | "updatedAt"
    >
  | undefined
> {
  const data = await api.query<{
    project: {
      services: {
        edges: Array<{
          node: {
            id: string;
            name: string;
            createdAt: string;
            updatedAt: string;
          };
        }>;
      };
    };
  }>(
    `query project($id: String!) {
      project(id: $id) {
        services {
          edges {
            node {
              id
              name
              createdAt
              updatedAt
            }
          }
        }
      }
    }`,
    { id: projectId },
  );

  const match = data.project.services.edges.find((e) => e.node.name === name);
  if (!match) return undefined;

  return {
    serviceId: match.node.id,
    projectId,
    name: match.node.name,
    createdAt: match.node.createdAt,
    updatedAt: match.node.updatedAt,
  };
}
