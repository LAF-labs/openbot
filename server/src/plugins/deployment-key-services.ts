/**
 * Every entry a deployment has because the fleet holds a key, in the order they are reconciled.
 *
 * Apart from the runtime (`deployment-key-runtime.ts`) because each vendor's module takes its types
 * from there, and a list living beside those types would be the runtime importing its own users.
 * Adding one is three things, and the types hold the first two: a family in `catalogue.ts` with its
 * environment name in `shared-clients.ts`, the entry in the catalogue, and a line here.
 */
import type { DeploymentKeyService } from "./deployment-key-runtime";
import { PUBLIC_DATA_SERVICE } from "./public-data-rest";
import { WEB_SEARCH_SERVICE } from "./web-search-rest";

export const DEPLOYMENT_KEY_SERVICES: readonly DeploymentKeyService[] =
  Object.freeze([PUBLIC_DATA_SERVICE, WEB_SEARCH_SERVICE]);
