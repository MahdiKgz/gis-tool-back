import { FeatureCollectionLike, SliverFinding } from "./types";

export interface SliverRepairResult<T = FeatureCollectionLike> {
  geojson: T;
  removedKeys: Set<string>;
}

export const sliverFindingKey = (finding: SliverFinding): string =>
  `${finding.featureIndex}|${finding.geometryCollectionPath.join(".")}|` +
  finding.polygonPath.join(".");

export const repairSlivers = <T extends FeatureCollectionLike>(
  geojson: T,
  findings: SliverFinding[],
): SliverRepairResult<T> => {
  if (!Array.isArray(geojson.features) || findings.length === 0) {
    return { geojson, removedKeys: new Set() };
  }
  const repairableByFeature = new Map<number, SliverFinding[]>();
  for (const finding of findings) {
    if (!finding.repairable || finding.geometryCollectionPath.length > 0) {
      continue;
    }
    const featureFindings = repairableByFeature.get(finding.featureIndex) ?? [];
    featureFindings.push(finding);
    repairableByFeature.set(finding.featureIndex, featureFindings);
  }
  if (repairableByFeature.size === 0) {
    return { geojson, removedKeys: new Set() };
  }
  const removedKeys = new Set<string>();
  const features = geojson.features.flatMap((feature, featureIndex) => {
    const featureFindings = repairableByFeature.get(featureIndex);
    if (!featureFindings || !feature.geometry) return [feature];

    if (feature.geometry.type === "Polygon") {
      const finding = featureFindings.find(
        (candidate) => candidate.polygonPath.length === 0,
      );
      if (!finding) return [feature];
      removedKeys.add(sliverFindingKey(finding));
      return [];
    }

    if (
      feature.geometry.type !== "MultiPolygon" ||
      !Array.isArray(feature.geometry.coordinates)
    ) {
      return [feature];
    }
    const removableIndexes = new Map<number, SliverFinding>();
    for (const finding of featureFindings) {
      const polygonIndex = finding.polygonPath[0];
      if (polygonIndex !== undefined) removableIndexes.set(polygonIndex, finding);
    }
    const coordinates = feature.geometry.coordinates.filter(
      (_, polygonIndex) => {
        const finding = removableIndexes.get(polygonIndex);
        if (!finding) return true;
        removedKeys.add(sliverFindingKey(finding));
        return false;
      },
    );
    if (coordinates.length === 0) return [];
    return [
      {
        ...feature,
        geometry: { ...feature.geometry, coordinates },
      },
    ];
  });

  return {
    geojson: { ...geojson, features } as T,
    removedKeys,
  };
};
