import * as mf from "miniflare";
import assert from "node:assert";
import { Scope } from "../scope.ts";
import { createCloudflareApi, type CloudflareApiOptions } from "./api.ts";
import type { Binding } from "./bindings.ts";
import type { Bound } from "./bound.ts";
import { buildBindings } from "./miniflare/build-worker-options.ts";
import { getDefaultPersistPath } from "./miniflare/paths.ts";

type Interceptors<T> = {
  [K in NonAsyncFunctionKeys<T>]: (promise: Promise<T>) => T[K];
};
type NonAsyncFunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => Promise<any> ? never : K;
}[keyof T];

export function createBindingAsyncProxy<B extends Extract<Binding, object>>(
  id: string,
  apiOptions: CloudflareApiOptions,
  binding: Omit<B, keyof Bound<B>>,
  interceptors: Interceptors<Bound<B>>,
): B;

export function createBindingAsyncProxy<B extends Extract<Binding, object>>(
  id: string,
  apiOptions: CloudflareApiOptions,
  binding: Omit<B, keyof Bound<B>>,
  interceptors?: undefined,
): Interceptors<Bound<B>> extends Record<string, never>
  ? B
  : "Binding includes non-async function values that require interceptors";

export function createBindingAsyncProxy<B extends Extract<Binding, object>>(
  id: string,
  apiOptions: CloudflareApiOptions,
  binding: Omit<B, keyof Bound<B>>,
  interceptors?: Interceptors<Bound<B>>,
): B {
  return createAsyncProxy(
    binding,
    async () => {
      const { options, remoteProxy } = await buildBindings({
        api: createAsyncProxy({}, () => createCloudflareApi(apiOptions)),
        name: `binding-${id}`,
        bindings: {
          binding: binding as B,
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
      // use defer instead of onCleanup to avoid keeping process open on deploy
      Scope.current.defer(async () => {
        await remoteProxy?.close();
        await miniflare.dispose();
      });
      await miniflare.ready;
      return (await miniflare.getBindings())["binding"] as Bound<B>;
    },
    interceptors,
  );
}

export function createAsyncProxy<T extends object, U extends object>(
  target: T,
  asyncValue: Promise<U> | (() => Promise<U>),
  interceptors?: Interceptors<U>,
): T & U {
  let promise = typeof asyncValue === "function" ? undefined : asyncValue;
  const get = () =>
    (promise ??= typeof asyncValue === "function" ? asyncValue() : asyncValue);
  return new Proxy(target, {
    get(target, prop) {
      if (
        Reflect.has(target, prop) ||
        prop === "then" ||
        prop === "catch" ||
        prop === "finally"
      ) {
        return Reflect.get(target, prop);
      }

      const intercept = interceptors?.[prop as keyof Interceptors<U>];
      if (typeof intercept === "function") {
        return intercept(get());
      }

      return async (...args: any[]) => {
        const value = await get();
        const fn = value[prop as keyof U];
        assert(
          typeof fn === "function",
          `Property ${String(prop)} is not a function`,
        );
        return fn.apply(value, args);
      };
    },
    has(target, prop) {
      return Reflect.has(target, prop) || Reflect.has(interceptors ?? {}, prop);
    },
  }) as T & U;
}
