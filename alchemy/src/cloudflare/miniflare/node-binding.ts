import * as mf from "miniflare";
import { Scope } from "../../scope.ts";
import { createCloudflareApi, type CloudflareApiOptions } from "../api.ts";
import type { Binding } from "../bindings.ts";
import type { Bound } from "../bound.ts";
import { buildBindings } from "./build-worker-options.ts";
import { getDefaultPersistPath } from "./paths.ts";

export function makeAsyncProxyForBinding<
  B extends Extract<Binding, object>,
  const P extends Properties<Bound<B>>,
>(input: {
  apiOptions: CloudflareApiOptions;
  name: string;
  binding: Omit<B, keyof Bound<B>>;
  properties: P;
}): B {
  return makeAsyncProxy(
    input.binding,
    async () => {
      const { options, remoteProxy } = await buildBindings({
        api: makeAsyncProxy({}, () => createCloudflareApi(input.apiOptions)),
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
    input.properties as any,
  ) as B;
}

type Properties<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => Promise<any>
    ? true
    : (promise: Promise<T>) => T[K];
};

export function makeAsyncProxy<
  Target extends object,
  Value,
  P extends Properties<Omit<Value, keyof Target>>,
>(
  target: Target,
  get: Promise<Value> | (() => Promise<Value>),
  properties?: P,
): Target & Value {
  let promise = typeof get === "function" ? undefined : get;
  return new Proxy(target, {
    get(target, prop) {
      const property = properties?.[prop as keyof Omit<Value, keyof Target>];
      if (properties && !property) {
        return Reflect.get(target, prop);
      }
      if (typeof property === "function") {
        promise ??= typeof get === "function" ? get() : get;
        return property(promise);
      }
      return async (...args: any[]) => {
        promise ??= typeof get === "function" ? get() : get;
        const obj = await promise;
        // @ts-expect-error - prop is a valid key of Value
        return obj[prop].apply(obj, args);
      };
    },
    has(target, prop) {
      return (
        !!properties?.[prop as keyof Omit<Value, keyof Target>] ||
        Reflect.has(target, prop)
      );
    },
  }) as any;
}
