import { alchemy } from "../alchemy";
import type { Context } from "../context";
import { Resource } from "../resource";
import { createPlanetScaleClient, type PlanetScaleProps } from "./api";
import type { PostgresRole } from "./api/types.gen";
import type { Branch } from "./branch";
import type { Database } from "./database";
import type { Role } from "./role";

export interface DefaultRoleProps extends PlanetScaleProps {
  /**
   * The organization where the role will be created
   * Required when using string database name, optional when using Database resource
   * @default process.env.PLANETSCALE_ORGANIZATION
   */
  organization?: string;

  /**
   * The database where the role will be created
   * Can be either a database name (string) or Database resource
   */
  database: string | Database;

  /**
   * The branch where the role will be created
   * Can be either a branch name (string) or Branch resource
   * @default "main"
   */
  branch?: string | Branch;
}

export type DefaultRole = Omit<Role, "successor">;

export const DefaultRole = Resource(
  "planetscale::DefaultRole",
  async function (
    this: Context<DefaultRole, DefaultRoleProps>,
    id: string,
    props: DefaultRoleProps,
  ): Promise<DefaultRole> {
    const api = createPlanetScaleClient(props);
    const organization =
      props.organization ??
      (typeof props.database !== "string"
        ? props.database.organization
        : (process.env.PLANETSCALE_ORGANIZATION ??
          process.env.PLANETSCALE_ORG_ID));
    if (!organization) {
      throw new Error(
        "PlanetScale organization is required. Please set the `organization` property or the `PLANETSCALE_ORGANIZATION` environment variable.",
      );
    }

    const database =
      typeof props.database === "string" ? props.database : props.database.name;
    const branch =
      typeof props.branch === "string"
        ? props.branch
        : (props.branch?.name ?? "main");

    if (this.phase === "delete") {
      return this.destroy();
    }

    const { data } = await api.getDefaultRole({
      path: {
        organization,
        database,
        branch,
      },
    });
    return formatPostgresRole(data);

    function formatPostgresRole(role: PostgresRole) {
      return {
        id: role.id,
        name: role.name,
        expiresAt: role.expires_at,
        host: role.access_host_url,
        username: role.username,
        ttl: role.ttl,
        password: alchemy.secret(role.password),
        databaseName: role.database_name,
        connectionUrl: alchemy.secret(
          `postgresql://${role.username}:${role.password}@${role.access_host_url}:5432/${role.database_name}?sslmode=verify-full`,
        ),
        connectionUrlPooled: alchemy.secret(
          `postgresql://${role.username}:${role.password}@${role.access_host_url}:6432/${role.database_name}?sslmode=verify-full`,
        ),
        inheritedRoles: role.inherited_roles,
        database,
        branch,
        organization,
      };
    }
  },
);
