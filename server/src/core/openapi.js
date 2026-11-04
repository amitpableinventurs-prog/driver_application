import { z } from 'zod';
import { registry } from './api.js';

const toJson = (schema) => {
  const { $schema, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return json;
};

const pathParams = (path) => [...path.matchAll(/:(\w+)/g)].map(([, name]) => name);

function requestBody(route) {
  const schema = route.body ? toJson(route.body) : { type: 'object', properties: {} };
  if (route.fileField) {
    schema.properties = { ...schema.properties, [route.fileField]: { type: 'string', format: 'binary' } };
    schema.required = [...(schema.required || []), route.fileField];
    return { required: true, content: { 'multipart/form-data': { schema } } };
  }
  return route.body ? { required: true, content: { 'application/json': { schema } } } : undefined;
}

export function buildOpenApi(serverUrl) {
  const paths = {};
  for (const route of registry) {
    const path = route.path.replace(/:(\w+)/g, '{$1}');
    const parameters = pathParams(route.path).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    if (route.query) {
      const query = toJson(route.query);
      for (const [name, schema] of Object.entries(query.properties || {})) {
        parameters.push({ name, in: 'query', required: (query.required || []).includes(name) && schema.default === undefined, schema });
      }
    }
    paths[path] ||= {};
    paths[path][route.method] = {
      tags: [route.tag],
      summary: route.summary,
      description: route.description,
      security: route.auth ? [{ bearerAuth: [] }] : [],
      parameters,
      requestBody: requestBody(route),
      'x-role': route.auth || 'public',
      'x-permission': route.perm,
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
        400: { description: 'Validation or business rule error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Driver IN API',
      version: '1.0.0',
      description: 'REST API for the Driver IN customer app, driver app, customer panel and admin panel.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Success: { type: 'object', properties: { success: { type: 'boolean', example: true }, message: { type: 'string' }, data: {} } },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } },
          },
        },
      },
    },
    paths,
  };
}
