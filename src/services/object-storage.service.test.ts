import assert from 'node:assert/strict';
import test from 'node:test';
import { storageConfig, objectKey, objectLocation, objectReference, signedUpload, signedDownload, assertStorageConfiguration } from './object-storage.service';

const configure = (t: test.TestContext) => {
  const previous = { ...process.env };
  Object.assign(process.env, { S3_ENDPOINT: 'http://localhost:9000', S3_PUBLIC_ENDPOINT: 'https://storage.example.com',
    S3_BUCKET: 'test-files', MINIO_APP_USER: 'test-app', MINIO_APP_SECRET: 'test-secret-not-a-real-account', MINIO_ROOT_USER: 'root', NODE_ENV: 'test' });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
};
test('storage namespaces sanitize filenames and reject traversal / other buckets', t => {
  configure(t);
  assert.equal(objectKey('owner', 'job', 'original', '../parcel.dwg'), 'owner/job/original/parcel.dwg');
  assert.throws(() => objectKey('../owner', 'job', 'original', 'parcel.dwg'));
  assert.throws(() => objectLocation('s3://another-bucket/a'));
  assert.throws(() => objectLocation('s3://test-files/a/../secret'));
  assert.equal(objectLocation(objectReference('owner/job/healed/parcel.geojson')).Key, 'owner/job/healed/parcel.geojson');
});
test('storage rejects root credentials and insecure production public URLs', t => {
  configure(t);
  process.env.MINIO_APP_USER = 'root';
  assert.throws(storageConfig, /root/);
  process.env.MINIO_APP_USER = 'app'; process.env.NODE_ENV = 'production'; process.env.S3_PUBLIC_ENDPOINT = 'http://storage.example.com';
  assert.throws(storageConfig, /HTTPS/);
  process.env.STORAGE_DRIVER = 'local'; assert.throws(assertStorageConfiguration, /requires/);
});
test('direct POST binds the exact size and object key; download signatures use public origin and expire', async t => {
  configure(t);
  const post = await signedUpload('temporary/incoming/owner/job/incoming/parcel.zip', 2048);
  const policy = JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8'));
  assert.ok(policy.conditions.some((c: unknown) => JSON.stringify(c) === '["content-length-range",2048,2048]'));
  assert.equal(post.fields.key, 'temporary/incoming/owner/job/incoming/parcel.zip');
  assert.ok(post.url.startsWith('https://storage.example.com/'));
  await assert.rejects(signedUpload('a', 251 * 1024 * 1024));
  await assert.rejects(signedUpload('a', -1));
  const download = new URL(await signedDownload(objectReference('owner/job/healed/test.geojson'), 'parcel.geojson'));
  assert.equal(download.origin, 'https://storage.example.com');
  assert.equal(download.searchParams.get('X-Amz-Expires'), '900');
  assert.match(download.searchParams.get('response-content-disposition')!, /parcel.geojson/);
});
