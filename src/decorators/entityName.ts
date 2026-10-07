// // entity-decorator.ts
// export function Entity(name: string) {
//   return function (
//     target: any,
//     propertyKey?: string,
//     descriptor?: PropertyDescriptor,
//   ) {
//     const handler = descriptor?.value || target;
//     handler.__entityName = name;
//     return descriptor || target;
//   };
// }

// // entity-plugin.ts
// import fp from 'fastify-plugin';

// declare module 'fastify' {
//   interface FastifyRequest {
//     entityName?: string;
//   }
// }

// export default fp(async (fastify) => {
//   fastify.decorateRequest('entityName', null);

//   fastify.addHook('preHandler', async (req, reply) => {
//     const route = reply.context.config as any;
//     const handler = route?.handler;
//     if (handler?.__entityName) {
//       req.entityName = handler.__entityName;
//     }
//   });
// });

