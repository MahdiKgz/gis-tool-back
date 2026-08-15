import { processCoordinatePrecision } from "../processing/coordinate-precision";
import { processDuplicateVertices } from "../processing/duplicate-vertices";
import { processGeometryDimensions } from "../processing/geometry-dimensions";
import { processGeometryTypes } from "../processing/geometry-types";
import {
  computeGapToleranceMeters,
  DEFAULT_MAX_INFERRED_GAP_WIDTH_M,
  processGaps,
} from "../processing/gaps";
import { processInvalidHoles } from "../processing/invalid-holes";
import { processInvalidRings } from "../processing/invalid-rings";
import {
  DEFAULT_MAX_INFERRED_LINE_ERROR_M,
  processLineTopology,
} from "../processing/line-topology";
import { processMultipartIntegrity } from "../processing/multipart-integrity";
import { processPolygonOverlaps } from "../processing/overlaps";
import { processRingClosure } from "../processing/ring-closure";
import { processRingOrientation } from "../processing/ring-orientation";
import { processSelfIntersections } from "../processing/self-intersections";
import {
  FeatureCollectionLike,
  GeoJsonFeatureLike,
} from "../processing/shared/geojson";
import { processSpikes } from "../processing/spikes";
import {
  computeSliverAreaThresholdM2,
  DEFAULT_MIN_SLIVER_COMPACTNESS,
  processSlivers,
} from "../processing/slivers";
import { processTinyPolygons } from "../processing/tiny-polygons";
import { processZeroAreaPolygons } from "../processing/zero-area-polygons";
import { readGisFile } from "./gis-file.service";

export interface DryRunOptions {
  toleranceMillimeters: number;
  maxCoordinateDecimalPlaces?: number;
}

export interface DryRunIssue {
  check: string;
  code: string;
  featureIndex: number;
  featureId: string | number | null;
  relatedFeatureIndex: number | null;
  relatedFeatureId: string | number | null;
  geometryType: string | null;
  location: {
    geometryCollectionPath: number[];
    relatedGeometryCollectionPath: number[];
    coordinatePath: number[] | null;
    relatedCoordinatePath: number[] | null;
    polygonPath: number[] | null;
    relatedPolygonPath: number[] | null;
  };
  disposition: "AutoRepairAvailable" | "ManualReview";
  details: Record<string, unknown>;
}

export interface DryRunIssueGroup {
  groupId: string;
  check: string;
  code: string;
  issueCount: number;
  affectedFeatureCount: number;
  affectedFeatureIndexes: number[];
  affectedFeatureIds: Array<string | number>;
  geometryTypes: string[];
  disposition: "AutoRepairAvailable" | "ManualReview" | "Mixed";
}

interface ValidationReport {
  valid: boolean;
  issues: object[];
  unresolvedFeatureIndexes?: number[];
  rootValid?: boolean;
}

export interface DryRunReport {
  mode: "dry-run";
  valid: boolean;
  summary: {
    featuresScanned: number;
    checksRun: number;
    issuesFound: number;
    issueGroups: number;
    affectedFeatures: number;
    autoRepairableIssues: number;
    manualReviewIssues: number;
  };
  issueGroups: DryRunIssueGroup[];
  affectedFeatureCollection: {
    type: "FeatureCollection";
    features: Array<
      GeoJsonFeatureLike & {
        type: "Feature";
        snapgisFeatureIndex: number;
      }
    >;
  };
  appliedOptions: {
    toleranceMillimeters: number;
    tinyAreaThresholdM2: number;
    sliverAreaThresholdM2: number;
    sliverMinCompactness: number;
    gapToleranceMeters: number;
    maxInferredGapWidthMeters: number;
    lineTopologyToleranceMeters: number;
    maxInferredLineErrorMeters: number;
    spikeBaseToleranceMeters: number;
    maxCoordinateDecimalPlaces: number;
  };
  issues: DryRunIssue[];
  checks: Record<string, ValidationReport>;
}

const DEFAULT_MAX_COORDINATE_DECIMAL_PLACES = 9;

const emptyLocation = {
  geometryCollectionPath: [] as number[],
  relatedGeometryCollectionPath: [] as number[],
  coordinatePath: null,
  relatedCoordinatePath: null,
  polygonPath: null,
  relatedPolygonPath: null,
};

const numericPath = (
  issue: Record<string, unknown>,
  key: string,
): number[] | null => {
  const value = issue[key];
  return Array.isArray(value) &&
    value.every((segment) => Number.isInteger(segment))
    ? (value as number[])
    : null;
};

const normalizeIssue = (
  check: string,
  rawIssue: object,
): DryRunIssue => {
  const issue = rawIssue as Record<string, unknown>;
  const featureIndex =
    typeof issue.featureIndex === "number" ? issue.featureIndex : -1;
  const featureId =
    typeof issue.featureId === "string" ||
    typeof issue.featureId === "number"
      ? issue.featureId
      : null;
  const relatedFeatureIndex =
    typeof issue.relatedFeatureIndex === "number"
      ? issue.relatedFeatureIndex
      : null;
  const relatedFeatureId =
    typeof issue.relatedFeatureId === "string" ||
    typeof issue.relatedFeatureId === "number"
      ? issue.relatedFeatureId
      : null;
  const geometryType =
    typeof issue.geometryType === "string" ? issue.geometryType : null;
  const code = typeof issue.code === "string" ? issue.code : "UNKNOWN_ISSUE";

  return {
    check,
    code,
    featureIndex,
    featureId,
    relatedFeatureIndex,
    relatedFeatureId,
    geometryType,
    location: {
      ...emptyLocation,
      geometryCollectionPath:
        numericPath(issue, "geometryCollectionPath") ?? [],
      relatedGeometryCollectionPath:
        numericPath(issue, "relatedGeometryCollectionPath") ?? [],
      coordinatePath: numericPath(issue, "coordinatePath"),
      relatedCoordinatePath: numericPath(issue, "relatedCoordinatePath"),
      polygonPath: numericPath(issue, "polygonPath"),
      relatedPolygonPath: numericPath(issue, "relatedPolygonPath"),
    },
    disposition:
      issue.repairable === true ? "AutoRepairAvailable" : "ManualReview",
    details: { ...issue },
  };
};

const createQuarantinedView = (
  geojson: FeatureCollectionLike,
  featureIndexes: Set<number>,
): FeatureCollectionLike => ({
  ...geojson,
  features: (geojson.features ?? []).map((feature, featureIndex) =>
    featureIndexes.has(featureIndex)
      ? { ...feature, geometry: null }
      : feature,
  ),
});

const groupIssues = (issues: DryRunIssue[]): DryRunIssueGroup[] => {
  const groups = new Map<
    string,
    {
      check: string;
      code: string;
      issueCount: number;
      featureIndexes: Set<number>;
      featureIds: Set<string | number>;
      geometryTypes: Set<string>;
      dispositions: Set<DryRunIssue["disposition"]>;
    }
  >();

  for (const issue of issues) {
    const groupId = `${issue.check}:${issue.code}`;
    const group = groups.get(groupId) ?? {
      check: issue.check,
      code: issue.code,
      issueCount: 0,
      featureIndexes: new Set<number>(),
      featureIds: new Set<string | number>(),
      geometryTypes: new Set<string>(),
      dispositions: new Set<DryRunIssue["disposition"]>(),
    };
    group.issueCount++;
    if (issue.featureIndex >= 0) group.featureIndexes.add(issue.featureIndex);
    if (issue.featureId !== null) group.featureIds.add(issue.featureId);
    if (
      issue.relatedFeatureIndex !== null &&
      issue.relatedFeatureIndex >= 0
    ) {
      group.featureIndexes.add(issue.relatedFeatureIndex);
    }
    if (issue.relatedFeatureId !== null) {
      group.featureIds.add(issue.relatedFeatureId);
    }
    if (issue.geometryType !== null) group.geometryTypes.add(issue.geometryType);
    group.dispositions.add(issue.disposition);
    groups.set(groupId, group);
  }

  return [...groups.entries()].map(([groupId, group]) => {
    const dispositions = [...group.dispositions];
    return {
      groupId,
      check: group.check,
      code: group.code,
      issueCount: group.issueCount,
      affectedFeatureCount: group.featureIndexes.size,
      affectedFeatureIndexes: [...group.featureIndexes].sort(
        (first, second) => first - second,
      ),
      affectedFeatureIds: [...group.featureIds],
      geometryTypes: [...group.geometryTypes].sort(),
      disposition:
        dispositions.length === 1 ? dispositions[0]! : ("Mixed" as const),
    };
  });
};

export const analyzeGeoJson = (
  input: unknown,
  options: DryRunOptions,
): DryRunReport => {
  const maxCoordinateDecimalPlaces =
    options.maxCoordinateDecimalPlaces ??
    DEFAULT_MAX_COORDINATE_DECIMAL_PLACES;
  const toleranceMeters = options.toleranceMillimeters / 1000;
  const tinyAreaThresholdM2 = computeSliverAreaThresholdM2(toleranceMeters);
  const gapToleranceMeters = computeGapToleranceMeters(toleranceMeters);
  const geojson = input as FeatureCollectionLike;
  const checks: Record<string, ValidationReport> = {};

  const geometryTypeReport = processGeometryTypes(geojson).report;
  checks.geometryTypes = geometryTypeReport;

  if (!geometryTypeReport.rootValid) {
    return buildReport(geojson, checks, {
      toleranceMillimeters: options.toleranceMillimeters,
      tinyAreaThresholdM2,
      sliverAreaThresholdM2: tinyAreaThresholdM2,
      sliverMinCompactness: DEFAULT_MIN_SLIVER_COMPACTNESS,
      gapToleranceMeters,
      maxInferredGapWidthMeters: DEFAULT_MAX_INFERRED_GAP_WIDTH_M,
      lineTopologyToleranceMeters: toleranceMeters,
      maxInferredLineErrorMeters: DEFAULT_MAX_INFERRED_LINE_ERROR_M,
      spikeBaseToleranceMeters: toleranceMeters,
      maxCoordinateDecimalPlaces,
    });
  }

  const structurallyInvalid = new Set(
    geometryTypeReport.unresolvedFeatureIndexes,
  );
  const structurallySafe = createQuarantinedView(
    geojson,
    structurallyInvalid,
  );

  const geometryDimensionReport =
    processGeometryDimensions(structurallySafe).report;
  checks.geometryDimensions = geometryDimensionReport;
  for (const featureIndex of geometryDimensionReport.unresolvedFeatureIndexes) {
    structurallyInvalid.add(featureIndex);
  }

  const dimensionallySafe = createQuarantinedView(geojson, structurallyInvalid);
  const multipartIntegrityReport =
    processMultipartIntegrity(dimensionallySafe).report;
  checks.multipartIntegrity = multipartIntegrityReport;
  for (const featureIndex of multipartIntegrityReport.unresolvedFeatureIndexes) {
    structurallyInvalid.add(featureIndex);
  }

  const coordinatePrecisionReport = processCoordinatePrecision(
    dimensionallySafe,
    { maxDecimalPlaces: maxCoordinateDecimalPlaces },
  ).report;
  checks.coordinatePrecision = coordinatePrecisionReport;

  const topologyInput = createQuarantinedView(geojson, structurallyInvalid);
  const invalidRingReport = processInvalidRings(topologyInput, false).report;
  checks.invalidRings = invalidRingReport;
  const ringClosureReport = processRingClosure(topologyInput, false).report;
  checks.ringClosure = ringClosureReport;
  const duplicateVertexReport =
    processDuplicateVertices(topologyInput, false).report;
  checks.duplicateVertices = duplicateVertexReport;
  const lineTopologyReports = processLineTopology(
    topologyInput,
    { toleranceMeters },
    false,
  ).reports;
  checks.undershoots = lineTopologyReports.undershoots;
  checks.overshoots = lineTopologyReports.overshoots;

  const polygonUnsafe = new Set([
    ...structurallyInvalid,
    ...invalidRingReport.unresolvedFeatureIndexes,
  ]);
  const polygonInput = createQuarantinedView(geojson, polygonUnsafe);
  const selfIntersectionReport =
    processSelfIntersections(polygonInput).report;
  checks.selfIntersections = selfIntersectionReport;
  checks.ringOrientation =
    processRingOrientation(polygonInput, false).report;
  const invalidHoleReport = processInvalidHoles(
    polygonInput,
    { tinyHoleAreaM2: tinyAreaThresholdM2 },
    false,
  ).report;
  checks.invalidHoles = invalidHoleReport;
  const spikeReport = processSpikes(
    polygonInput,
    { baseToleranceMeters: toleranceMeters },
    false,
  ).report;
  checks.spikes = spikeReport;
  const zeroAreaPolygonReport = processZeroAreaPolygons(polygonInput).report;
  checks.zeroAreaPolygons = zeroAreaPolygonReport;
  checks.tinyPolygons = processTinyPolygons(polygonInput, {
    tinyPolygonAreaM2: tinyAreaThresholdM2,
  }).report;
  checks.slivers = processSlivers(polygonInput, {
    sliverAreaThresholdM2: tinyAreaThresholdM2,
    minCompactness: DEFAULT_MIN_SLIVER_COMPACTNESS,
  }).report;

  const gapUnsafe = new Set([
    ...polygonUnsafe,
    ...(selfIntersectionReport.unresolvedFeatureIndexes ?? []),
    ...(invalidHoleReport.unresolvedFeatureIndexes ?? []),
    ...(spikeReport.unresolvedFeatureIndexes ?? []),
    ...(zeroAreaPolygonReport.unresolvedFeatureIndexes ?? []),
  ]);
  const polygonRelationshipInput = createQuarantinedView(geojson, gapUnsafe);
  checks.overlaps = processPolygonOverlaps(polygonRelationshipInput).report;
  checks.gaps = processGaps(
    polygonRelationshipInput,
    { gapToleranceMeters },
  ).report;

  return buildReport(geojson, checks, {
    toleranceMillimeters: options.toleranceMillimeters,
    tinyAreaThresholdM2,
    sliverAreaThresholdM2: tinyAreaThresholdM2,
    sliverMinCompactness: DEFAULT_MIN_SLIVER_COMPACTNESS,
    gapToleranceMeters,
    maxInferredGapWidthMeters: DEFAULT_MAX_INFERRED_GAP_WIDTH_M,
    lineTopologyToleranceMeters: toleranceMeters,
    maxInferredLineErrorMeters: DEFAULT_MAX_INFERRED_LINE_ERROR_M,
    spikeBaseToleranceMeters: toleranceMeters,
    maxCoordinateDecimalPlaces,
  });
};

const buildReport = (
  geojson: FeatureCollectionLike,
  checks: Record<string, ValidationReport>,
  appliedOptions: DryRunReport["appliedOptions"],
): DryRunReport => {
  const issues = Object.entries(checks).flatMap(([check, report]) =>
    report.issues.map((issue) => normalizeIssue(check, issue)),
  );
  const issueGroups = groupIssues(issues);
  const affectedFeatures = new Set(
    issues
      .flatMap((issue) => [
        issue.featureIndex,
        issue.relatedFeatureIndex ?? -1,
      ])
      .filter((featureIndex) => featureIndex >= 0),
  );
  const autoRepairableIssues = issues.filter(
    (issue) => issue.disposition === "AutoRepairAvailable",
  ).length;
  const affectedFeatureCollection = {
    type: "FeatureCollection" as const,
    features: [...affectedFeatures]
      .sort((first, second) => first - second)
      .flatMap((featureIndex) => {
        const feature = geojson.features?.[featureIndex];
        if (
          feature === null ||
          typeof feature !== "object" ||
          Array.isArray(feature)
        ) {
          return [];
        }
        return [
          {
            ...structuredClone(feature),
            type: "Feature" as const,
            snapgisFeatureIndex: featureIndex,
          },
        ];
      }),
  };

  return {
    mode: "dry-run",
    valid: Object.values(checks).every((report) => report.valid),
    summary: {
      featuresScanned: Array.isArray(geojson.features)
        ? geojson.features.length
        : 0,
      checksRun: Object.keys(checks).length,
      issuesFound: issues.length,
      issueGroups: issueGroups.length,
      affectedFeatures: affectedFeatures.size,
      autoRepairableIssues,
      manualReviewIssues: issues.length - autoRepairableIssues,
    },
    issueGroups,
    affectedFeatureCollection,
    appliedOptions,
    issues,
    checks,
  };
};

export const analyzeGisFile = async (
  filePath: string,
  originalName: string,
  options: DryRunOptions,
): Promise<DryRunReport> =>
  analyzeGeoJson(await readGisFile(filePath, originalName), options);
