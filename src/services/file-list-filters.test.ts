import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../middlewares/errorHandler";
import { buildUploadWhere, parseFileFilters } from "./file-list-filters";
import type { database } from "./database.service";
import { createUploadRecordLister } from "./upload-record.service";

test("validates all file filters before querying storage", () => {
  assert.deepEqual(parseFileFilters({ search:"  قطعه  ", fileType:"geojson", hasIssues:"false", uploadedFrom:"2026-09-01T00:00:00.000Z", uploadedTo:"2026-09-07T00:00:00.000Z" }), { search:"قطعه", fileType:"geojson", hasIssues:false, uploadedFrom:"2026-09-01T00:00:00.000Z", uploadedTo:"2026-09-07T00:00:00.000Z" });
  assert.deepEqual(parseFileFilters({search:"  "}),{});
  for (const query of [{search:["a","b"]},{search:"x".repeat(151)},{fileType:"exe"},{hasIssues:"yes"},{uploadedFrom:"2026-02-30T00:00:00.000Z"},{uploadedTo:"invalid"},{uploadedFrom:"2026-09-07T00:00:00.000Z",uploadedTo:"2026-09-01T00:00:00.000Z"}]) assert.throws(()=>parseFileFilters(query), (e)=>e instanceof AppError && e.code === "INVALID_FILE_FILTER");
});
test("combines owner isolation, literal search, file type, issue count and date range", () => {
  const where = buildUploadWhere("owner", {search:"100%_test",fileType:"kml",hasIssues:false,uploadedFrom:"2026-09-01T00:00:00.000Z",uploadedTo:"2026-09-07T00:00:00.000Z"});
  assert.deepEqual(where, {userId:"owner", OR:[{name:{contains:"100\\%\\_test",mode:"insensitive"}},{originalName:{contains:"100\\%\\_test",mode:"insensitive"}}],originalName:{endsWith:".kml",mode:"insensitive"},identifiedIssues:0,createdAt:{gte:new Date("2026-09-01T00:00:00.000Z"),lt:new Date("2026-09-07T00:00:00.000Z")}});
  assert.deepEqual(buildUploadWhere("owner",{hasIssues:true}).identifiedIssues,{gt:0});
});
test("applies the identical server predicate to paginated rows and total count", async () => {
  let listArgs: unknown, countArgs: unknown;
  const client = {
    uploadedFile: {
      findMany: async (args:unknown) => { listArgs=args; return []; },
      count: async (args:unknown) => { countArgs=args; return 27; },
    },
    $transaction: async (queries:Promise<unknown>[]) => Promise.all(queries),
  } as unknown as typeof database;
  const listUserUploadRecords = createUploadRecordLister(client);
    const filters={search:"پارسل",hasIssues:true};
    assert.deepEqual(await listUserUploadRecords("owner",20,10,filters),{records:[],total:27});
    const where=buildUploadWhere("owner",filters);
    assert.deepEqual(listArgs,{where,orderBy:[{createdAt:"desc"},{id:"desc"}],skip:20,take:10});
    assert.deepEqual(countArgs,{where});
});
