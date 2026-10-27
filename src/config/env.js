require('dotenv').config();
const { z } = require('zod');

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string()
    .min(32, 'JWT_SECRET must be at least 32 characters; generate a unique random secret')
    .refine(
      (secret) => !/change[-_ ]?this|replace[-_ ]?me|your[-_ ]secret|development[-_ ]secret|example[-_ ]secret/i.test(secret),
      'JWT_SECRET must not be a placeholder',
    )
    .refine(
      (secret) => new Set(secret).size >= 16,
      'JWT_SECRET must contain at least 16 distinct characters',
    ),
  JWT_EXPIRES_IN: z.string().default('7d'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB: z.string().min(1).default('service_desk'),
  CORS_ORIGINS: z.string().default(''),
  SQLITE_SOURCE: z.string().default('./servicedesk.db'),
  UPLOAD_DIR: z.string().default('./uploads'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const corsOrigins = parsed.data.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (parsed.data.NODE_ENV === 'production' && corsOrigins.length === 0) {
  console.error('Invalid environment configuration:');
  console.error({ CORS_ORIGINS: ['Set a comma-separated list of HTTPS web origins in production'] });
  process.exit(1);
}

for (const origin of corsOrigins) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    console.error('Invalid environment configuration:');
    console.error({ CORS_ORIGINS: [`${origin} is not a valid origin`] });
    process.exit(1);
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    (parsed.data.NODE_ENV === 'production' && url.protocol !== 'https:')
  ) {
    console.error('Invalid environment configuration:');
    console.error({ CORS_ORIGINS: [`${origin} must be an origin${parsed.data.NODE_ENV === 'production' ? ' using HTTPS' : ''}`] });
    process.exit(1);
  }
}

module.exports = {
  ...parsed.data,
  corsOrigins: [...new Set(corsOrigins.map((origin) => new URL(origin).origin))],
};