import * as mf from "miniflare";
import { Scope } from "../../scope.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "../api.ts";
import type { Binding, Bindings } from "../bindings.ts";
import type { Bound } from "../bound.ts";
import { buildBindings } from "./build-worker-options.ts";
import { getDefaultPersistPath } from "./paths.ts";

async function makeMiniflare(
  api: CloudflareApi,
  name: string,
  bindings: Bindings,
) {
  const { options, remoteProxy } = await buildBindings({
    api,
    name,
    bindings,
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
  await miniflare.ready;
  return {
    miniflare,
    dispose: async () => {
      await Promise.all([miniflare.dispose(), remoteProxy?.close()]);
    },
  };
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
  target: Target,
  make: () => Promise<Functions>,
  properties: (keyof Functions)[],
): Target & Lazy<Functions> {
  let promise: Promise<Functions> | undefined;
  return new Proxy(target, {
    get(target, prop) {
      if (!properties.includes(prop as keyof Functions)) {
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
        properties.includes(prop as keyof Functions) ||
        Reflect.has(target, prop)
      );
    },
  }) as Target & Lazy<Functions>;
}

export function makeAsyncProxyForBinding<
  B extends Extract<Binding, object>,
>(options: {
  apiOptions: CloudflareApiOptions;
  name: string;
  binding: Omit<B, keyof Lazy<Bound<B>>>;
  properties: (keyof NoInfer<Bound<B>>)[];
}): B {
  const api = makeAsyncProxy(
    {},
    async () => await createCloudflareApi(options.apiOptions),
    ["get", "post", "put", "delete", "patch", "head"],
  ) as CloudflareApi;
  return makeAsyncProxy(
    options.binding,
    async () => {
      const { miniflare, dispose } = await makeMiniflare(api, options.name, {
        binding: options.binding as B,
      });
      Scope.current.onCleanup(async () => {
        await dispose();
      });
      return (await miniflare.getBindings())["binding"] as Bound<B>;
    },
    options.properties,
  ) as B;
}
