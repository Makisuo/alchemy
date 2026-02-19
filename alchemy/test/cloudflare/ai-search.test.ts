import "../../src/test/vitest.ts";

import { assert, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { AiSearchToken } from "../../src/cloudflare/ai-search-token.ts";
import {
  AiSearch,
  deleteAiSearchInstance,
  getAiSearchInstance,
} from "../../src/cloudflare/ai-search.ts";
import { Ai } from "../../src/cloudflare/ai.ts";
import { createCloudflareApi } from "../../src/cloudflare/api.ts";
import { R2Bucket } from "../../src/cloudflare/bucket.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { destroy } from "../../src/destroy.ts";
import { poll } from "../../src/util/poll.ts";
import { BRANCH_PREFIX } from "../util.ts";

// Create API client for verification
const api = await createCloudflareApi();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("AiSearchToken Resource", () => {
  const testId = `${BRANCH_PREFIX}-ai-token`;

  test("create and delete AI Search token", async (scope) => {
    let token: AiSearchToken | undefined;

    try {
      // Create an AI Search token
      token = await AiSearchToken("test-token", {
        name: `${testId}`,
      });

      expect(token.tokenId).toBeTruthy();
      expect(token.accountTokenId).toBeTruthy();
      expect(token.name).toEqual(testId);
      expect(token.type).toEqual("ai_search_token");
      expect(token.cfApiId).toBeTruthy();
      expect(token.cfApiKey).toBeTruthy();
      expect(token.enabled).toBe(true);

      // Verify token was created by querying the API directly
      const getResponse = await api.get(
        `/accounts/${api.accountId}/ai-search/tokens/${token.tokenId}`,
      );
      expect(getResponse.status).toEqual(200);
    } finally {
      await destroy(scope);

      // Verify AI Search token was deleted
      if (token?.tokenId) {
        const getDeletedResponse = await api.get(
          `/accounts/${api.accountId}/ai-search/tokens/${token.tokenId}`,
        );
        expect(getDeletedResponse.status).toEqual(404);
      }
    }
  });
});

describe("AiSearch Resource", () => {
  const testId = `${BRANCH_PREFIX}-ai-search`;

  test("create, update, and delete AI Search instance with R2 source", async (scope) => {
    const instanceName = `${testId}-r2`;
    const bucketName = `${testId}-bucket`;

    let aiSearch: AiSearch | undefined;
    let bucket: R2Bucket | undefined;

    try {
      // Create an R2 bucket for the AI Search source
      bucket = await R2Bucket("test-bucket", {
        name: bucketName,
        adopt: true,
      });

      expect(bucket.name).toEqual(bucketName);

      // Create AI Search instance backed by R2 with automatic token creation
      aiSearch = await AiSearch("test-search", {
        name: instanceName,
        source: {
          type: "r2",
          bucket,
        },
        indexOnCreate: false, // skip index on create to speed up test
        adopt: true,
      });

      expect(aiSearch.id).toEqual(instanceName);
      expect(aiSearch.type).toEqual("r2");
      expect(aiSearch.source).toEqual(bucketName);
      expect(aiSearch.tokenId).toBeTruthy();
      // Note: internalId and vectorizeName may not be immediately available

      // Verify instance was created by querying the API directly
      const instance = await getAiSearchInstance(api, instanceName);
      expect(instance.id).toEqual(instanceName);
      expect(instance.type).toEqual("r2");

      // Update the AI Search configuration
      aiSearch = await AiSearch("test-search", {
        name: instanceName,
        source: {
          type: "r2",
          bucket,
        },
        maxNumResults: 20,
        scoreThreshold: 0.5,
        reranking: true,
        indexOnCreate: false, // skip index on create to speed up test
        adopt: true,
      });

      expect(aiSearch.id).toEqual(instanceName);
      expect(aiSearch.maxNumResults).toEqual(20);
      expect(aiSearch.scoreThreshold).toEqual(0.5);
      expect(aiSearch.reranking).toEqual(true);

      // Verify instance was updated
      const updatedInstance = await getAiSearchInstance(api, instanceName);
      expect(updatedInstance.max_num_results).toEqual(20);
      expect(updatedInstance.score_threshold).toEqual(0.5);
      expect(updatedInstance.reranking).toEqual(true);
    } finally {
      await destroy(scope);

      // Verify instance was deleted
      const getResponse = await api.get(
        `/accounts/${api.accountId}/ai-search/instances/${instanceName}`,
      );
      expect(getResponse.status).toEqual(404);
    }
  });

  test("create AI Search with bucket name string", async (scope) => {
    const instanceName = `${testId}-str`;
    const bucketName = `${testId}-str-bucket`;

    let aiSearch: AiSearch | undefined;

    try {
      // First create the bucket so it exists
      await R2Bucket("str-bucket", {
        name: bucketName,
        adopt: true,
      });

      // Create AI Search using bucket name string instead of resource
      aiSearch = await AiSearch("str-search", {
        name: instanceName,
        source: {
          type: "r2",
          bucket: bucketName, // String instead of R2Bucket resource
        },
        indexOnCreate: false, // skip index on create to speed up test
        adopt: true,
      });

      expect(aiSearch.id).toEqual(instanceName);
      expect(aiSearch.type).toEqual("r2");
      expect(aiSearch.source).toEqual(bucketName);
    } finally {
      await destroy(scope);
    }
  });

  test("create AI Search with invalid domain", async (scope) => {
    const instanceName = `${testId}-invalid`;

    let aiSearch: AiSearch | undefined;

    try {
      aiSearch = await AiSearch("invalid-search", {
        name: instanceName,
        source: {
          type: "web-crawler",
          domain: "invalid-domain.com",
        },
        adopt: true,
      });
    } catch (error) {
      assert(error instanceof Error);
      expect(error.message).toContain(
        "The domain needs to belong to this account.",
      );
    } finally {
      await destroy(scope);
    }
  });

  test("create AI Search with R2Bucket shorthand", async (scope) => {
    const instanceName = `${testId}-shorthand`;
    const bucketName = `${testId}-shorthand-bucket`;

    let aiSearch: AiSearch | undefined;

    try {
      const bucket = await R2Bucket("shorthand-bucket", {
        name: bucketName,
        adopt: true,
      });

      // Use shorthand: pass R2Bucket directly as source
      aiSearch = await AiSearch("shorthand-search", {
        name: instanceName,
        source: bucket, // Direct R2Bucket instead of { type: "r2", bucket }
        indexOnCreate: false, // skip index on create to speed up test
        adopt: true,
      });

      expect(aiSearch.id).toEqual(instanceName);
      expect(aiSearch.type).toEqual("r2");
      expect(aiSearch.source).toEqual(bucketName);
      expect(aiSearch.tokenId).toBeTruthy();
    } finally {
      await destroy(scope);
    }
  });

  test("create AI Search with explicit token", async (scope) => {
    const instanceName = `${testId}-explicit`;
    const bucketName = `${testId}-explicit-bucket`;

    let aiSearch: AiSearch | undefined;

    try {
      const bucket = await R2Bucket("explicit-bucket", {
        name: bucketName,
        adopt: true,
      });

      // Create an explicit token
      const token = await AiSearchToken("explicit-token", {
        name: `${testId}-explicit-token`,
      });

      // Create AI Search with explicit token
      aiSearch = await AiSearch("explicit-search", {
        name: instanceName,
        source: {
          type: "r2",
          bucket,
        },
        token, // Pass explicit token
        indexOnCreate: false, // skip index on create to speed up test
        adopt: true,
      });

      expect(aiSearch.id).toEqual(instanceName);
      expect(aiSearch.tokenId).toEqual(token.tokenId);
    } finally {
      await destroy(scope);
    }
  });

  test("create AI Search with custom models and chunking", async (scope) => {
    const instanceName = `${testId}-custom`;
    const bucketName = `${testId}-custom-bucket`;

    let aiSearch: AiSearch | undefined;

    try {
      const bucket = await R2Bucket("custom-bucket", {
        name: bucketName,
        adopt: true,
      });

      // Create AI Search with custom configuration
      aiSearch = await AiSearch("custom-search", {
        name: instanceName,
        source: {
          type: "r2",
          bucket,
        },
        chunkSize: 512,
        chunkOverlap: 20,
        maxNumResults: 15,
        scoreThreshold: 0.3,
        rewriteQuery: true,
        indexOnCreate: false, // skip index on create to speed up test
        adopt: true,
      });

      expect(aiSearch.id).toEqual(instanceName);
      expect(aiSearch.chunkSize).toEqual(512);
      expect(aiSearch.chunkOverlap).toEqual(20);
      expect(aiSearch.maxNumResults).toEqual(15);
      expect(aiSearch.scoreThreshold).toEqual(0.3);
      expect(aiSearch.rewriteQuery).toEqual(true);
    } finally {
      await destroy(scope);
    }
  });

  test("adopt existing AI Search instance", async (scope) => {
    const instanceName = `${testId}-adopt`;
    const bucketName = `${testId}-adopt-bucket`;

    try {
      const bucket = await R2Bucket("adopt-bucket", {
        name: bucketName,
        adopt: true,
      });

      // Create initial instance
      const aiSearch1 = await AiSearch("adopt-search-1", {
        name: instanceName,
        source: {
          type: "r2",
          bucket,
        },
        maxNumResults: 10,
        indexOnCreate: false, // skip index on create to speed up test
      });

      expect(aiSearch1.id).toEqual(instanceName);

      // Create second instance with same name - should adopt
      const aiSearch2 = await AiSearch("adopt-search-2", {
        name: instanceName,
        source: {
          type: "r2",
          bucket,
        },
        maxNumResults: 25,
        indexOnCreate: false, // skip index on create to speed up test
        adopt: true,
      });

      // Should have adopted and updated
      expect(aiSearch2.id).toEqual(instanceName);
      expect(aiSearch2.maxNumResults).toEqual(25);
    } finally {
      await destroy(scope);
    }
  });

  test("AI Search with delete false preserves instance", async (scope) => {
    const instanceName = `${testId}-nodelete`;
    const bucketName = `${testId}-nodelete-bucket`;

    try {
      const bucket = await R2Bucket("nodelete-bucket", {
        name: bucketName,
        adopt: true,
      });

      await AiSearch("nodelete-search", {
        name: instanceName,
        source: {
          type: "r2",
          bucket,
        },
        indexOnCreate: false, // skip index on create to speed up test
        delete: false, // don't delete on destroy
        adopt: true,
      });

      // Destroy the scope
      await destroy(scope);

      // Instance should still exist
      const instance = await getAiSearchInstance(api, instanceName);
      expect(instance.id).toEqual(instanceName);
    } finally {
      await deleteAiSearchInstance(api, instanceName);
    }
  });

  // Test aiSearch() with RAG response generation
  test(
    "AI Search with RAG response generation via Worker",
    async (scope) => {
      const instanceName = `${testId}-rag`;
      const bucketName = `${testId}-rag-bucket`;
      const workerName = `${testId}-rag-worker`;

      try {
        // 1. Create bucket with test content
        const bucket = await R2Bucket("rag-bucket", {
          name: bucketName,
          adopt: true,
          // we can't seem to delete a bucket used by AI search
          delete: false,
          // empty: true, // Empty bucket on deletion since we upload docs
        });

        await bucket.put(
          "llama-care.md",
          `# How to Care for Llamas

## Feeding

Llamas eat grass, hay, and grain. Feed them twice daily.

## Housing

Provide a shelter with at least 40 square feet per llama.

## Health

Schedule regular vet checkups and keep vaccinations current.
`,
        );

        // 2. Create AI Search instance
        const aiSearch = await AiSearch("rag-search", {
          name: instanceName,
          source: {
            type: "r2",
            bucket,
          },
          cache: false,
          adopt: true,
        });

        expect(aiSearch.id).toEqual(instanceName);

        // 3. Create worker that uses aiSearch (RAG)
        const worker = await Worker(workerName, {
          name: workerName,
          adopt: true,
          script: `
            export default {
              async fetch(request, env, ctx) {
                try {
                  // Access AI Search through the AI binding using RAG_ID
                  const result = await env.AI.autorag(env.RAG_ID).aiSearch({
                    query: "How do I feed a llama?",
                    max_num_results: 3,
                  });
                  
                  return Response.json({
                    success: true,
                    hasResponse: !!result.response,
                    responseLength: result.response?.length || 0,
                    sourceCount: result.data?.length || 0,
                  });
                } catch (error) {
                  return Response.json({
                    success: false,
                    error: error.message,
                  }, { status: 500 });
                }
              }
            };
          `,
          format: "esm",
          url: true,
          bindings: {
            AI: Ai(),
            RAG_ID: aiSearch.id, // Pass the actual instance name
          },
        });

        expect(worker.url).toBeTruthy();

        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 5. Verify RAG response
        const data = await poll({
          description: "wait for AI Search to be ready",
          fn: async () => {
            const url = new URL(worker.url!);
            url.searchParams.set("q", "installation");
            const response = await fetch(url);
            return (await response.json()) as {
              success: boolean;
              hasResponse: boolean;
              responseLength: number;
              sourceCount: number;
            };
          },
          predicate: (result) => result.success && result.sourceCount > 0,
          initialDelay: 5000,
          maxDelay: 10_000,
        });

        expect(data.success).toBe(true);
        // AI Search with RAG should generate a response based on source documents
        expect(data.hasResponse).toBe(true);
        expect(data.responseLength).toBeGreaterThan(0);
        expect(data.sourceCount).toBeGreaterThan(0);
      } finally {
        await destroy(scope);
      }
    },
    60_000 * 10,
  );
});
