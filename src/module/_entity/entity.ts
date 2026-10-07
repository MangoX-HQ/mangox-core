import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { jwtGuard } from "../.."
import { getRelationshipRegistry } from "../../configs/core";
import fs from 'fs';
class EntityController {
  
  async getInverseRelationships(request: FastifyRequest, reply: FastifyReply) {
    const { entityName } = request.params as { entityName: string }
    const registry = getRelationshipRegistry()
    const allRelationships = registry.getForCollection(entityName)
    console.log(`All relationships for '${entityName}':`, allRelationships.map(r => r.name));

    // Filter only mangox_ prefixed relationships (inverse)
    const inverseRelationships = allRelationships
      .filter(rel => rel.name.startsWith('mangox_'))
      .map(rel => ({
        name: rel.name,
        sourceCollection: rel.sourceCollection,
        targetCollection: rel.targetCollection,
        localField: rel.localField,
        foreignField: rel.foreignField,
        type: rel.type,
        junction: rel.junction || undefined,
      }))

    return {
      data: inverseRelationships,
      total: inverseRelationships.length,
    }
  }

  
}

export async function EntityUtilRoutes(app: FastifyInstance) {
  const controller = new EntityController()
  // Get inverse (mangox_) relationships for an entity — always available
  app.get(
    "/entity/inverse-relationships/:entityName",
    { preHandler: jwtGuard.preHandler.bind(jwtGuard) },
    controller.getInverseRelationships.bind(controller)
  )
}
