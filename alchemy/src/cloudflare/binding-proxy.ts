import * as mf from "miniflare";
import assert from "node:assert";
import { Scope } from "../scope";
import { createCloudflareApi, type CloudflareApiOptions } from "./api";
import type { Binding, WorkerBindingSpec } from "./bindings";
import type { Bound } from "./bound";
import { getDefaultPersistPath } from "./miniflare/paths";
import { createRemoteProxyWorker } from "./miniflare/remote-binding-proxy";

type Interceptors<T> = {
  [K in NonAsyncFunctionKeys<T>]: (promise: Promise<T>) => T[K];
};
type NonAsyncFunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => Promise<any> ? never : K;
}[keyof T];

type MiniflareOptions = Extract<
  mf.MiniflareOptions,
  { script: string; modules?: boolean }
>;

/**
 * @param id - Resource ID
 * @param props - Resource input props
 * @param target - Resource output attributes
 * @param config - Configuration for the proxy
 * @param config.remoteBindingSpec - Remote binding specification
 * @param config.miniflareOptions - Miniflare options
 * @param config.interceptors - A mapping of synchronous methods on the target object to functions that emulate the asynchronous behavior of the method.
 * @returns The proxied binding.
 */
export function createMiniflareBindingProxy<B extends Extract<Binding, object>>(
  id: string,
  props: CloudflareApiOptions & { dev?: { remote?: boolean } },
  target: Omit<B, keyof Bound<B>>,
  config: {
    remoteBindingSpec: WorkerBindingSpec;
    miniflareOptions: (
      maybeRemoteProxyConnectionString:
        | mf.RemoteProxyConnectionString
        | undefined,
    ) => Partial<MiniflareOptions>;
    interceptors?: Interceptors<Bound<B>>;
  },
): B {
  const scope = Scope.current;
  return createAsyncProxy(
    target,
    async () => {
      const proxy =
        scope.local && !props.dev?.remote
          ? undefined
          : await createRemoteProxyWorker({
              name: id,
              api: await createCloudflareApi(props),
              bindings: [config.remoteBindingSpec],
            });
      if (proxy) {
        void scope.defer(() => proxy.server.close());
      }
      const instance = new mf.Miniflare({
        script: "",
        modules: true,
        defaultPersistRoot: getDefaultPersistPath(scope.rootDir),
        log: process.env.DEBUG ? new mf.Log(mf.LogLevel.DEBUG) : undefined,
        ...config.miniflareOptions(proxy?.connectionString),
      });
      void scope.defer(() => instance.dispose());
      return (await instance.getBindings())[
        config.remoteBindingSpec.name
      ] as Bound<B>;
    },
    config.interceptors,
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
