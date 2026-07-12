import { Environment } from "@hoppscotch/data"
import { getCombinedEnvVariables } from "~/helpers/utils/environments"
import { filterNonEmptyEnvironmentVariables } from "~/helpers/RequestRunner"

/**
 * gRPC requests have no request-variables or inherited-collection-variables
 * concept (no collection-tree UI yet — see docs/specs/grpc/00-DISCOVERY-NOTES.md),
 * so this is just global + selected environment, same precedence REST uses
 * for those two sources.
 */
export const getGRPCEffectiveEnvVariables = (): Environment["variables"] => {
  const { global, selected } = getCombinedEnvVariables()
  return filterNonEmptyEnvironmentVariables([...global, ...selected])
}
