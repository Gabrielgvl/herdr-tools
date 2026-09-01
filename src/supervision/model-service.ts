/**
 * The narrow model-registry and auth service the supervisor reviewer resolves
 * through.
 *
 * The Pi host already owns a model registry, so it adapts the one it has. The
 * MCP host has none, and `hostContext` deliberately keeps throwing for
 * `context.modelRegistry`: exposing the host's registry through that proxy would
 * widen the single Pi-type seam this repository maintains. It gets its own
 * host-independent service built from the installed Pi packages instead.
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelFor, ReviewerFailure, type ModelRegistrySeam } from "../reviewer.js";

export interface ResolvedSupervisionModel {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface SupervisionModelService {
  resolve(identifier: string): Promise<ResolvedSupervisionModel>;
}

function splitIdentifier(identifier: string): { provider: string; modelId: string } {
  const separator = identifier.indexOf("/");
  if (separator <= 0 || separator === identifier.length - 1) {
    throw new ReviewerFailure("Supervision reviewer model identifier must be provider/model", { model: identifier });
  }
  return { provider: identifier.slice(0, separator), modelId: identifier.slice(separator + 1) };
}

/** Adapt the Pi host's existing registry, keeping its credentials and refresh behaviour. */
export function createRegistryModelService(registry: ModelRegistrySeam): SupervisionModelService {
  return {
    async resolve(identifier) {
      const model = modelFor(registry, identifier);
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new ReviewerFailure("Supervision reviewer model is not authenticated", { model: model.id, cause: auth.error });
      return {
        model,
        ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
        ...(auth.headers === undefined ? {} : { headers: auth.headers }),
      };
    },
  };
}

/** The minimal slice of `Models` this service consumes, so it can be tested without network. */
export interface BuiltinModelsSeam {
  getModel(provider: string, id: string): Model<Api> | undefined;
  getAuth(model: Model<Api>): Promise<{ auth: { apiKey?: string; headers?: Record<string, string> } } | undefined>;
}

/**
 * The host-independent service. It resolves against the installed Pi package's
 * built-in provider catalogue and asks that catalogue for the model's auth. An
 * unresolvable model or unavailable credential is a reviewer failure: it never
 * selects a substitute model.
 */
export function createBuiltinModelService(models: BuiltinModelsSeam = builtinModels() as unknown as BuiltinModelsSeam): SupervisionModelService {
  return {
    async resolve(identifier) {
      const { provider, modelId } = splitIdentifier(identifier);
      const model = models.getModel(provider, modelId);
      if (!model) throw new ReviewerFailure("Supervision reviewer model could not be resolved", { model: identifier });
      const auth = await models.getAuth(model);
      if (!auth) throw new ReviewerFailure("Supervision reviewer model is not authenticated", { model: identifier });
      return {
        model,
        ...(auth.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
        ...(auth.auth.headers === undefined ? {} : { headers: auth.auth.headers }),
      };
    },
  };
}
