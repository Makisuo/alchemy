import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { logger } from "../util/logger.ts";
import { poll } from "../util/poll.ts";
import { sleep } from "../util/sleep.ts";
import {
  snakeToCamelObjectDeep,
  type SnakeToCamel,
} from "../util/snake-to-camel.ts";
import { AiSearchToken } from "./ai-search-token.ts";
import { CloudflareApiError, isCloudflareApiError } from "./api-error.ts";
import {
  extractCloudflareResult,
  type CloudflareApiErrorPayload,
} from "./api-response.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";
import {
  getBucket,
  isBucket,
  type R2Bucket,
  type R2BucketJurisdiction,
} from "./bucket.ts";
import { deleteIndex } from "./vectorize-index.ts";

interface BaseAiSearchProps extends CloudflareApiOptions {
  /**
   * Name of the AI Search instance
   * @default `${app}-${stage}-${id}`
   * @minLength 1
   * @maxLength 32
   */
  name?: string;

  /**
   * Data source for indexing.
   * Can be an R2Bucket directly, an R2 source config, or a web crawler config.
   */
  source: R2Bucket | AiSearchR2Source | AiSearchWebCrawlerSource;

  /**
   * Text generation model for AI responses
   *
   * @default "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
   */
  aiSearchModel?: AiSearch.Model;

  /**
   * Embedding model for vectorization
   *
   * @default "@cf/baai/bge-m3"
   */
  embeddingModel?: AiSearch.EmbeddingModel;

  /**
   * Enable chunking of source documents
   *
   * @default true
   */
  chunk?: boolean;

  /**
   * Size of each chunk (minimum 64)
   *
   * @default 256
   */
  chunkSize?: number;

  /**
   * Overlap between chunks (0-30)
   *
   * @default 10
   */
  chunkOverlap?: number;

  /**
   * Maximum search results (1-50)
   *
   * @default 10
   */
  maxNumResults?: number;

  /**
   * Minimum match score (0-1)
   *
   * @default 0.4
   */
  scoreThreshold?: number;

  /**
   * Enable result reranking
   *
   * @default false
   */
  reranking?: boolean;

  /**
   * Reranking model
   *
   * @default "@cf/baai/bge-reranker-base"
   */
  rerankingModel?: AiSearch.RerankingModel;

  /**
   * Enable query rewriting for better retrieval
   *
   * @default false
   */
  rewriteQuery?: boolean;

  /**
   * Query rewriting model
   *
   * @default "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
   */
  rewriteModel?: AiSearch.Model;

  /**
   * Enable similarity caching
   *
   * @default false
   */
  cache?: boolean;

  /**
   * Cache similarity threshold
   *
   * @default "close_enough"
   */
  cacheThreshold?:
    | "super_strict_match"
    | "close_enough"
    | "flexible_friend"
    | "anything_goes";

  /**
   * Custom metadata
   */
  metadata?: Record<string, unknown>;

  /**
   * Whether to index the source documents when the AI Search instance is created
   * @default true
   */
  indexOnCreate?: boolean;

  /**
   * Whether to delete the AI Search instance when removed from Alchemy
   * @default true
   */
  delete?: boolean;

  /**
   * Whether to adopt the AI Search instance if it already exists
   * @default false
   */
  adopt?: boolean;
}

export type AiSearchProps = BaseAiSearchProps &
  (
    | {
        token?: AiSearchToken;
      }
    | {
        tokenId: string;
      }
  );

export interface AiSearchR2Source {
  /**
   * Source type
   */
  type: "r2";

  /**
   * R2 bucket - can be bucket name string or R2Bucket resource
   */
  bucket: string | R2Bucket;

  /**
   * Jurisdiction for the R2 bucket
   * @default "default"
   */
  jurisdiction?: R2BucketJurisdiction;

  /**
   * Prefix for included items from the R2 bucket
   */
  prefix?: string;

  /**
   * Path patterns to include in the R2 bucket (up to 10 patterns).
   * Supports wildcards: `*` matches any characters except `/`, `**` matches any characters including `/`.
   */
  includePaths?: string[];

  /**
   * Path patterns to exclude from the R2 bucket (up to 10 patterns).
   * Supports wildcards: `*` matches any characters except `/`, `**` matches any characters including `/`.
   */
  excludePaths?: string[];
}

export interface AiSearchWebCrawlerSource {
  /**
   * Source type
   */
  type: "web-crawler";

  /**
   * Domain to crawl. Must be a domain that is onboarded to your Cloudflare account
   * (added as a zone with active nameservers pointing to Cloudflare).
   *
   * Can be provided as just the domain (e.g., "docs.example.com") or with protocol
   * (e.g., "https://docs.example.com") - the protocol will be stripped automatically.
   *
   * @example "docs.example.com"
   * @example "https://example.com" // Protocol will be stripped
   */
  domain: string;

  /**
   * Path patterns to include in crawling (up to 10 patterns).
   * Supports wildcards: `*` matches any characters except `/`, `**` matches any characters including `/`.
   */
  includePaths?: string[];

  /**
   * Path patterns to exclude from crawling (up to 10 patterns).
   * Supports wildcards: `*` matches any characters except `/`, `**` matches any characters including `/`.
   */
  excludePaths?: string[];

  parseOptions?: {
    include_headers?: Record<string, string>;
    include_images?: boolean;
    specific_sitemaps?: string[];
    use_browser_rendering?: boolean;
  };
  parseType?: "sitemap" | "feed-rss";
  storeOptions?: {
    storage_id: string;
    jurisdiction?: R2BucketJurisdiction;
    storage_type?: "r2";
  };
}

export type AiSearch = SnakeToCamel<AiSearch.ApiResponse> & {
  /**
   * The name of the AI Search instance (this is an alias for the `id` property)
   */
  name: string;
};

export const AiSearch = Resource(
  "cloudflare::AiSearch",
  async function (
    this: Context<AiSearch>,
    id: string,
    props: AiSearchProps,
  ): Promise<AiSearch> {
    const api = await createCloudflareApi(props);
    const adopt = props.adopt ?? this.scope.adopt;

    const validateBucketSource = async (
      bucket: R2Bucket | string,
      jurisdiction: R2BucketJurisdiction = "default",
    ) => {
      let name: string;
      if (typeof bucket === "string") {
        name = bucket;
      } else {
        if (this.scope.local && !bucket.dev?.remote) {
          throw new Error(
            [
              `AI Search "${id}" depends on an R2Bucket that is running locally, but AI Search requires the bucket to be deployed.`,
              "Add `dev: { remote: true }` to the R2Bucket to use it with AI Search.",
            ].join("\n"),
          );
        }
        name = bucket.name;
      }
      try {
        await getBucket(api, name, { jurisdiction });
      } catch (error) {
        throw new Error(
          `Failed to validate R2 bucket "${name}" (${jurisdiction}) for AI search "${id}": ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    };
    const normalizeSource = async (
      source: R2Bucket | AiSearchR2Source | AiSearchWebCrawlerSource,
    ): Promise<
      (AiSearchR2Source & { bucket: string }) | AiSearchWebCrawlerSource
    > => {
      if (isBucket(source)) {
        await validateBucketSource(source, source.jurisdiction);
        return {
          type: "r2",
          bucket: source.name,
          jurisdiction: source.jurisdiction,
        };
      } else if (source.type === "r2" && isBucket(source.bucket)) {
        await validateBucketSource(source.bucket, source.bucket.jurisdiction);
        return {
          ...source,
          type: "r2",
          bucket: source.bucket.name,
          jurisdiction: source.bucket.jurisdiction,
        };
      } else if (source.type === "web-crawler") {
        await validateWebCrawlerSourceDomain(api, source.domain);
        return source;
      } else {
        await validateBucketSource(source.bucket, source.jurisdiction);
        return source as AiSearchR2Source & { bucket: string };
      }
    };
    const validateTokenId = (id: string): void => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      ) {
        throw new Error(
          `Invalid token ID: "${id}"\n` +
            "The token ID must be a valid UUID for an AI Search service token.\n" +
            "See https://developers.cloudflare.com/ai-search/get-started/api/#2-create-a-service-api-token",
        );
      }
    };
    const normalizeTokenId = async (): Promise<string> => {
      if ("tokenId" in props) {
        validateTokenId(props.tokenId);
        return props.tokenId;
      } else if (props.token) {
        validateTokenId(props.token.tokenId);
        return props.token.tokenId;
      } else {
        const token = await AiSearchToken("token", {
          baseUrl: props.baseUrl,
          profile: props.profile,
          apiKey: props.apiKey,
          apiToken: props.apiToken,
          accountId: props.accountId,
          email: props.email,
          adopt: props.adopt,
          delete: props.delete,
        });
        return token.tokenId;
      }
    };

    if (this.phase === "delete") {
      if (props.delete !== false && this.output?.id) {
        await deleteIndex(api, this.output.vectorizeName);
        await deleteAiSearchInstance(api, this.output.id);
      }
      return this.destroy();
    }

    const name = props.name ?? this.scope.createPhysicalName(id, "-", 32);
    if (name.length < 1 || name.length > 32) {
      throw new Error(
        `AI Search instance name must be 1-32 characters, got ${name.length} ("${name}")`,
      );
    }
    const [source, tokenId] = await Promise.all([
      normalizeSource(props.source),
      normalizeTokenId(),
    ]);

    const payload: AiSearch.ApiPayload = {
      id: name,
      source: source.type === "r2" ? source.bucket : source.domain,
      type: source.type,
      ai_search_model: props.aiSearchModel,
      source_params: {
        include_items: source.includePaths,
        exclude_items: source.excludePaths,
        ...(source.type === "r2"
          ? {
              r2_jurisdiction:
                source.jurisdiction !== "default"
                  ? source.jurisdiction
                  : undefined,
              prefix: source.prefix,
            }
          : {
              web_crawler: {
                parse_type: source.parseType,
                parse_options: source.parseOptions,
                store_options: source.storeOptions,
              },
            }),
      },
      embedding_model: props.embeddingModel,
      chunk: props.chunk,
      chunk_size: props.chunkSize,
      chunk_overlap: props.chunkOverlap,
      max_num_results: props.maxNumResults,
      score_threshold: props.scoreThreshold,
      reranking: props.reranking,
      reranking_model: props.rerankingModel,
      rewrite_query: props.rewriteQuery,
      rewrite_model: props.rewriteModel,
      cache: props.cache,
      cache_threshold: props.cacheThreshold,
      metadata: props.metadata,
      token_id: tokenId,
    };

    let instance: AiSearch.ApiResponse;
    if (this.phase === "update" && this.output?.id) {
      const replace =
        "source" in this.output &&
        (payload.type !== this.output.type ||
          payload.source !== this.output.source);
      // the development version of this resource had different properties, so check those to avoid an unnecessary replacement
      const replaceLegacy =
        "sourceType" in this.output &&
        (payload.type !== this.output.sourceType ||
          (payload.type === "r2" &&
            "sourceBucket" in this.output &&
            payload.source !== this.output.sourceBucket) ||
          (payload.type === "web-crawler" &&
            "sourceDomain" in this.output &&
            payload.source !== this.output.sourceDomain));
      if (replace || replaceLegacy) {
        return this.replace(true);
      }
      instance = await updateAiSearchInstance(api, this.output.id, payload);
    } else {
      try {
        instance = await createAiSearchInstance(api, payload);
      } catch (error) {
        const isAlreadyExistsError =
          error instanceof CloudflareApiError &&
          error.status === 400 &&
          (error.errorData as CloudflareApiErrorPayload[]).some(
            (error) => error.code === 7022,
          );
        if (isAlreadyExistsError && adopt) {
          instance = await getAiSearchInstance(api, name);
          instance = await updateAiSearchInstance(api, instance.id, payload);
        } else {
          throw error;
        }
      }
      if (props.indexOnCreate !== false) {
        await runAiSearchJob(api, instance.id, (message) =>
          logger.task(id, {
            prefix: "index",
            prefixColor: "gray",
            resource: id,
            message,
          }),
        );
      }
    }
    return {
      ...snakeToCamelObjectDeep(instance),
      name: instance.id,
    };
  },
);

/**
 * Validate that a domain string is a valid domain format (not a URL).
 * Throws a helpful error if the input looks like a URL.
 */
async function validateWebCrawlerSourceDomain(
  api: CloudflareApi,
  domain: string,
): Promise<void> {
  if (domain.includes("://")) {
    throw new Error(
      `Invalid domain format "${domain}". Provide just the domain (e.g., "docs.example.com"), not a URL. ` +
        `For URL-based crawling, use AiCrawler instead of AiSearch.`,
    );
  }
  if (domain.includes("/")) {
    throw new Error(
      `Invalid domain format "${domain}". Provide just the domain without paths (e.g., "docs.example.com"). ` +
        `Use includePaths to filter specific paths, or use AiCrawler for URL-based crawling.`,
    );
  }

  // The Cloudflare dashboard uses this undocumented endpoint to validate domains.
  // If we don't validate here, the create request fails with a 500 error.
  const response = await api.post(
    `/accounts/${api.accountId}/ai-search/domains`,
    {
      domain,
    },
  );
  // The error message is more like an error code. This mapping is from the Cloudflare dashboard.
  const errorMap = {
    not_a_valid_domain: "Not a valid domain.",
    invalid_domain:
      "Invalid domain. The domain needs to belong to this account.",
    fail_to_find_domain_info: "Failed to find domain information.",
    missing_sitemap: "Sitemap not found. Please check your robots.txt.",
    domain_not_owned_by_user: "The domain needs to belong to this account.",
    forbidden_robots_txt:
      "Failed to fetch robots.txt: The file is inaccessible.",
    forbidden_sitemap:
      "Failed to fetch your sitemap: The file is inaccessible.",
  };
  const json = (await response.json()) as {
    success: boolean;
    errors: Array<{ code: number; message: string }>;
  };
  if (json.success) return;
  throw new Error(
    [
      `Failed to validate domain "${domain}" (${response.status}):`,
      ...json.errors.map(
        (e) =>
          `- [${e.code}] ${
            e.message in errorMap
              ? errorMap[e.message as keyof typeof errorMap]
              : e.message
          }`,
      ),
      "Learn more: https://developers.cloudflare.com/ai-search/configuration/data-source/website/",
    ].join("\n"),
  );
}

export declare namespace AiSearch {
  type Model =
    | "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    | "@cf/meta/llama-3.1-8b-instruct-fast"
    | "@cf/meta/llama-3.1-8b-instruct-fp8"
    | "@cf/meta/llama-4-scout-17b-16e-instruct"
    | "@cf/qwen/qwen3-30b-a3b-fp8"
    | "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"
    | "@cf/moonshotai/kimi-k2-instruct"
    | "anthropic/claude-3-7-sonnet"
    | "anthropic/claude-sonnet-4"
    | "anthropic/claude-opus-4"
    | "anthropic/claude-3-5-haiku"
    | "cerebras/qwen-3-235b-a22b-instruct"
    | "cerebras/qwen-3-235b-a22b-thinking"
    | "cerebras/llama-3.3-70b"
    | "cerebras/llama-4-maverick-17b-128e-instruct"
    | "cerebras/llama-4-scout-17b-16e-instruct"
    | "cerebras/gpt-oss-120b"
    | "google-ai-studio/gemini-2.5-flash"
    | "google-ai-studio/gemini-2.5-pro"
    | "grok/grok-4"
    | "groq/llama-3.3-70b-versatile"
    | "groq/llama-3.1-8b-instant"
    | "openai/gpt-5"
    | "openai/gpt-5-mini"
    | "openai/gpt-5-nano"
    | (string & {});

  type EmbeddingModel =
    | "@cf/qwen/qwen3-embedding-0.6b"
    | "@cf/baai/bge-m3"
    | "@cf/baai/bge-large-en-v1.5"
    | "@cf/google/embeddinggemma-300m"
    | "google-ai-studio/gemini-embedding-001"
    | "openai/text-embedding-3-small"
    | "openai/text-embedding-3-large"
    | (string & {});

  type RerankingModel = "@cf/baai/bge-reranker-base" | (string & {});

  interface ApiPayload {
    id: string;
    source: string;
    type: "r2" | "web-crawler";
    ai_gateway_id?: string;
    ai_search_model?: Model;
    cache?: boolean;
    cache_threshold?:
      | "super_strict_match"
      | "close_enough"
      | "flexible_friend"
      | "anything_goes";
    chunk?: boolean;
    chunk_overlap?: number;
    chunk_size?: number;
    custom_metadata?: Array<{
      data_type: "text" | "number" | "boolean";
      /**
       * @minLength 1
       * @maxLength 64
       */
      field_name: string;
    }>;
    embedding_model?: EmbeddingModel;
    hybrid_search_enabled?: boolean;
    max_num_results?: number;
    metadata?: {
      created_from_aisearch_wizard?: boolean;
      worker_domain?: string;
    };
    public_endpoint_params?: {
      authorized_hosts?: string[];
      chat_completions_endpoint?: {
        disabled?: boolean;
      };
      enabled?: boolean;
      mcp?: {
        disabled?: boolean;
      };
      rate_limit?: {
        /**
         * Maximum: 3,600,000, Minimum: 60,000
         */
        period_ms?: number;
        /**
         * Minimum: 1
         */
        requests?: number;
        technique?: "fixed" | "sliding";
      };
      search_endpoint?: {
        disabled?: boolean;
      };
    };
    reranking?: boolean;
    reranking_model?: RerankingModel;
    rewrite_model?: Model;
    rewrite_query?: boolean;

    /**
     * Maximum: 1, Minimum: 0, Default: 0.4
     */
    score_threshold?: number;
    source_params?: {
      exclude_items?: string[];
      include_items?: string[];
      prefix?: string;
      r2_jurisdiction?: string; // Default: "default"
      web_crawler?: {
        /**
         * Default: {"parse_type":"sitemap"}
         */
        parse_options?: {
          include_headers?: Record<string, string>;
          include_images?: boolean;
          specific_sitemaps?: string[]; // Only valid when parse_type is 'sitemap'
          use_browser_rendering?: boolean;
        };
        parse_type?: "sitemap" | "feed-rss"; // Default: "sitemap"
        store_options?: {
          storage_id: string;
          r2_jurisdiction?: string; // Default: "default"
          storage_type?: "r2";
        };
      };
    };
    token_id?: string;
  }

  interface ApiResponse {
    id: string;
    account_id: string;
    account_tag: string;
    created_at: string;
    internal_id: string;
    modified_at: string;
    source: string;
    type: "r2" | "web-crawler";
    vectorize_name: string;
    ai_gateway_id?: string;
    ai_search_model?: Model;
    cache?: boolean; // default: true
    cache_threshold?:
      | "super_strict_match"
      | "close_enough"
      | "flexible_friend"
      | "anything_goes"; // default: "close_enough"
    chunk?: boolean; // default: true
    chunk_overlap?: number; // maximum: 30, minimum: 0, default: 10
    chunk_size?: number; // minimum: 64, default: 256
    created_by?: string;
    custom_metadata?: Array<{
      data_type: "text" | "number" | "boolean";
      field_name: string;
    }>;
    embedding_model?: EmbeddingModel;
    enable?: boolean;
    engine_version?: number; // default: 1
    hybrid_search_enabled?: boolean;
    last_activity?: string;
    max_num_results?: number; // maximum: 50, minimum: 1, default: 10
    metadata?: {
      created_from_aisearch_wizard?: boolean;
      worker_domain?: string;
    };
    modified_by?: string;
    paused?: boolean;
    public_endpoint_id?: string;
    public_endpoint_params?: {
      authorized_hosts?: string[];
      chat_completions_endpoint?: {
        disabled?: boolean;
      };
      enabled?: boolean;
      mcp?: {
        disabled?: boolean;
      };
      rate_limit?: {
        period_ms?: number; // maximum: 3600000, minimum: 60000
        requests?: number;
        technique?: "fixed" | "sliding";
      };
      search_endpoint?: {
        disabled?: boolean;
      };
    };
    reranking?: boolean;
    reranking_model?: RerankingModel;
    rewrite_model?: Model;
    rewrite_query?: boolean;
    score_threshold?: number;
    source_params?: {
      exclude_items?: string[];
      include_items?: string[];
      prefix?: string;
      r2_jurisdiction?: string; // default: "default"
      web_crawler?: {
        parse_options?: {
          include_headers?: Record<string, string>;
          include_images?: boolean;
          specific_sitemaps?: string[]; // valid with 'sitemap' parse_type
          use_browser_rendering?: boolean;
        };
        parse_type?: "sitemap" | "feed-rss"; // default: "sitemap"
        store_options?: {
          storage_id: string;
          r2_jurisdiction?: string; // default: "default"
          storage_type?: "r2";
        };
      };
    };
    status?: "waiting" | "ready" | "indexing" | "error";
    summarization?: boolean;
    summarization_model?:
      | "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      | "@cf/meta/llama-3.1-8b-instruct-fast"
      | "@cf/meta/llama-3.1-8b-instruct-fp8"
      | "@cf/meta/llama-4-scout-17b-16e-instruct"
      | "@cf/qwen/qwen3-30b-a3b-fp8"
      | "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"
      | "@cf/moonshotai/kimi-k2-instruct"
      | "anthropic/claude-3-7-sonnet"
      | "anthropic/claude-sonnet-4"
      | "anthropic/claude-opus-4"
      | "anthropic/claude-3-5-haiku"
      | "cerebras/qwen-3-235b-a22b-instruct"
      | "cerebras/qwen-3-235b-a22b-thinking"
      | "cerebras/llama-3.3-70b"
      | "cerebras/llama-4-maverick-17b-128e-instruct"
      | "cerebras/llama-4-scout-17b-16e-instruct"
      | "cerebras/gpt-oss-120b"
      | "google-ai-studio/gemini-2.5-flash"
      | "google-ai-studio/gemini-2.5-pro"
      | "grok/grok-4"
      | "groq/llama-3.3-70b-versatile"
      | "groq/llama-3.1-8b-instant"
      | "openai/gpt-5"
      | "openai/gpt-5-mini"
      | "openai/gpt-5-nano"
      | (string & {});
    system_prompt_ai_search?: string;
    system_prompt_index_summarization?: string;
    system_prompt_rewrite_query?: string;
    token_id?: string;
    vectorize_active_namespace?: string;
  }
}

export async function listAiSearchInstances(
  api: CloudflareApi,
): Promise<AiSearch.ApiResponse[]> {
  return await extractCloudflareResult<AiSearch.ApiResponse[]>(
    "list AI Search instances",
    api.get(`/accounts/${api.accountId}/ai-search/instances`),
  );
}

export async function createAiSearchInstance(
  api: CloudflareApi,
  payload: AiSearch.ApiPayload,
): Promise<AiSearch.ApiResponse> {
  return await extractCloudflareResult<AiSearch.ApiResponse>(
    `create AI Search instance "${payload.id}"`,
    api.post(`/accounts/${api.accountId}/ai-search/instances`, payload),
  );
}

export async function getAiSearchInstance(
  api: CloudflareApi,
  id: string,
): Promise<AiSearch.ApiResponse> {
  return await extractCloudflareResult<AiSearch.ApiResponse>(
    `get AI Search instance "${id}"`,
    api.get(`/accounts/${api.accountId}/ai-search/instances/${id}`),
  );
}

export async function updateAiSearchInstance(
  api: CloudflareApi,
  id: string,
  payload: AiSearch.ApiPayload,
): Promise<AiSearch.ApiResponse> {
  return await extractCloudflareResult<AiSearch.ApiResponse>(
    `update AI Search instance "${id}"`,
    api.put(`/accounts/${api.accountId}/ai-search/instances/${id}`, payload),
  );
}

export async function deleteAiSearchInstance(
  api: CloudflareApi,
  id: string,
): Promise<void> {
  try {
    await extractCloudflareResult(
      `delete AI Search instance "${id}"`,
      api.delete(`/accounts/${api.accountId}/ai-search/instances/${id}`),
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return;
    }
    throw error;
  }
}

interface AiSearchJobApiResponse {
  id: string;
  source: "user" | "schedule";
  end_reason: string | null;
  ended_at: string | null;
  last_seen_at: string | null;
  started_at: string | null;
}

export async function listAiSearchJobs(
  api: CloudflareApi,
  aiSearchId: string,
): Promise<AiSearchJobApiResponse[]> {
  return await extractCloudflareResult<AiSearchJobApiResponse[]>(
    `list AI Search jobs for instance "${aiSearchId}"`,
    api.get(
      `/accounts/${api.accountId}/ai-search/instances/${aiSearchId}/jobs`,
    ),
  );
}

export async function createAiSearchJob(
  api: CloudflareApi,
  aiSearchId: string,
): Promise<AiSearchJobApiResponse> {
  return await extractCloudflareResult<AiSearchJobApiResponse>(
    `create AI Search job for instance "${aiSearchId}"`,
    api.post(
      `/accounts/${api.accountId}/ai-search/instances/${aiSearchId}/jobs`,
      {},
    ),
  );
}

export async function getAiSearchJob(
  api: CloudflareApi,
  aiSearchId: string,
  jobId: string,
): Promise<AiSearchJobApiResponse> {
  return await extractCloudflareResult<AiSearchJobApiResponse>(
    `get AI Search job "${jobId}" for instance "${aiSearchId}"`,
    api.get(
      `/accounts/${api.accountId}/ai-search/instances/${aiSearchId}/jobs/${jobId}`,
    ),
  );
}

interface AiSearchJobLogItem {
  id: number;
  created_at: number;
  message: string;
  message_type: number;
}

export async function listAiSearchJobLogs(
  api: CloudflareApi,
  aiSearchId: string,
  jobId: string,
): Promise<AiSearchJobLogItem[]> {
  try {
    return await extractCloudflareResult<AiSearchJobLogItem[]>(
      `list AI Search job logs for job "${jobId}" for instance "${aiSearchId}"`,
      api.get(
        `/accounts/${api.accountId}/ai-search/instances/${aiSearchId}/jobs/${jobId}/logs?per_page=500`,
      ),
    );
  } catch (error) {
    if (
      isCloudflareApiError(error, { code: 7002 }) // ai_search_not_found
    ) {
      return [];
    }
    throw error;
  }
}

export async function runAiSearchJob(
  api: CloudflareApi,
  aiSearchId: string,
  log: (message: string) => void,
): Promise<void> {
  log("Preparing to index...");
  const job = await createAiSearchJob(api, aiSearchId);
  let lastLogId = 0;
  let done = false;
  const resultPromise = poll({
    description: `run AI Search job "${job.id}" for instance "${aiSearchId}"`,
    fn: () => getAiSearchJob(api, aiSearchId, job.id),
    predicate: (result) => result.ended_at !== null,
  });
  pollLogs();

  const result = await resultPromise;
  done = true;
  log(`Sync completed: ${result.end_reason}`);

  async function pollLogs() {
    const logs = await listAiSearchJobLogs(api, aiSearchId, job.id);
    for (let i = logs.length - 1; i >= 0; i--) {
      const item = logs[i];
      if (item.id > lastLogId) {
        lastLogId = item.id;
        log(item.message);
      }
    }
    if (!done) {
      await sleep(3000);
      await pollLogs();
    }
  }
}
