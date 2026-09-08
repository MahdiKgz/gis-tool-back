import 'dotenv/config';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { database } from '../src/services/database.service';
import { isObjectReference, objectKey, putStoredFile, materializeStoredFile, storageConfig } from '../src/services/object-storage.service';
import { readGisFile } from '../src/services/gis-file.service';
import { resolveHealedOutput } from '../src/services/heal-result.service';
import { analysisDatabaseData, type StoredAnalysis } from '../src/services/analysis-store.service';

const hashFile = async (file: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const verifiedCopy = async (key: string, file: string, contentType: string) => {
  const reference = await putStoredFile(key, file, contentType);
  const local = await materializeStoredFile(reference, 'verify.bin');
  try { if (await hashFile(file) !== await hashFile(local.filePath)) throw new Error('Object checksum mismatch'); }
  finally { await local.cleanup(); }
  return reference;
};
const localSource = (file: string, folder: string) => {
  const root = path.resolve('uploads', folder);
  const resolved = path.resolve(file);
  if (path.dirname(resolved) === root) return resolved;
  const legacyRoot = process.argv.find(arg => arg.startsWith('--legacy-root='))?.slice('--legacy-root='.length);
  if (legacyRoot && path.dirname(resolved) === path.resolve(legacyRoot, 'uploads', folder)) return path.join(root, path.basename(resolved));
  throw new Error('Source is outside the managed directory; specify --legacy-root for a relocated repository');
};
async function main() {
  const apply = process.argv.includes('--apply');
  const busy = await database.uploadedFile.count({ where: { healStatus: { in: ['queued', 'processing'] } } });
  if (busy) throw new Error('Stop accepting new jobs and let active healing finish before migration');
  if (apply) storageConfig();
  const records = await database.uploadedFile.findMany({ orderBy: { createdAt: 'asc' } });
  let migrated = 0, unavailable = 0, existing = 0;
  for (const record of records) {
    if (isObjectReference(record.storagePath)) { existing++; continue; }
    if (apply) console.log(`Migrating ${record.id}: reading legacy analysis`);
    let analysis: StoredAnalysis;
    try { analysis = JSON.parse(await fs.readFile(path.resolve('uploads/gis_analyses', `${record.id}.json`), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; unavailable++; continue; }
    if (analysis.ownerId !== record.userId || analysis.id !== record.id) throw new Error('Analysis ownership mismatch');
    const source = localSource(record.storagePath, 'gis_files');
    const available = await fs.stat(source).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!available) { unavailable++; continue; }
    if (!apply) { migrated++; continue; }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapgis-migration-'));
    try {
      console.log(`Migrating ${record.id}: verifying original`);
      const original = await verifiedCopy(objectKey(record.userId, record.id, 'original', record.originalName), source, record.mimeType);
      console.log(`Migrating ${record.id}: normalizing input`);
      const normalized = path.join(directory, 'input.geojson');
      await fs.writeFile(normalized, JSON.stringify(await readGisFile(source, record.originalName, analysis.jobData.sourceCrs ? { sourceCrs: analysis.jobData.sourceCrs } : undefined)));
      const input = await verifiedCopy(objectKey(record.userId, record.id, 'normalized', 'input.geojson'), normalized, 'application/geo+json');
      if (analysis.healResult?.outputFilePath && !isObjectReference(analysis.healResult.outputFilePath))
        analysis.healResult.outputFilePath = localSource(analysis.healResult.outputFilePath, 'cleaned_files');
      const output = resolveHealedOutput(analysis);
      if (output) {
        localSource(output.filePath, 'cleaned_files');
        const exists = await fs.stat(output.filePath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (exists) analysis.healResult!.outputFilePath = await verifiedCopy(objectKey(record.userId, record.id, 'healed', output.fileName), output.filePath, 'application/geo+json');
      }
      analysis.jobData = { ...analysis.jobData, filePath: input, originalObject: original, ownerId: record.userId };
      console.log(`Migrating ${record.id}: persisting metadata`);
      const data = analysisDatabaseData(analysis);
      await database.$transaction([
        database.$executeRaw`INSERT INTO analyses (id, payload, report) VALUES (${record.id}::uuid, ${data.payload}::jsonb, ${data.report}::jsonb) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, report = EXCLUDED.report`,
        database.uploadedFile.update({ where: { id: record.id }, data: { storagePath: original } }),
      ]);
      migrated++;
      console.log(`Verified and migrated ${record.id}`);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', migrated, alreadyMigrated: existing, unavailableLegacyFiles: unavailable }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => database.$disconnect());
