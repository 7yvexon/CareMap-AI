import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openServiceCatalog } from './lib/service-catalog.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(projectRoot, 'data/source/nhis_integrated_care_resources_20260630.csv');
const databasePath = join(projectRoot, 'data/cache/service_resources.sqlite');
const startedAt = performance.now();
const catalog = await openServiceCatalog({ sourcePath, databasePath, forceRebuild: true });
const elapsedMs = Math.round(performance.now() - startedAt);

console.log(`Rebuilt local SQLite service catalog: ${catalog.rowCount} rows in ${elapsedMs} ms`);
catalog.database.close();
