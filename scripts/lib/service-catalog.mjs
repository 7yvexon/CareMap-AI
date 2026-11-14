import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import initSqlJs from 'sql.js';

const SCHEMA_VERSION = '2';
const SOURCE_AS_OF = '2026-06-30';
const REQUIRED_COLUMNS = [
  '시도',
  '시군구',
  '서비스 제공기관명',
  '기관연락처',
  '기관주소',
  '대분류',
  '중분류',
  '프로그램명칭',
];
const RESOURCE_FIELDS = [
  ['sido', '시도'],
  ['sigungu', '시군구'],
  ['provider', '서비스 제공기관명'],
  ['phone', '기관연락처'],
  ['address', '기관주소'],
  ['major', '대분류'],
  ['minor', '중분류'],
  ['program', '프로그램명칭'],
];
const REQUIRED_INDEXES = [
  'service_resources_sido_sigungu_major_idx',
  'service_resources_sigungu_major_idx',
  'service_resources_major_idx',
];

let sqlModulePromise;

function getSqlModule() {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

function normalize(value) {
  return String(value ?? '').replaceAll('\u00a0', ' ').replace(/\s+/g, ' ').trim();
}

function* parseCsvRows(text, label) {
  let row = [];
  let field = '';
  let quoted = false;
  let recordNumber = 0;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(value => value !== '')) {
        recordNumber++;
        yield { columns: row, recordNumber };
      }
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error(`${label} has an unterminated quoted field`);
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some(value => value !== '')) {
      recordNumber++;
      yield { columns: row, recordNumber };
    }
  }
}

function readMetadata(database) {
  const results = database.exec('SELECT key, value FROM service_catalog_metadata');
  if (!results.length) return null;
  return Object.fromEntries(results[0].values.map(([key, value]) => [key, value]));
}

function isCatalogCurrent(database, sourceHash, sourceBytes) {
  try {
    const metadata = readMetadata(database);
    if (!metadata
      || metadata.schema_version !== SCHEMA_VERSION
      || metadata.source_sha256 !== sourceHash
      || metadata.source_size_bytes !== String(sourceBytes)) return false;

    const counts = database.exec('SELECT COUNT(*) FROM service_resources');
    const count = counts[0]?.values[0]?.[0];
    if (String(count) !== metadata.source_row_count) return false;

    const indexResult = database.exec("SELECT name FROM sqlite_master WHERE type = 'index'");
    const indexes = new Set(indexResult[0]?.values.map(([name]) => name) ?? []);
    return REQUIRED_INDEXES.every(name => indexes.has(name));
  } catch {
    return false;
  }
}

function readStatementRows(statement, parameters) {
  const rows = [];
  try {
    statement.bind(parameters);
    while (statement.step()) rows.push(statement.getAsObject());
  } finally {
    statement.free();
  }
  return rows;
}

export async function openServiceCatalog({ sourcePath, databasePath, forceRebuild = false }) {
  const SQL = await getSqlModule();
  const source = await readFile(sourcePath);
  const sourceHash = createHash('sha256').update(source).digest('hex');

  if (!forceRebuild) {
    let existingDatabase;
    try {
      existingDatabase = new SQL.Database(await readFile(databasePath));
      if (isCatalogCurrent(existingDatabase, sourceHash, source.length)) {
        const metadata = readMetadata(existingDatabase);
        return createCatalogHandle(existingDatabase, metadata, false);
      }
    } catch {
      // Rebuild missing, outdated, or unreadable catalogs from the authoritative CSV.
    }
    try {
      existingDatabase?.close();
    } catch {
      // Ignore close errors for an unreadable or malformed SQLite file.
    }
  }

  const database = new SQL.Database();
  database.exec(`
    CREATE TABLE service_resources (
      id INTEGER PRIMARY KEY,
      sido TEXT NOT NULL,
      sigungu TEXT NOT NULL,
      provider TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      major TEXT NOT NULL,
      minor TEXT NOT NULL,
      program TEXT NOT NULL,
      searchable_text TEXT NOT NULL
    );
    CREATE TABLE service_catalog_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const sourceText = new TextDecoder('euc-kr').decode(source);
  const csvRecords = parseCsvRows(sourceText, sourcePath);
  const headerRecord = csvRecords.next();
  if (headerRecord.done) throw new Error(`${sourcePath} is empty`);
  const headers = headerRecord.value.columns.map((header, index) => index === 0 ? header.replace(/^\uFEFF/, '') : header);
  if (new Set(headers).size !== headers.length) throw new Error(`${sourcePath} contains duplicate CSV headers`);
  const columnIndexes = new Map(headers.map((header, index) => [header, index]));
  const missingColumns = REQUIRED_COLUMNS.filter(header => !columnIndexes.has(header));
  if (missingColumns.length) throw new Error(`${sourcePath} is missing required columns: ${missingColumns.join(', ')}`);
  if (headerRecord.value.columns.length !== headers.length) throw new Error(`${sourcePath} has an invalid CSV header`);

  const insertResource = database.prepare(`
    INSERT INTO service_resources (id, sido, sigungu, provider, phone, address, major, minor, program, searchable_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMetadata = database.prepare('INSERT INTO service_catalog_metadata (key, value) VALUES (?, ?)');
  let rowCount = 0;

  try {
    database.exec('BEGIN');
    for (const { columns, recordNumber } of csvRecords) {
      if (columns.length !== headers.length) {
        throw new Error(`${sourcePath} record ${recordNumber} has ${columns.length} columns; expected ${headers.length}`);
      }
      const values = RESOURCE_FIELDS.map(([fieldName, header]) => {
        const value = normalize(columns[columnIndexes.get(header)]);
        return fieldName === 'major' || fieldName === 'minor' ? value || '분류 미기재' : value;
      });
      // Search tokens cannot contain this separator, so matches cannot span source fields.
      const searchableText = [values[7], values[6], values[5], values[2], values[4]].join('\u001f');
      insertResource.bind([rowCount + 1, ...values, searchableText]);
      insertResource.step();
      insertResource.reset();
      rowCount++;
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  } finally {
    insertResource.free();
  }

  database.exec(`
    CREATE INDEX ${REQUIRED_INDEXES[0]} ON service_resources (sido, sigungu, major);
    CREATE INDEX ${REQUIRED_INDEXES[1]} ON service_resources (sigungu, major);
    CREATE INDEX ${REQUIRED_INDEXES[2]} ON service_resources (major);
  `);

  const metadata = {
    schema_version: SCHEMA_VERSION,
    source_sha256: sourceHash,
    source_size_bytes: String(source.length),
    source_row_count: String(rowCount),
    source_as_of: SOURCE_AS_OF,
  };
  try {
    for (const [key, value] of Object.entries(metadata)) {
      insertMetadata.bind([key, value]);
      insertMetadata.step();
      insertMetadata.reset();
    }
  } finally {
    insertMetadata.free();
  }

  if (rowCount === 0) {
    database.close();
    throw new Error(`${sourcePath} has no service-resource records`);
  }

  const temporaryPath = join(dirname(databasePath), `${basename(databasePath)}.${process.pid}.tmp`);
  try {
    await mkdir(dirname(databasePath), { recursive: true });
    await writeFile(temporaryPath, Buffer.from(database.export()));
    await rename(temporaryPath, databasePath);
  } catch (error) {
    database.close();
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }

  return createCatalogHandle(database, metadata, true);
}

function createCatalogHandle(database, metadata, rebuilt) {
  return {
    database,
    rowCount: Number(metadata.source_row_count),
    sourceHash: metadata.source_sha256,
    sourceAsOf: metadata.source_as_of,
    rebuilt,
    filterIndexCount: REQUIRED_INDEXES.length,
    summarizeServiceRecords({ province, district }) {
      const conditions = [];
      const parameters = [];
      if (province) {
        conditions.push('sido = ?');
        parameters.push(province);
      }
      if (district) {
        conditions.push('sigungu = ?');
        parameters.push(district);
      }

      // These are source program/resource rows, not distinct facilities, live availability, or capacity.
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const totalRows = readStatementRows(database.prepare(`
        SELECT COUNT(*) AS total_record_count
        FROM service_resources
        ${where}
      `), parameters);
      const rows = readStatementRows(database.prepare(`
        SELECT major, COUNT(*) AS record_count
        FROM service_resources
        ${where}
        GROUP BY major
        ORDER BY major COLLATE NOCASE, major
      `), parameters);
      const categories = rows.map(({ major, record_count }) => ({
        major,
        recordCount: Number(record_count),
      }));
      return {
        totalRecordCount: Number(totalRows[0]?.total_record_count ?? 0),
        categories,
      };
    },
    searchCandidates({ province, district, category, inferredCategories, terms }) {
      const conditions = [];
      const parameters = [];
      if (province) {
        conditions.push('sido = ?');
        parameters.push(province);
      }
      if (district) {
        conditions.push('sigungu = ?');
        parameters.push(district);
      }
      if (category) {
        conditions.push('major = ?');
        parameters.push(category);
      }

      const matches = [];
      for (const inferredCategory of inferredCategories) {
        matches.push('(minor = ? OR major = ?)');
        parameters.push(inferredCategory, inferredCategory);
      }
      for (const term of terms) {
        matches.push('instr(searchable_text, ?) > 0');
        parameters.push(term);
      }
      if (!matches.length) return [];
      conditions.push(`(${matches.join(' OR ')})`);

      const sql = `
        SELECT id, sido, sigungu, provider, phone, address, major, minor, program
        FROM service_resources
        WHERE ${conditions.join(' AND ')}
        ORDER BY id ASC
      `;
      return readStatementRows(database.prepare(sql), parameters);
    },
  };
}
