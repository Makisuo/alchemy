import alchemy from "alchemy";
import { Ai, AiSearch, R2Bucket, Worker } from "alchemy/cloudflare";

export const app = await alchemy("cloudflare-ai-search");

const bucket = await R2Bucket("bucket", {
  empty: true,
  delete: true,
  dev: {
    remote: true,
  },
});

const files = {
  "france.txt": "The capital of France is Paris.",
  "germany.txt": "The capital of Germany is Berlin.",
  "spain.txt": "The capital of Spain is Madrid.",
  "italy.txt": "The capital of Italy is Rome.",
  "portugal.txt": "The capital of Portugal is Lisbon.",
  "greece.txt": "The capital of Greece is Athens.",
  "turkey.txt": "The capital of Turkey is Ankara.",
  "netherlands.txt": "The capital of the Netherlands is Amsterdam.",
  "belgium.txt": "The capital of Belgium is Brussels.",
  "denmark.txt": "The capital of Denmark is Copenhagen.",
};

await Promise.all(
  Object.entries(files).map(([key, value]) => bucket.put(key, value)),
);

const search = await AiSearch("search", {
  source: bucket,
  cache: false,
  delete: true,
  adopt: true,
});

await bucket.list().then((list) => {
  console.log(list.objects.map((o) => o.key));
});

export const worker = await Worker("worker", {
  entrypoint: "src/worker.ts",
  bindings: {
    AI: Ai(),
    RAG_ID: search.id,
  },
});

console.log({ url: worker.url });

if (process.env.ALCHEMY_E2E) {
  const { test } = await import("./e2e.test.js");
  await test({ url: worker.url! });
}

await app.finalize();
