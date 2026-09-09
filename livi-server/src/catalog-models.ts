import { GoogleGenAI } from "@google/genai";
import { CatalogError, catalogDeadline } from "@livi/decorator-agent";

/** Matches pipeline deployment configuration; the table has no per-row model identity. */
export const CATALOG_EMBEDDING_MODEL = "gemini-embedding-2-preview";
export const CATALOG_EMBEDDING_DIMENSIONS = 768;

export interface CatalogModels {
	embedQuery(query: string, signal?: AbortSignal): Promise<number[]>;
}

export function createCatalogModels(options: {
	apiKey?: string;
	client?: Pick<GoogleGenAI["models"], "embedContent">;
}): CatalogModels {
	const client = options.client ?? (options.apiKey ? new GoogleGenAI({ apiKey: options.apiKey }).models : undefined);
	return {
		async embedQuery(query, signal) {
			if (!client)
				throw new CatalogError("model_failed", "Catalog embedding model is not configured", { stage: "embed" });
			return catalogDeadline(async (active) => {
				try {
					active.throwIfAborted();
					const response = await client.embedContent({
						model: CATALOG_EMBEDDING_MODEL,
						contents: `task: search result | query: ${query}`,
						config: { outputDimensionality: CATALOG_EMBEDDING_DIMENSIONS, abortSignal: active },
					});
					const embedding = response.embeddings?.[0]?.values;
					if (
						!embedding ||
						embedding.length !== CATALOG_EMBEDDING_DIMENSIONS ||
						!embedding.every(Number.isFinite) ||
						!embedding.some((value) => value !== 0)
					)
						throw new CatalogError("model_failed", "Catalog embedding response is invalid", { stage: "embed" });
					return embedding;
				} catch (error) {
					if (error instanceof CatalogError) throw error;
					const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
					throw new CatalogError("model_failed", "Catalog embedding model failed", {
						stage: "embed",
						...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
							? { backendCode: `HTTP_${status}` }
							: {}),
					});
				}
			}, signal);
		},
	};
}
