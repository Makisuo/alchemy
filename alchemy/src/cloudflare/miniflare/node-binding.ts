import * as mf from "miniflare";
import { Scope } from "../../scope.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "../api.ts";
import type { Binding } from "../bindings.ts";
import type { Bound } from "../bound.ts";
import { buildBindings } from "./build-worker-options.ts";
import { getDefaultPersistPath } from "./paths.ts";

type AllKeysOf<T, K extends readonly (keyof T)[]> =
  Exclude<keyof T, K[number]> extends never ? K : never;

export function makeAsyncProxyForBinding<
  B extends Extract<Binding, object>,
  const K extends readonly (keyof Lazy<Bound<B>>)[],
>(input: {
  apiOptions: CloudflareApiOptions;
  name: string;
  binding: Omit<B, keyof Lazy<Bound<B>>>;
  properties: AllKeysOf<Lazy<Bound<B>>, K>;
}): B {
  return makeAsyncProxy(
    async () => {
      const { options, remoteProxy } = await buildBindings({
        api: makeAsyncProxy(() =>
          createCloudflareApi(input.apiOptions),
        ) as CloudflareApi,
        name: input.name,
        bindings: {
          binding: input.binding as B,
        },
        eventSources: undefined,
        assets: undefined,
        port: 0,
        cwd: Scope.current.rootDir,
      });
      const miniflare = new mf.Miniflare({
        script: "",
        modules: true,
        defaultPersistRoot: getDefaultPersistPath(Scope.current.rootDir),
        log: process.env.DEBUG ? new mf.Log(mf.LogLevel.DEBUG) : undefined,
        ...options,
        analyticsEngineDatasetsPersist: !!options.analyticsEngineDatasets,
        d1Persist: !!options.d1Databases,
        durableObjectsPersist: !!options.durableObjects,
        kvPersist: !!options.kvNamespaces,
        r2Persist: !!options.r2Buckets,
        secretsStorePersist: !!options.secretsStoreSecrets,
        workflowsPersist: !!options.workflows,
      } as mf.MiniflareOptions);
      Scope.current.onCleanup(async () => {
        await remoteProxy?.close();
        await miniflare.dispose();
      });
      await miniflare.ready;
      return (await miniflare.getBindings())["binding"] as Bound<B>;
    },
    input.binding,
    input.properties,
  ) as B;
}

export type Lazy<T> = T[keyof T] extends (...args: any[]) => Promise<any>
  ? T
  : {
      [k in keyof T]: EnsurePromiseReturnType<T[k]>;
    };

type EnsurePromiseReturnType<T> = T extends (
  ...args: infer Args
) => infer Return
  ? (...args: Args) => Return extends Promise<any> ? Return : Promise<Return>
  : never;

function makeAsyncProxy<Target extends object, Functions>(
  make: () => Promise<Functions>,
  target?: Target,
  properties?: readonly (keyof Functions)[],
): Target & Lazy<Functions> {
  let promise: Promise<Functions> | undefined;
  return new Proxy(target ?? {}, {
    get(target, prop) {
      if (properties?.includes(prop as keyof Functions)) {
        return Reflect.get(target, prop);
      }
      return async (...args: any[]) => {
        promise ??= make();
        const obj = await promise;
        // @ts-expect-error - prop is a valid key of T
        return obj[prop as keyof T].apply(obj, args);
      };
    },
    has(target, prop) {
      return (
        properties?.includes(prop as keyof Functions) ||
        Reflect.has(target, prop)
      );
    },
  }) as Target & Lazy<Functions>;
}
