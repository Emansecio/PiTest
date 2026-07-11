import { createRequire } from "node:module";
import type { ImagesApi, ImagesModel, KnownImagesProvider } from "./types.ts";

type ImageModelsCatalog = typeof import("./image-models.generated.ts").IMAGE_MODELS;

const requireImageModels = createRequire(import.meta.url);
const imageModelRegistry: Map<string, Map<string, ImagesModel<ImagesApi>>> = new Map();
let registryReady = false;

function ensureRegistry(): void {
	if (registryReady) return;
	let IMAGE_MODELS: ImageModelsCatalog;
	try {
		IMAGE_MODELS = (requireImageModels("./image-models.generated.js") as { IMAGE_MODELS: ImageModelsCatalog })
			.IMAGE_MODELS;
	} catch {
		IMAGE_MODELS = (requireImageModels("./image-models.generated.ts") as { IMAGE_MODELS: ImageModelsCatalog })
			.IMAGE_MODELS;
	}
	for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
		const providerModels = new Map<string, ImagesModel<ImagesApi>>();
		for (const [id, model] of Object.entries(models)) {
			providerModels.set(id, model as ImagesModel<ImagesApi>);
		}
		imageModelRegistry.set(provider, providerModels);
	}
	registryReady = true;
}

type ImageModelApi<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof ImageModelsCatalog[TProvider],
> = ImageModelsCatalog[TProvider][TModelId] extends { api: infer TApi }
	? TApi extends ImagesApi
		? TApi
		: never
	: never;

export function getImageModel<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof ImageModelsCatalog[TProvider],
>(provider: TProvider, modelId: TModelId): ImagesModel<ImageModelApi<TProvider, TModelId>> {
	ensureRegistry();
	const providerModels = imageModelRegistry.get(provider);
	return providerModels?.get(modelId as string) as ImagesModel<ImageModelApi<TProvider, TModelId>>;
}

export function getImageProviders(): KnownImagesProvider[] {
	ensureRegistry();
	return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

export function getImageModels<TProvider extends KnownImagesProvider>(
	provider: TProvider,
): ImagesModel<ImageModelApi<TProvider, keyof ImageModelsCatalog[TProvider]>>[] {
	ensureRegistry();
	const models = imageModelRegistry.get(provider);
	return models
		? (Array.from(models.values()) as ImagesModel<ImageModelApi<TProvider, keyof ImageModelsCatalog[TProvider]>>[])
		: [];
}
