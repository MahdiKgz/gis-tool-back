import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyzeGeoJson, analyzeGisFile } from "./dry-run.service";

test("returns a clean report for valid geometry without mutating it", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "point-1",
        properties: {},
        geometry: {
          type: "Point",
          coordinates: [51.4, 35.7],
        },
      },
    ],
  };
  const before = structuredClone(input);

  const report = analyzeGeoJson(input, {
    toleranceMillimeters: 25,
  });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.valid, true);
  assert.equal(report.summary.featuresScanned, 1);
  assert.equal(report.summary.checksRun, 18);
  assert.equal(report.summary.issuesFound, 0);
  assert.equal(report.summary.issueGroups, 0);
  assert.deepEqual(report.issueGroups, []);
  assert.deepEqual(input, before);
});

test("reports issue locations and auto-repair availability without repairing", () => {
  const input = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "parcel-7",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      },
    ],
  };
  const before = structuredClone(input);

  const report = analyzeGeoJson(input, {
    toleranceMillimeters: 25,
  });

  const openRing = report.issues.find(
    (issue) => issue.code === "OPEN_RING",
  );
  const duplicate = report.issues.find(
    (issue) => issue.code === "DUPLICATE_VERTEX",
  );
  assert.ok(openRing);
  assert.equal(openRing.featureIndex, 0);
  assert.equal(openRing.featureId, "parcel-7");
  assert.deepEqual(openRing.location.coordinatePath, [0]);
  assert.equal(openRing.disposition, "AutoRepairAvailable");
  assert.ok(duplicate);
  assert.deepEqual(duplicate.location.coordinatePath, [0, 2]);
  assert.deepEqual(report.affectedFeatureCollection, {
    type: "FeatureCollection",
    features: [
      {
        ...input.features[0],
        snapgisFeatureIndex: 0,
      },
    ],
  });
  assert.notEqual(
    report.affectedFeatureCollection.features[0]?.geometry,
    input.features[0]?.geometry,
  );
  assert.equal(report.checks.ringClosure?.valid, false);
  assert.deepEqual(input, before);
});

test("groups the same error type across many affected features", () => {
  const tinyPolygon = (offset: number, id: string) => ({
    type: "Feature",
    id,
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [offset, 0],
          [offset + 0.0000001, 0],
          [offset + 0.0000001, 0.0000001],
          [offset, 0.0000001],
          [offset, 0],
        ],
      ],
    },
  });
  const report = analyzeGeoJson(
    {
      type: "FeatureCollection",
      features: [
        tinyPolygon(0, "sliver-a"),
        tinyPolygon(0.01, "sliver-b"),
      ],
    },
    { toleranceMillimeters: 25 },
  );

  const group = report.issueGroups.find(
    (candidate) => candidate.code === "TINY_POLYGON",
  );
  assert.ok(group);
  assert.equal(group.issueCount, 2);
  assert.equal(group.affectedFeatureCount, 2);
  assert.deepEqual(group.affectedFeatureIndexes, [0, 1]);
  assert.deepEqual(group.affectedFeatureIds, ["sliver-a", "sliver-b"]);
  assert.equal(group.disposition, "ManualReview");
});

test("analyzing a file leaves its source bytes unchanged", async () => {
  const fixturePath = path.resolve(
    "src/test-data/geojson/geo-001-duplicate-vertices.geojson",
  );
  const before = fs.readFileSync(fixturePath);

  const report = await analyzeGisFile(
    fixturePath,
    "geo-001-duplicate-vertices.geojson",
    { toleranceMillimeters: 25 },
  );

  assert.ok(report.summary.issuesFound > 0);
  assert.deepEqual(fs.readFileSync(fixturePath), before);
});

test("stops safely after the root GeoJSON structure check fails", () => {
  const report = analyzeGeoJson(
    { type: "Polygon", coordinates: [] },
    { toleranceMillimeters: 25 },
  );

  assert.equal(report.valid, false);
  assert.equal(report.summary.checksRun, 1);
  assert.deepEqual(report.affectedFeatureCollection.features, []);
  assert.equal(report.checks.geometryTypes?.rootValid, false);
});

test("reports self-intersection before its secondary area consequences", () => {
  const report = analyzeGeoJson(
    {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 8,
          properties: { caseId: "SELF-INTERSECTION" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [51.46, 35.7],
                [51.47, 35.71],
                [51.46, 35.71],
                [51.47, 35.7],
                [51.46, 35.7],
              ],
            ],
          },
        },
      ],
    },
    { toleranceMillimeters: 30 },
  );

  const selfIntersectionIndex = report.issues.findIndex(
    (issue) => issue.code === "SELF_INTERSECTION",
  );
  const zeroAreaIndex = report.issues.findIndex(
    (issue) => issue.code === "ZERO_AREA_POLYGON",
  );
  assert.ok(selfIntersectionIndex >= 0);
  assert.ok(zeroAreaIndex > selfIntersectionIndex);
  const issue = report.issues[selfIntersectionIndex]!;
  assert.equal(issue.check, "selfIntersections");
  assert.equal(issue.featureId, 8);
  assert.deepEqual(issue.location.coordinatePath, [0, 0]);
  assert.deepEqual(issue.location.relatedCoordinatePath, [0, 2]);
  assert.deepEqual(issue.details.intersectionGeometry, {
    type: "Point",
    coordinates: [51.465, 35.705],
  });
  assert.equal(issue.disposition, "AutoRepairAvailable");
  assert.equal(report.summary.checksRun, 18);
});

test("reports gaps, slivers, undershoots, and overshoots in one dry run", async () => {
  const fixturePath = path.resolve(
    "src/test-data/geojson/dry-run-gap-sliver-line-topology.geojson",
  );
  const before = fs.readFileSync(fixturePath);
  const report = await analyzeGisFile(
    fixturePath,
    "dry-run-gap-sliver-line-topology.geojson",
    { toleranceMillimeters: 30 },
  );

  const requestedIssues = new Map(
    report.issues
      .filter((issue) =>
        [
          "POLYGON_GAP",
          "SLIVER_POLYGON",
          "LINE_UNDERSHOOT",
          "LINE_OVERSHOOT",
        ].includes(issue.code),
      )
      .map((issue) => [issue.code, issue]),
  );
  assert.deepEqual(
    [...requestedIssues.keys()].sort(),
    [
      "LINE_OVERSHOOT",
      "LINE_UNDERSHOOT",
      "POLYGON_GAP",
      "SLIVER_POLYGON",
    ],
  );
  assert.equal(
    requestedIssues.get("SLIVER_POLYGON")?.disposition,
    "AutoRepairAvailable",
  );
  assert.ok(
    ["POLYGON_GAP", "LINE_UNDERSHOOT", "LINE_OVERSHOOT"].every(
      (code) =>
        requestedIssues.get(code)?.disposition === "AutoRepairAvailable",
    ),
  );
  const gap = requestedIssues.get("POLYGON_GAP")!;
  assert.equal(gap.featureId, "gap-west");
  assert.equal(gap.relatedFeatureId, "gap-east");
  assert.equal(gap.relatedFeatureIndex, 1);
  assert.ok(gap.location.coordinatePath);
  assert.ok(gap.location.relatedCoordinatePath);
  assert.deepEqual(gap.location.relatedGeometryCollectionPath, []);

  const gapGroup = report.issueGroups.find(
    (group) => group.code === "POLYGON_GAP",
  );
  assert.ok(gapGroup);
  assert.deepEqual(gapGroup.affectedFeatureIndexes, [0, 1]);
  assert.deepEqual(gapGroup.affectedFeatureIds, ["gap-west", "gap-east"]);
  assert.deepEqual(
    report.affectedFeatureCollection.features.map(
      (feature) => feature.snapgisFeatureIndex,
    ),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.equal(report.summary.checksRun, 18);
  assert.equal(report.appliedOptions.sliverAreaThresholdM2, 0.09);
  assert.equal(report.appliedOptions.gapToleranceMeters, 0.09);
  assert.equal(report.appliedOptions.lineTopologyToleranceMeters, 0.03);
  assert.equal(report.appliedOptions.maxGapWidthToSharedBoundaryRatio, 0.1);
  assert.equal(report.appliedOptions.minGapSharedBoundaryRatio, 0.5);
  assert.equal(
    report.appliedOptions.sliverMinDominantSharedBoundaryRatio,
    0.4,
  );
  assert.equal(
    report.appliedOptions.sliverMinSharedBoundaryDominanceRatio,
    2,
  );
  assert.equal(report.appliedOptions.sliverMinAbsorptionTargetAreaRatio, 10);
  assert.equal(report.appliedOptions.strongRingSpikeMinLegToBaseRatio, 10);
  assert.deepEqual(fs.readFileSync(fixturePath), before);
});

test("applies a 50 mm issue threshold to the cadastral preview fixture", async () => {
  const fixturePath = path.resolve(
    "src/test-data/geojson/gap-healing-50mm.geojson",
  );
  const before = fs.readFileSync(fixturePath);
  const report = await analyzeGisFile(
    fixturePath,
    "cadastral-parcels-gap-threshold-test-wgs84-preview.geojson",
    { toleranceMillimeters: 50 },
  );

  const gaps = report.issues.filter((issue) => issue.code === "POLYGON_GAP");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.featureIndex, 1);
  assert.equal(gaps[0]?.relatedFeatureIndex, 2);
  assert.equal(gaps[0]?.disposition, "AutoRepairAvailable");
  assert.equal(report.appliedOptions.minimumGapWidthMeters, 0.05);
  assert.ok(report.appliedOptions.gapToleranceMeters > 0.149);
  assert.ok(report.appliedOptions.gapToleranceMeters < 0.151);
  assert.equal(report.summary.manualReviewIssues, 0);
  assert.ok(
    report.issues
      .filter((issue) => issue.code === "EXCESSIVE_COORDINATE_PRECISION")
      .every((issue) => issue.disposition === "AutoRepairAvailable"),
  );
  assert.deepEqual(fs.readFileSync(fixturePath), before);
});

test("does not advertise a gap repair that its topology guard would roll back", () => {
  const polygon = (id: string, coordinates: number[][]) => ({
    type: "Feature",
    id,
    properties: {},
    geometry: { type: "Polygon", coordinates: [coordinates] },
  });
  const input = {
    type: "FeatureCollection",
    features: [
      polygon("west", [
        [51.38, 35.68],
        [51.382, 35.68],
        [51.382, 35.682],
        [51.38, 35.682],
        [51.38, 35.68],
      ]),
      polygon("east", [
        [51.3822, 35.68],
        [51.3842, 35.68],
        [51.3842, 35.682],
        [51.3822, 35.682],
        [51.3822, 35.68],
      ]),
      polygon("blocking-road", [
        [51.38199, 35.6805],
        [51.38221, 35.6805],
        [51.38221, 35.6815],
        [51.38199, 35.6815],
        [51.38199, 35.6805],
      ]),
    ],
  };
  const before = structuredClone(input);

  const report = analyzeGeoJson(input, { toleranceMillimeters: 25 });
  const issue = report.issues.find(
    (candidate) =>
      candidate.code === "POLYGON_GAP" &&
      candidate.featureId === "west" &&
      candidate.relatedFeatureId === "east",
  );

  assert.ok(issue);
  assert.equal(issue.disposition, "ManualReview");
  assert.equal(issue.details.repairFailureReason, "WouldCreateOverlap");
  assert.deepEqual(input, before);
});

test("detects every declared cadastral topology scenario at 25 mm", async () => {
  const fixturePath = path.resolve(
    "src/test-data/geojson/cadastral-topology-errors-sample.geojson",
  );
  const before = fs.readFileSync(fixturePath);
  const report = await analyzeGisFile(
    fixturePath,
    "cadastral-topology-errors-sample.geojson",
    { toleranceMillimeters: 25 },
  );

  const expectedFeatureByCode = new Map<string, number>([
    ["POLYGON_GAP", 1],
    ["POLYGON_OVERLAP", 1],
    ["SLIVER_POLYGON", 4],
    ["SELF_INTERSECTION", 5],
    ["SPIKE", 6],
    ["INCORRECT_RING_ORIENTATION", 7],
    ["LINE_UNDERSHOOT", 8],
    ["LINE_OVERSHOOT", 9],
  ]);
  for (const [code, featureId] of expectedFeatureByCode) {
    const matching = report.issues.filter(
      (issue) =>
        issue.code === code &&
        (issue.featureId === featureId || issue.relatedFeatureId === featureId),
    );
    assert.ok(matching.length > 0, `${code} should affect feature ${featureId}`);
  }

  const expandedAutoRepairCodes = [
    "POLYGON_GAP",
    "SLIVER_POLYGON",
    "SELF_INTERSECTION",
    "SPIKE",
    "LINE_UNDERSHOOT",
    "LINE_OVERSHOOT",
  ];
  for (const code of expandedAutoRepairCodes) {
    const issue = report.issues.find((candidate) => candidate.code === code);
    assert.ok(issue);
    assert.equal(issue.disposition, "AutoRepairAvailable");
  }
  assert.equal(report.checks.overlaps?.valid, false);
  assert.equal(report.summary.checksRun, 18);
  assert.deepEqual(fs.readFileSync(fixturePath), before);
});
