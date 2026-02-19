import type { worker } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: typeof worker.Env) {
    const url = new URL(request.url);
    if (url.pathname === "/list") {
      const result = await env.AI.autorag(env.RAG_ID).list();
      return Response.json(result);
    }
    const query = url.searchParams.get("q");
    if (url.pathname === "/query" && query) {
      const result = await env.AI.autorag(env.RAG_ID).aiSearch({
        query,
      });
      return Response.json(result, {
        status: result.data.length > 0 ? 200 : 400,
      });
    } else if (url.pathname === "/search" && query) {
      const result = await env.AI.autorag(env.RAG_ID).search({
        query,
      });
      return Response.json(result, {
        status: result.data.length > 0 ? 200 : 400,
      });
    }
    return new Response("Usage: /query?q=... or /search?q=...");
  },
};
